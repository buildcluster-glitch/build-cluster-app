// ============================================================================
// 🪞 丸ごと写し(予備線) — DB(calendar_events) → events シートを **1時間ごとに全件写す**
//    2026-09-16 ★山田決定。設計の正本はこのコメント。
//
// 【なぜ要るのか】
//   予定の直結(アプリ→DB)を始めると、直結の人が保存した予定は **シートに入らない**。
//   シートは「DBが落ちた日の予備線」なので、直結の人が増えるほど予備線が欠けていく。
//
// 【なぜ"丸ごと"なのか】⚠1件ずつ写す方式は採らない
//   1件ずつ(差分)は「1件取りこぼすと静かに壊れる」型。今週ずっと踏んでいる形そのもの。
//   丸ごとなら取りこぼしが構造的に起きず、**過去のズレも毎時間ひとりでに直る**。
//
// 【絶対に守ること】
//   ① version列には **`source_version` をそのまま** 入れる(シート側で振り直さない)。
//      振り直すとGAS経路の保存が max(シートの版,DBの版)+1 を狂わせ stale_version を撒く。
//      ⚠**`doc.version` を使ってはいけない**(2026-09-16 台帳DB回答)。docは「書き手が送ってきた中身」で
//        更新前の版が1つ古いまま残ることがある(実データで source_version > doc.version が82件・逆は0件)。
//        **`cal_load_version` が返しているのも `source_version`** = システムが版として使っているのはこちら。
//      ⚠**null は空のまま**(0に丸めない=0は「新規」という別の意味)。切替前の初期投入503件は版なしが正しい。
//        doc.versionだけ有る過渡期の28件も、cal_load_versionがnullを返す以上「版なし」に揃える。
//      なお採番側(upsertRow_)は cal_load_version でDBの版を直接見るので、
//      ここが空(旧い予定)でも max(シートの版, DBの版)+1 で必ず前へ進む=安全側。
//   ② **0件・極端に少ない応答では書かない**(全消し防止・v1.30.492の教訓)。
//      HTTPエラー/件数不一致/ロックが取れない、も同じく「書かない」。
//   ③ 遠隔スイッチ MIRROR_FLAG で止められる(既定=off=1バイトも動かない)。
//   ④ 何をしたかは Script Properties に必ず残す(wt-config で遠隔から読める)。
//
// 【運用】
//   MIRROR_FLAG = off(既定・何もしない) | dry(読んで報告するだけ・書かない) | on(写す)
//   トリガー    = calMirrorInstallTrigger() をエディタから1回実行(1時間ごと)
//   様子見      = {"action":"wt-config"} の応答 mirror.last
// ============================================================================

var MIRROR_PAGE_        = 1000;   // PostgREST の1ページ
var MIRROR_MIN_ROWS_    = 50;     // これ未満の応答は無条件で異常扱い(書かない)
var MIRROR_MIN_RATIO_   = 0.8;    // 今のシート件数のこの割合を下回る応答では書かない
var MIRROR_LOCK_MS_     = 30000;  // 保存と衝突しないようロックを待つ時間

function mirrorFlag_() {
  try { return (PropertiesService.getScriptProperties().getProperty('MIRROR_FLAG') || 'off').toLowerCase(); }
  catch (e) { return 'off'; }
}

// ---- トリガーから呼ばれる入口 ----
function calMirrorHourly() {
  var flag = mirrorFlag_();
  if (flag !== 'on' && flag !== 'dry') return;              // 既定=何もしない
  // 切替作業中(メンテ)は触らない: 人が手でDBやシートを動かしている最中に上書きしない
  try {
    var mf = (PropertiesService.getScriptProperties().getProperty('MAINT_FLAG') || '').toLowerCase();
    if (mf === 'on') { mirrorNote_({ ok: false, skipped: 'maint' }); return; }
  } catch (e) {}
  var r = calMirrorRun_(flag === 'dry');
  mirrorNote_(r);
}

// ---- 手動実行(エディタから) ----
function calMirrorDryRun() { var r = calMirrorRun_(true);  mirrorNote_(r); Logger.log(JSON.stringify(r, null, 2)); return r; }
function calMirrorRunNow() { var r = calMirrorRun_(false); mirrorNote_(r); Logger.log(JSON.stringify(r, null, 2)); return r; }

// ============================================================================
// 本体
// ============================================================================
function calMirrorRun_(dryRun) {
  var t0 = Date.now();
  var got = mirrorFetchAllFromDb_();
  if (!got.ok) return { ok: false, dry: !!dryRun, reason: got.reason, ms: Date.now() - t0 };

  // DBの行 → シートに書く形(doc + DBの版)
  var docs = [], bad = 0;
  for (var i = 0; i < got.rows.length; i++) {
    var r = got.rows[i];
    var d = r && r.doc;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
    if (!d || !d.id) { bad++; continue; }
    // ①版は source_version をそのまま(シート側で振り直さない・docの版は使わない)。
    //   入っていない予定(切替前の初期投入など)は**空のまま**。0に丸めない。
    var v = Number(r.source_version);
    d.version = (r.source_version != null && isFinite(v) && v > 0) ? v : '';
    docs.push(d);
  }

  var sheetIds = mirrorSheetIds_();
  var cur = sheetIds.length;
  var rep = {
    ok: true, dry: !!dryRun, at: new Date().toISOString(),
    db: docs.length, sheet: cur, badDoc: bad, total: got.total
  };

  // ②書かない条件(全消し防止)
  if (docs.length === 0)                     return mirrorRefuse_(rep, 'db=0件', t0);
  if (docs.length < MIRROR_MIN_ROWS_)        return mirrorRefuse_(rep, 'db=' + docs.length + '件(下限' + MIRROR_MIN_ROWS_ + ')', t0);
  if (cur > 0 && docs.length < cur * MIRROR_MIN_RATIO_)
    return mirrorRefuse_(rep, 'db=' + docs.length + '件 < シート' + cur + '件の' + Math.round(MIRROR_MIN_RATIO_ * 100) + '%', t0);

  // 差分の報告(消える予定=シートにだけ有ってDBに無いid。ここが多い時は人が見て判断する)
  var dbSet = {}; for (var j = 0; j < docs.length; j++) dbSet[String(docs[j].id)] = 1;
  var onlyInSheet = [];
  for (var k = 0; k < sheetIds.length; k++) if (!dbSet[String(sheetIds[k])]) onlyInSheet.push(String(sheetIds[k]));
  var shSet = {}; for (var m = 0; m < sheetIds.length; m++) shSet[String(sheetIds[m])] = 1;
  var onlyInDb = 0;
  for (var n = 0; n < docs.length; n++) if (!shSet[String(docs[n].id)]) onlyInDb++;
  rep.onlyInSheet = onlyInSheet.length;
  rep.onlyInSheetIds = onlyInSheet.slice(0, 8);
  rep.onlyInDb = onlyInDb;

  if (dryRun) { rep.ms = Date.now() - t0; return rep; }

  var w = mirrorWriteSheet_(docs);
  if (!w.ok) return mirrorRefuse_(rep, w.reason, t0);
  rep.wrote = w.wrote;
  rep.ms = Date.now() - t0;
  return rep;
}

function mirrorRefuse_(rep, why, t0) {
  rep.ok = false; rep.refused = why; rep.ms = Date.now() - t0;
  try { Logger.log('[mirror] 書きませんでした: ' + why + ' ' + JSON.stringify(rep)); } catch (e) {}
  return rep;
}

// ---- DBから全件(ページング・総件数の照合つき) ----
function mirrorFetchAllFromDb_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SB_URL'), key = props.getProperty('SB_WRITE_KEY');
  if (!url || !key) return { ok: false, reason: 'no-config' };
  var base = url + '/rest/v1/calendar_events?select=id,source_version,doc&is_deleted=eq.false&order=id.asc';
  var all = [], total = null, from = 0;
  while (true) {
    var res;
    try {
      res = UrlFetchApp.fetch(base, {
        method: 'get',
        headers: {
          'apikey': key, 'Authorization': 'Bearer ' + key,
          'Range': from + '-' + (from + MIRROR_PAGE_ - 1), 'Range-Unit': 'items',
          'Prefer': 'count=exact', 'Accept': 'application/json'
        },
        muteHttpExceptions: true, timeoutSeconds: 60
      });
    } catch (e) { return { ok: false, reason: 'exception:' + String(e && e.message || e).slice(0, 80) }; }
    var code = res.getResponseCode();
    if (code !== 200 && code !== 206) return { ok: false, reason: 'http' + code + ':' + String(res.getContentText() || '').slice(0, 300) };
    var cr = mirrorHeader_(res, 'content-range');
    var mm = String(cr || '').match(/\/(\d+|\*)\s*$/);
    if (mm && mm[1] !== '*') total = parseInt(mm[1], 10);
    var rows;
    try { rows = JSON.parse(res.getContentText()); } catch (e) { return { ok: false, reason: 'shape' }; }
    if (!Object.prototype.toString.call(rows).match(/Array/)) return { ok: false, reason: 'shape' };
    for (var i = 0; i < rows.length; i++) all.push(rows[i]);
    from += MIRROR_PAGE_;
    if (rows.length < MIRROR_PAGE_) break;
    if (total != null && all.length >= total) break;
    if (from > 50000) return { ok: false, reason: 'runaway' };
  }
  // 黙って切り詰められた応答を書かない(過去2回の消失事故と同じ絵)
  if (total != null && all.length !== total) return { ok: false, reason: 'count-mismatch:' + all.length + '/' + total };
  return { ok: true, rows: all, total: (total != null ? total : all.length) };
}

function mirrorHeader_(res, name) {
  try {
    var h = res.getHeaders() || {};
    var keys = Object.keys(h);
    for (var i = 0; i < keys.length; i++) if (String(keys[i]).toLowerCase() === name) return h[keys[i]];
  } catch (e) {}
  return '';
}

// ---- 今シートに居るid ----
function mirrorSheetIds_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('events');
  if (!sh) return [];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) { var v = String(vals[i][0] || '').trim(); if (v) out.push(v); }
  return out;
}

// ---- 全書き換え(ロックの中で一気に) ----
function mirrorWriteSheet_(docs) {
  var sh = SpreadsheetApp.getActive().getSheetByName('events');
  if (!sh) return { ok: false, reason: 'no-sheet' };
  var headers = API_SHEETS.events;
  var values = [];
  for (var i = 0; i < docs.length; i++) values.push(objectToRow_(docs[i], headers));

  var lock = LockService.getScriptLock();
  // ⚠保存(dispatch_)と同じロック。取れなければ**書かない**(次の1時間で写せばよい)
  if (!lock.tryLock(MIRROR_LOCK_MS_)) return { ok: false, reason: 'lock-busy' };
  try {
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    var need = values.length + 1;
    if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
    if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    if (values.length) sh.getRange(2, 1, values.length, headers.length).setValues(values);
    var surplus = lastRow - 1 - values.length;
    if (surplus > 0) sh.deleteRows(2 + values.length, surplus);
    if (lastCol > headers.length && values.length) sh.getRange(2, headers.length + 1, values.length, lastCol - headers.length).clearContent();
    SpreadsheetApp.flush();
  } catch (e) {
    return { ok: false, reason: 'write:' + String(e && e.message || e).slice(0, 80) };
  } finally {
    lock.releaseLock();
  }
  return { ok: true, wrote: values.length };
}

// ---- 記録(遠隔から読む) ----
function mirrorNote_(rep) {
  try {
    var p = PropertiesService.getScriptProperties();
    p.setProperty('MIRROR_LAST', JSON.stringify(rep).slice(0, 1500));
    p.setProperty('MIRROR_LAST_AT', new Date().toISOString());
    if (rep && rep.ok && !rep.dry) p.setProperty('MIRROR_LAST_OK_AT', new Date().toISOString());
  } catch (e) {}
}

// ---- トリガーの入れ方(⚠コードからは作らない) ----
//   このGASの appsscript.json は oauthScopes を**明示宣言**している(spreadsheets.currentonly /
//   script.container.ui / script.external_request)。ScriptApp.newTrigger を使うには
//   script.scriptapp を足す必要があり、**スコープを増やすとWebアプリが再承認待ちになって
//   8台全部が繋がらなくなる**。なのでトリガーは**エディタのUIから**入れること:
//     エディタ左の ⏰トリガー → 「トリガーを追加」
//       実行する関数        : calMirrorHourly
//       イベントのソース    : 時間主導型
//       時間ベースのトリガー: 時間ベースのタイマー → 1時間おき
//   入れても MIRROR_FLAG=off の間は何もしない(空振りするだけ)。
