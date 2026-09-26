// ============================================================
// 射影(projection)の生成 — 見積GASから移植(2026-09-14・台帳DB/見積⑨)
//   正本は見積GAS `コード.gs` の convertEstimateToProperty_ / _buildWorkloadStatusForPayload_ / mdToIso_ /
//   _projectContent_ と、wt_writethrough.gs の wtProjection_。
//   **1文字も書き換えずに写しています**(改造禁止)。GAS側を直したら、ここも同じ版を写し直すこと。
//   写した版: 見積GAS version100(ver92相当)の HEAD(2026-09-14 11:46 取得)
//
//   なぜアプリに要るか: 台帳をDBへ直接保存する(anken_save)とき、射影も一緒に渡す必要があるため。
//   射影はカレンダー/工事タスクが読む「派生データ」で、これが古いと現場の予定が古いまま見える。
//
//   検証: 本番DBの既存466件について、この実装の出力と GASが作った projection を1件ずつ突合し、
//   全件一致することを確認している(tools/verify_projection.js)。移植後にGAS側を変更したら再実行すること。
// ============================================================
(function (global) {
  'use strict';
function mdToIso_(v, monthCtx) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';
  var isoM = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoM) return isoM[1] + '-' + ('0' + isoM[2]).slice(-2) + '-' + ('0' + isoM[3]).slice(-2);
  var clean = s.replace(/[（(][^）)]*[）)]/g, '').trim();         // 「6/13(月)」の曜カッコ除去
  var md = clean.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (!md) return '';
  var mo = Number(md[1]), da = Number(md[2]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return '';
  var year, ym = String(monthCtx || '').match(/(\d{4})-(\d{1,2})/);
  if (ym) {
    year = Number(ym[1]);
    var fm = Number(ym[2]);
    if (mo - fm > 6) year -= 1;        // 例: フォルダ1月 × 日付12月 → 前年
    else if (fm - mo > 6) year += 1;   // 例: フォルダ12月 × 日付1月 → 翌年
  } else {
    year = new Date().getFullYear();
  }
  return year + '-' + ('0' + mo).slice(-2) + '-' + ('0' + da).slice(-2);
}
function convertEstimateToProperty_(est, month) {
  const meta = est.meta || {};
  const ho = meta.hatchuOrder || {};
  const kojiName = (meta.kojiName || '').trim();
  const isRestoration = (kojiName === '原状回復工事');
  // 元請けの分類: 山一系 / みどり / 自社(光和) / その他
  const motoukeRaw = (meta.atena || meta.taikyo?.motouke || '').trim();
  let clientCat = 'その他';
  if (/山一/.test(motoukeRaw)) clientCat = '山一地所';
  else if (/みどり/.test(motoukeRaw)) clientCat = 'みどり不動産';
  else if (/光和|自社/.test(motoukeRaw)) clientCat = '自社工事';
  // タスク変換: lines → tasks (確定版のline + 業者発注確定スナップ反映)
  // 振り分けルール(見積アプリ isJishaLine と整合):
  //   1. l.hatchuPrintHidden=true → スキップ(諸経費・備考等、現場に関係ない行)
  //   2. l.hatchuSection='jisha' or 'gaichuu' → 手動指定を優先
  //   3. それ以外 → supplier 空 or 'ビルドクラスタ' なら自社、それ以外は外注
  const tasks = [];
  (est.lines || []).forEach(function(l) {
    // 2026-07-06: 発注書専用の追加工事行(hatchuOnly)は工事名が l.hatchuItem に入り l.item は空のことがある
    //   (発注書タブで工事名称を編集すると line.hatchuItem に保存・line.item は空のまま)。
    //   従来は `if (!l.item) return` + `name: l.item` で item しか見ず、追加工事がカレンダーp.tasksに出なかった
    //   (まどか/鈴木報告: 発注書には出るがカレンダー進捗に出ない)。発注書表示と同じ解決順(hatchuItem優先)にする。
    const effName = (l.hatchuItem != null && String(l.hatchuItem).trim() !== '') ? String(l.hatchuItem).trim() : (l.item || '');
    if (!effName) return;
    if (l.hatchuPrintHidden) return; // 印刷除外行は現場で見る必要なし
    const supplier = (l.supplier || '').trim();
    let isInhouse;
    if (l.hatchuSection === 'jisha') isInhouse = true;
    else if (l.hatchuSection === 'gaichuu') isInhouse = false;
    else isInhouse = !supplier || supplier === 'ビルドクラスタ';
    let category;
    if (l.reduced) category = 'reduced';
    else if (isInhouse) category = 'inhouse';
    else category = 'outsource';
    // 発注書専用行は発注書側の数量override(hatchuQty)を優先(見積qtyは1のまま等のため)
    const qty = (l.hatchuOnly && l.hatchuQty != null && l.hatchuQty !== '') ? (Number(l.hatchuQty) || 0) : (Number(l.qty) || 0);
    const unitPrice = Number(l.unitPrice) || 0;
    const amount = qty * unitPrice;
    const orderPrice = Number(l.orderPrice) || 0;
    const orderAmount = qty * orderPrice;
    tasks.push({
      id: 'T_' + (est.id || '').slice(-10) + '_' + tasks.length,
      name: effName, // 2026-07-06: hatchuItem優先(発注書専用の追加工事行を拾う)
      room: l.room || '',
      qty: qty,
      unit: l.unit || '',
      unitPrice: unitPrice,
      amount: amount,
      contractor: isInhouse ? '' : supplier,
      orderPrice: orderPrice,
      orderAmount: orderAmount,
      periodStart: l.hatchuPeriodStart || '',
      periodEnd: l.hatchuPeriodEnd || '',
      category: category,
      // ステータスは見積側に無いので、完了日を見て done 判定
      // 完了日が入ってる かつ 過去 → done / 未来 or 空 → todo
      status: ((ho.completeDate && new Date(ho.completeDate) < new Date()) ? 'done' : 'todo'),
      itemRef: l.itemRef || '',
      specs: l.specs || '',
      // ➕ カレンダー発「追加工事」の出所(2026-07-15)。カレンダーは extraId 有無で「＋追加」バッジを出す(v1.30.416)。
      //   射影が運ばないとカレンダーは印を知る手段が無く、登録した端末以外でバッジが出ない/localStorage消去で復元不能。
      //   通常明細は '' が入るだけ=無害(カレンダー側は st.extraId || kept?.extraId の順で読む)。
      extraId: l.extraId || '',
      addedBy: l.addedBy || '',
    });
  });
  // 修繕案件用の追加フィールド (taikyo オブジェクト由来)
  const taikyo = meta.taikyo || {};
  // カレンダー詳細表示用: クリーニング業者・鍵業者を lines から抽出(2026-05-31)
  //   業者名が空 or 'ビルドクラスタ' なら自社施工 → '弊社' を返す
  var _cleaningContractor = '';
  var _keyContractor = String(ho.keyBiz || '').trim();
  // 鍵の日付: 鍵交換日(ho.keyChangeDate)を最優先 → 無ければ鍵タスクの工期開始(hatchuPeriodStart)
  var _keyDate = String(ho.keyChangeDate || '').trim();
  (est.lines || []).forEach(function(l){
    if (!l || !l.item) return;
    var sup = String(l.supplier || '').trim();
    var nm = String(l.item || '') + ' ' + String(l.category || '');
    if (!_cleaningContractor && /クリーニング|清掃|ハウス/.test(nm)) {
      _cleaningContractor = (sup && sup !== 'ビルドクラスタ') ? sup : '弊社';
    }
    if (/鍵|カギ|シリンダー|錠/.test(nm)) {
      if (!_keyContractor) _keyContractor = (sup && sup !== 'ビルドクラスタ') ? sup : '弊社';
      if (!_keyDate && l.hatchuPeriodStart) _keyDate = String(l.hatchuPeriodStart).trim();
    }
  });
  return {
    no: est.id || '',
    estimateId: est.id || '',
    month: month,
    clientCat: clientCat,
    clientRaw: motoukeRaw,
    name: meta.bukken || '(無題)',
    room: meta.roomNo || '',
    kojiName: kojiName,
    isRestoration: isRestoration,
    orderDate: meta.koujiSijiDate || '',
    movein: ho.nyukyoDate || '',
    finalDate: ho.finalCheckDate || '',
    finalCheckDate: ho.finalCheckDate || '',             // 2026-06-13: カレンダーが読むキー名(finalDateと同値だが別名で漏れて最終確認カードが日付に立たなかった)
    finalCheckDateIso: mdToIso_(ho.finalCheckDate, month), // 2026-06-13: ISO化(M/D「6/18(月)」→YYYY-MM-DD。カレンダーの日付アンカー)
    checkDate: ho.finalCheckDate || '',                  // 2026-06-13: カレンダー最終確認カードの別名フォールバック(同値)
    originalFinalDate: ho.originalFinalCheckDate || '',  // 当初の最終確認日(スリップ表示用)
    completeDate: ho.completeDate || '',
    keyChange: ho.keyChangeDate || '',
    keyCon: ho.keyBiz || '',
    keyLeft: !!meta.kagiNokoshi,
    disinfect: ho.jokinDate || '',
    // カレンダー詳細表示用 追加フィールド(2026-05-31)
    disinfectDone:      !!(meta.jokinDone || (ho.jokinDate && !/無|なし|ナシ/.test(String(ho.jokinDate)))),  // 除菌 有/無(boolean)。「なし/無し/除菌無し」等の記入は無に倒す(2026-08-07・空欄チェックだけで7件が誤って有になっていた)
    cleaningContractor: _cleaningContractor,                             // クリーニング業者名(空=該当行なし / '弊社'=自社施工)
    keyContractor:      _keyContractor,                                  // 鍵業者名(ho.keyBiz優先→鍵タスクの業者)
    keyDate:            _keyDate,                                        // 鍵の日付(鍵交換日 ho.keyChangeDate 優先→鍵タスクの工期開始)
    vacancyDate:        (taikyo.taikyoDate || taikyo.taikyoStart || ''), // 退去(予定)日
    estimatedBy: taikyo.tachiaiPerson || meta.creator || '',  // 見積アプリ「作成者」列(getCreatorName=tachiaiPerson優先)と一致させる(2026-06-09: 201で鈴木≠山田ズレ修正)
    hatchuConfirmedAt: ho.confirmedAt || '',   // ver86: 発注確定日時(ISO)。カレンダー📊発注日/⚡事前チャンスの推定を確定値に(orderDateは埋めない)
    pic: meta.orderTantou || meta.creator || '',
    water: ho.suidoBranch || '',
    revenueExclTax: tasks.reduce(function(s,t){ return s + (t.amount || 0); }, 0),
    address: meta.shozaichi || '',
    layout: meta.taikyo?.madori || '',
    // === 発注書ヘッダ項目(発注確定の有無に関係なく原状回復案件に常時付与・カレンダー要望2026-06-05) ===
    //   見積アプリの hatchusho_data header と同名・同値。値が無ければ空文字。
    parkingExist:   ho.hasParking || taikyo.hasParking || '',  // 駐車場有無 "有"/"無"
    vacantParking:  ho.akiDrivin  || taikyo.parking    || '',  // 空き駐車場 例"5番"
    entranceKey:    ho.genkanKagi || '',                       // 玄関鍵 例"ジョイナー・417"
    entranceUnlock: ho.entryCode  || '',                       // エントランス開錠
    waterElec:      ho.suidoDenki || '',                       // 水道・電気 例"6/8〜"(既存waterはho.suidoBranch誤参照で空だった)
    disinfectDate:  ho.jokinDate  || '',                       // 除菌日(既存disinfectと同値・カレンダー用キー名)
    picTel:         ho.tantouTel  || '',                       // 担当者電話番号
    tasks: tasks,
    // === 修繕・進捗管理フィールド (PC側 progress.html と完全一致) ===
    status:         meta.status || '',
    workflowStatus: meta.workflowStatus || '',
    salesStage:     meta.salesStage || '',
    isConfirmed:    !!meta.isConfirmed,
    // 2026-06-24: パターン集約用(buildTaskSyncPayload_で同グループを集約・進捗タブと同ロジック)
    patternGroupId: meta.patternGroupId || '',
    patternLabel:   meta.patternLabel || '',
    createdAt:      est.createdAt || '',
    atenaTantou:    meta.atenaTantou || '',                       // 元請け担当(=営業担当列)
    salesPerson:    taikyo.tachiaiPerson || meta.creator || '',   // 自社担当(=連絡者列)
    requestDate:    meta.requestDate || '',
    requestDetail:     meta.requestDetail || '',       // ショート版(AI生成、20字目安)
    requestDetailFull: meta.requestDetailFull || '',   // 本文ママ(PDF/メール原文・v1.4.135〜)
    responseDate:   meta.responseDate || '',                      // 対応予定日(自由入力・M/D等の生値)
    responseDateIso: mdToIso_(meta.responseDate, month),          // 2026-06-13: ISO化(M/D「6/13」→YYYY-MM-DD。カレンダー修繕アポの日付アンカー)
    responseTime:   meta.responseTime || '',                      // 対応予定時間(v1.4.250〜・クラ助のアポ更新用)
    responseContractor: meta.responseContractor || '',            // 対応業者(修繕。例:思綺美装。カレンダー修繕予定に表示 2026-06-09)
    creatorMemo:    meta.creatorMemo || '',                       // 進捗詳細メモ
    customerName:   taikyo.contractorName || '',
    customerTel:    taikyo.contractorTel || '',
    shozaichi:      meta.shozaichi || '',                         // 住所(進捗詳細用)
    tmRepair:       meta.tmRepair || null,                        // タスクマネージャー独自フィールド
    // === ⚡簡易見積(カレンダー修繕の簡易見積連携 2026-07-15・project_kani_mitsumori_calendar) ===
    //   kaniMitsuは台帳/売上/索引で明細合計より優先される金額。kaniUpdatedAtは後勝ち判定スタンプ(書き戻しに必須)。
    kaniMitsu:      (meta.kaniMitsu != null && meta.kaniMitsu !== '') ? (Number(meta.kaniMitsu) || 0) : null,
    kaniLines:      (Array.isArray(meta.kaniLines) && meta.kaniLines.length) ? meta.kaniLines : null,
    kaniUpdatedAt:  meta.kaniUpdatedAt || '',
    kaniSetBy:      meta.kaniSetBy || '',
    // === 社内工事ボリューム (v1.4.218〜) ===
    // 発注確定時の snapshot を最優先。無ければ現在の lines から live 計算してフォールバック
    // カレンダーアプリ/タスクマネージャーで 軽/普/重/激重/無 バッジ表示用
    workloadStatus: _buildWorkloadStatusForPayload_(est),
    workVolume:     _buildWorkloadStatusForPayload_(est).level,   // 互換: ショートカット
    // === 同期用メタ ===
    updatedAt:      est.updatedAt || '',
  };
}

// === 社内工事ボリューム計算(GAS版・PC側 calcWorkloadStatus と同ロジック) ===
//   snapshot が meta.hatchuOrder.workloadStatus にあれば優先(発注確定時のスナップ)
//   無ければ lines から live 計算
function _buildWorkloadStatusForPayload_(est) {
  var meta = est && est.meta ? est.meta : {};
  var snap = meta.hatchuOrder && meta.hatchuOrder.workloadStatus;
  if (snap && snap.level) {
    return {
      level: snap.level,
      score: snap.score || 0,
      totalJishaLines: snap.totalJishaLines || 0,
      heavyItems: snap.heavyItems || [],
      mediumItems: snap.mediumItems || [],
      lightItems: snap.lightItems || [],
      stampedAt: snap.stampedAt || '',
      trigger: snap.trigger || '',
      source: 'snapshot',
    };
  }
  // live 計算
  var HEAVY = ['シール','シーリング','コーキング','大工','木工','巾木','框',
               'フローリング張替','フローリング交換','CF張替','CF交換',
               '換気扇','レンジフード','塗装','ペンキ','吹付','吹き付',
               '網戸張替','網戸交換','網戸張り替え'];
  var LIGHT = ['照明','電球','LED','シーリングライト','ペンダント'];
  var heavyItems = [], mediumItems = [], lightItems = [];
  var lines = (est && est.lines) || [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (!l || !l.item || l.reduced) continue;
    // isJishaLine 相当判定
    var isJisha;
    if (l.hatchuSection === 'jisha') isJisha = true;
    else if (l.hatchuSection === 'gaichuu') isJisha = false;
    else {
      var sup = (l.supplier || '').trim();
      isJisha = !sup || sup === 'ビルドクラスタ';
    }
    if (!isJisha) continue;
    var text = (l.category || '') + ' ' + (l.item || '') + ' ' + (l.specs || '');
    var label = [l.room || '', l.item || '', l.specs || ''].filter(function(x){return x;}).join(' ').trim();
    // 軽優先(シーリングライト等)
    var matchedLight = LIGHT.some(function(k){ return text.indexOf(k) >= 0; });
    if (matchedLight) { lightItems.push(label); continue; }
    var matchedHeavy = HEAVY.some(function(k){ return text.indexOf(k) >= 0; });
    if (matchedHeavy) heavyItems.push(label);
    else mediumItems.push(label);
  }
  var totalJisha = heavyItems.length + mediumItems.length + lightItems.length;
  var heavyCount = heavyItems.length;
  var level;
  if (totalJisha === 0) level = '無';
  else if (heavyCount === 0) level = '軽';
  else if (heavyCount <= 2) level = '普';
  else if (heavyCount <= 4) level = '重';
  else level = '激重';
  return {
    level: level,
    score: heavyCount,
    totalJishaLines: totalJisha,
    heavyItems: heavyItems,
    mediumItems: mediumItems,
    lightItems: lightItems,
    stampedAt: '',
    trigger: '',
    source: 'live',
  };
}

// ============================================================
// 初回セットアップ: Drive権限の手動付与用
// 関数選択ドロップダウンで `setupAuth` を選んで ▶実行 → 権限ダイアログ → 許可
// ============================================================
function _projectContent_(content, monthName, kojiFilter) {
  if (!content || !content.meta) return null;
  if (content.meta.isTemplate) return null;
  if (content.deleted) return null;
  const _poExists = Array.isArray(content.meta.purchaseOrders) && content.meta.purchaseOrders.length > 0;
  const _hatchuLocked = !!(content.meta.hatchuLocked || (_poExists && content.meta.isConfirmed));
  const _status = content.meta.status || '';
  const ACTIVE = ['見積作成中', '提出済', '受注（工事指示有）', '対応中', 'アポ済', '受注', '施工指示あり'];
  const _hasResponseDate = !!(content.meta.responseDate && String(content.meta.responseDate).trim());
  const _isRepairActive = (content.meta.kojiName !== '原状回復工事') &&
    (ACTIVE.includes(_status) || ['対応中', 'アポ・手配 済'].includes(content.meta.workflowStatus || '') || _hasResponseDate);
  const _jizenForceShow = !!(content.meta.hatchuOrder && content.meta.hatchuOrder.jizenForceShow === true);
  if (!_hatchuLocked && !_isRepairActive && !_jizenForceShow) return null;
  const kojiName = (content.meta.kojiName || '').trim();
  if (kojiFilter === 'restoration' && kojiName !== '原状回復工事') return null;
  if (kojiFilter === 'repair' && (kojiName === '' || kojiName === '原状回復工事')) return null;
  return convertEstimateToProperty_(content, monthName) || null;
}

  // wt_writethrough.gs の wtProjection_ と同じ(射影に driveFileId/kojiKind/patternGroupId を足す)
  function bcBuildProjection(doc, month) {
    try {
      var p = _projectContent_(doc, month || doc._driveMonth || '', 'all');
      if (!p) return null;
      p.driveFileId = p.driveFileId || doc._driveFileId || '';
      var kn = String((doc.meta && doc.meta.kojiName) || '').trim();
      p.kojiKind = (kn === '原状回復工事') ? 'restoration' : (kn === '' ? 'unknown' : 'repair');
      p.patternGroupId = p.patternGroupId || (doc.meta && doc.meta.patternGroupId) || '';
      return p;
    } catch (e) { return { __skip: true }; }
  }

  global.bcBuildProjection = bcBuildProjection;
  if (typeof module !== 'undefined' && module.exports) module.exports = { bcBuildProjection: bcBuildProjection };
})(typeof window !== 'undefined' ? window : globalThis);
