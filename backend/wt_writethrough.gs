// ============================================================================
// write-through(影DBへの追随書き込み) — カレンダーGAS版 2026-08-19
// 正本設計: ~/claude/台帳DB/docs/write-through設計合意.md(改訂5まで)
// 手本    : ~/claude/見積GAS_本番同期/wt_writethrough_ver81_本番同期済_2026-08-13.gs
//           (8/13夜に本番で完全開通済み=「動いている双子」を写している)
//
// 【Script Properties(山田さんが設定・チャット/リポジトリに値を書かない)】
//   SB_URL       = https://grbqpsunbuduvvgdntzc.supabase.co
//   SB_WRITE_KEY = Legacy API keys の service_role (eyJ...のJWT・219文字)
//                  ⚠新型 sb_secret_... は使えない。GASのUAがブラウザ判定され
//                    401 "Forbidden use of secret API key in browser" になる(8/13実測)
//   WT_FLAG      = off | test | canary | on   (既定=off。無設定=off)
//   WT_TEST_IDS  = テスト専用の予定id(カンマ区切り。flag=test のとき対象を限定)
//   WT_CANARY_PCT= 10 (flag=canary のときの通過率%・既定10)
//   MAINT_FLAG   = ''(通常) | on(メンテ中) | gatekeeper(切替後の門番)  ※maintGuard_が使用
//
// 【カレンダー特有の構造】⚠見積GASと違う点(ここが実装の勘所)
//   カレンダーは dispatch_ が **バッチ全体をロックで囲む**(bulkSyncで数十件を1ロック)。
//   設計の禁止事項②「ロックを持ったままSupabaseへ送らない」を守るため、
//   ロック内では **送らずにキューへ積むだけ** にし、ロック解放後にまとめて送る。
//     dispatch_: wtQueueReset_() → 本処理(積む) → finally{releaseLock} → wtFlushQueue_()
//
// 【version採番】events シートに version 列を追加(影同期には無害=フィールド追加のみ)。
//   upsertRow_ がロック内で「既存+1」を採番する=単調増加が保証される。
//   旧版アプリが version を送ってこなくてもサーバー側で必ず付く。
// ============================================================================

// ---- フラグと対象判定 ----
function wtFlag_() {
  try { return (PropertiesService.getScriptProperties().getProperty('WT_FLAG') || 'off').toLowerCase(); }
  catch (e) { return 'off'; }
}
function wtEnabledFor_(id) {
  var flag = wtFlag_();
  if (flag === 'on') return true;
  if (flag === 'test') {
    var ids = (PropertiesService.getScriptProperties().getProperty('WT_TEST_IDS') || '').split(',');
    for (var i = 0; i < ids.length; i++) { if (ids[i].trim() === id) return true; }
    return false;
  }
  if (flag === 'canary') {
    var pct = Number(PropertiesService.getScriptProperties().getProperty('WT_CANARY_PCT') || 10);
    // idのハッシュで決定的に選ぶ(同じ予定は常に同じ側=比較可能なカナリア)
    var h = 0; for (var j = 0; j < id.length; j++) h = (h * 31 + id.charCodeAt(j)) % 1000;
    return (h % 100) < pct;
  }
  return false; // off
}

// ---- 送信(完全fail-open・タイムアウト3秒目標) ----
// 戻り値は記録用: 'applied'等のRPC応答 / 'wt_timeout' / 'wt_error:...'
function wtSend_(rpcName, payloadObj) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SB_URL');
  var key = props.getProperty('SB_WRITE_KEY');
  if (!url || !key) return 'wt_error:no-config';
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key },
    payload: JSON.stringify(payloadObj),
    muteHttpExceptions: true,
  };
  // UrlFetchApp.timeoutSecondsは実機確認事項(改訂3・8/13時点で未検証)。
  // 効かない環境でも既定360秒→fail-open構造上、遅延はこの1保存の応答が遅れるだけで
  // スプレッドシートへの本保存は既に完了している。
  try { options.timeoutSeconds = 3; } catch (e) {}
  try {
    var res = UrlFetchApp.fetch(url + '/rest/v1/rpc/' + rpcName, options);
    var code = res.getResponseCode();
    var body = String(res.getContentText() || '').replace(/^"|"$/g, '');
    if (code >= 200 && code < 300) return body;           // 'applied'等
    try { props.setProperty('WT_LAST_ERR', 'http' + code + ':' + body.slice(0, 160)); } catch (e2) {}
    return 'wt_error:http' + code + ':' + body.slice(0, 80);
  } catch (e) {
    var msg = String(e && e.message || e);
    try { PropertiesService.getScriptProperties().setProperty('WT_LAST_ERR', 'exc:' + msg.slice(0, 160)); } catch (e2) {}
    return /timed? ?out/i.test(msg) ? 'wt_timeout' : 'wt_error:' + msg.slice(0, 80);
  }
}

// ---- カウンタ(近似値・報告用。正確な突合はDB側と朝の修復件数で行う) ----
function wtCount_(kind) {
  try {
    var props = PropertiesService.getScriptProperties();
    var k = 'WT_CNT_' + kind;
    props.setProperty(k, String(Number(props.getProperty(k) || 0) + 1));
  } catch (e) {}
}

// ---- キュー(ロック内で積み、ロック解放後に送る) ----
var __WT_QUEUE = [];
function wtQueueReset_() { __WT_QUEUE = []; }
function wtQueueUpsert_(doc) {
  try { if (doc && doc.id) __WT_QUEUE.push({ kind: 'upsert', doc: doc }); } catch (e) {}
}
function wtQueueDelete_(id, lastKnownVersion) {
  try { if (id) __WT_QUEUE.push({ kind: 'delete', id: String(id), version: (Number(lastKnownVersion) || 0) + 1 }); } catch (e) {}
}
// ★ロック解放後に呼ぶこと。どんな失敗もここで握りつぶす=本保存の応答に影響させない(禁止事項①)
function wtFlushQueue_() {
  var q = __WT_QUEUE;
  __WT_QUEUE = [];
  if (!q || !q.length) return;
  var flag = wtFlag_();
  if (flag === 'off') return;                  // 既定=何もしない(デプロイしただけでは1バイトも送らない)
  for (var i = 0; i < q.length; i++) {
    var item = q[i];
    try {
      var id = (item.kind === 'upsert') ? item.doc.id : item.id;
      if (!wtEnabledFor_(id)) continue;
      var r, opId = Utilities.getUuid();       // 1操作=1つ(GAS内で再送しないので使い回し不要)
      if (item.kind === 'upsert') {
        r = wtSend_('wt_upsert_event', { p_operation_id: opId, p_doc: item.doc });
        if (r === 'applied' || r === 'already_processed') wtCount_('ok');
        else if (r === 'stale_version' || r === 'deleted') { wtCount_('ok'); Logger.log('[wt] 正常拒否 ' + id + ': ' + r); }
        else if (r === 'wt_timeout') { wtCount_('timeout'); Logger.log('[wt] timeout ' + id + ' op=' + opId); }
        else { wtCount_('error'); Logger.log('[wt] ' + id + ': ' + r); }
      } else {
        r = wtSend_('wt_delete_event', { p_operation_id: opId, p_id: item.id, p_version: item.version });
        if (r === 'delete_applied' || r === 'already_processed' || r === 'stale_version') wtCount_('ok');
        else if (r === 'wt_timeout') { wtCount_('timeout'); Logger.log('[wt] del timeout ' + item.id); }
        else { wtCount_('error'); Logger.log('[wt] del ' + item.id + ': ' + r); }
      }
    } catch (e) {
      try { wtCount_('error'); Logger.log('[wt] flush例外: ' + e.message); } catch (e2) {}
    }
  }
}

// ---- 🔢 既存シートに version 列を足す移行(冪等・デプロイ後に1回エディタから実行) ----
//   API_SHEETS.events に 'version' を足しただけでは**シートのヘッダー行が空のまま**なので、
//   ここで実際の1行目に見出しを書く。既に有れば何もしない。
//   既存行のversionは空=0扱い → 次にその予定を保存した時に 1 が入る(=全件の書き換えは不要)。
function wtEnsureVersionColumn() {
  var sh = SpreadsheetApp.getActive().getSheetByName('events');
  if (!sh) { Logger.log('events シートが見つかりません'); return; }
  var headers = API_SHEETS.events;
  var idx = headers.indexOf('version');
  if (idx < 0) { Logger.log('API_SHEETS.events に version がありません(コード側を先に直すこと)'); return; }
  var col = idx + 1;
  if (sh.getMaxColumns() < col) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());
  var cur = String(sh.getRange(1, col).getValue() || '').trim();
  if (cur === 'version') { Logger.log('既に version 列があります(何もしません)'); return; }
  if (cur !== '') { Logger.log('⚠ ' + col + '列目に別の見出し「' + cur + '」があります。手で確認してください'); return; }
  sh.getRange(1, col).setValue('version');
  Logger.log('✅ events シートに version 列(' + col + '列目)を追加しました');
}

// ---- 報告用: カウンタの読み出し(GASエディタから実行) ----
function wtReport() {
  var p = PropertiesService.getScriptProperties();
  Logger.log('WT_FLAG=' + wtFlag_() +
    ' ok=' + (p.getProperty('WT_CNT_ok') || 0) +
    ' timeout=' + (p.getProperty('WT_CNT_timeout') || 0) +
    ' error=' + (p.getProperty('WT_CNT_error') || 0) +
    ' lastErr=' + (p.getProperty('WT_LAST_ERR') || '(なし)'));
}

// ---- 疎通/異常系テスト(専用idのみ・エディタから手動実行) ----
//   ⚠E_TESTルール(8/7事故): 実予定のidは絶対に使わない。終わったらDB側の掃除も1セット。
function wtSelfTest() {
  // 8/20知見: 固定idだと残骸(前回や他セッションの検収の墓標)に当たり全拒否になって applied 経路を証明できない
  // → 実行ごとにユニークな専用id(E20990101_*形式は維持)。掃除は E20990101_%_calwt% を台帳DB側でまとめて削除
  var TID = 'E20990101_' + Utilities.formatDate(new Date(), 'GMT', 'HHmmss') + '_calwt';
  Logger.log('テストid: ' + TID);
  var doc = { id: TID, version: 1, date: '2099-01-01', startTime: '10:00', endTime: '11:00',
    title: 'カレンダーGAS-WT疎通テスト', category: '', staff: '', contractor: '',
    updatedAt: new Date().toISOString() };
  var op = Utilities.getUuid();
  Logger.log('upsert v1        : ' + wtSend_('wt_upsert_event', { p_operation_id: op, p_doc: doc }));
  Logger.log('同op再送(処理済) : ' + wtSend_('wt_upsert_event', { p_operation_id: op, p_doc: doc }));
  Logger.log('別opで同v(stale) : ' + wtSend_('wt_upsert_event', { p_operation_id: Utilities.getUuid(), p_doc: doc }));
  doc.version = 2;
  Logger.log('upsert v2        : ' + wtSend_('wt_upsert_event', { p_operation_id: Utilities.getUuid(), p_doc: doc }));
  Logger.log('delete v3        : ' + wtSend_('wt_delete_event', { p_operation_id: Utilities.getUuid(), p_id: TID, p_version: 3 }));
  doc.version = 4;
  Logger.log('削除後upsert(deleted期待): ' + wtSend_('wt_upsert_event', { p_operation_id: Utilities.getUuid(), p_doc: doc }));
  Logger.log('→ テスト後は ' + TID + ' をDBから掃除すること(台帳DB側で E20990101_%_calwt% を一括削除でも可)');
}

// ---- ⏱ timeoutSeconds が本当に効くかの実測(改訂3の宿題・エディタから手動実行) ----
//   10秒待つエンドポイントへ3秒指定で投げ、3秒台で例外になれば「効いている」。
function wtTimeoutProbe() {
  // 8/20実測: httpbinが過負荷時は待たずに即エラー応答を返し「完走0.2秒」で判定不能になる
  // → 応答コードを出す+複数の遅延サーバーで再測定。どれも待たせられなければ判定保留(カナリアの実カウンタで観察)
  var urls = ['https://httpstat.us/200?sleep=10000', 'https://httpbin.org/delay/10', 'https://deelay.me/10000/https://example.com'];
  for (var i = 0; i < urls.length; i++) {
    var t0 = Date.now();
    var opt = { method: 'get', muteHttpExceptions: true };
    try { opt.timeoutSeconds = 3; } catch (e) {}
    var msg = '';
    try { var res = UrlFetchApp.fetch(urls[i], opt); msg = '完走 HTTP' + res.getResponseCode(); }
    catch (e) { msg = '例外: ' + String(e && e.message || e); }
    var sec = (Date.now() - t0) / 1000;
    Logger.log(urls[i] + ' → 経過 ' + sec.toFixed(1) + '秒 / ' + msg);
    if (sec > 5) { Logger.log('→ 判定: timeoutSecondsは【効いていない】(10秒近く待った)。fail-open構造なので実害なし=遅いサーバー時に応答が延びるだけ'); return; }
    if (sec >= 2 && sec <= 5) { Logger.log('→ 判定: timeoutSecondsは【有効】(3秒前後で打ち切り)'); return; }
    // 2秒未満で返った=遅延サーバーが実際には待たせていない(過負荷等)→次の候補で再測定
  }
  Logger.log('→ どの遅延サーバーも待たせられず判定不能。カナリア初日にwt-configのcounters(ok/timeout)で観察に切り替え');
}

// ---- 🔧 遠隔スイッチ: フラグだけをtoken保護で読み書き(カナリアの上げ下げを手作業にしない) ----
//   ホワイトリスト方式=鍵(SB_WRITE_KEY等)は対象外。読み出しも値は返さず「設定済みか」だけ。
//   ⚠maintGuard_ はこのアクションを絶対にブロックしない(自分で解除できなくなる事故防止)
var WT_CONFIG_ALLOW_ = ['WT_FLAG', 'WT_TEST_IDS', 'WT_CANARY_PCT', 'MAINT_FLAG'];
function wtConfig_(body) {
  var props = PropertiesService.getScriptProperties();
  var out = {};
  if (body && body.set && typeof body.set === 'object') {
    Object.keys(body.set).forEach(function (k) {
      if (WT_CONFIG_ALLOW_.indexOf(k) < 0) return;         // 許可キー以外は黙って無視
      var v = String(body.set[k] == null ? '' : body.set[k]);
      if (v === '') props.deleteProperty(k); else props.setProperty(k, v);
    });
  }
  WT_CONFIG_ALLOW_.forEach(function (k) { out[k] = props.getProperty(k) || ''; });
  out.hasKey = !!props.getProperty('SB_WRITE_KEY');         // 値は返さない(設定済みかだけ)
  out.hasUrl = !!props.getProperty('SB_URL');
  out.counters = {
    ok: Number(props.getProperty('WT_CNT_ok') || 0),
    timeout: Number(props.getProperty('WT_CNT_timeout') || 0),
    error: Number(props.getProperty('WT_CNT_error') || 0),
    lastErr: props.getProperty('WT_LAST_ERR') || ''
  };
  return out;
}
