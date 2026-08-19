// ============================================================================
// メンテ停止フラグ + 旧GAS門番 — カレンダーGAS版 2026-08-19
// 依頼元: 台帳DBセッション(8/14切替リハーサルで「書き込み停止」が未実装と判明)
// 手本  : ~/claude/見積GAS_本番同期/maint_flag_ver82_本番同期済_2026-08-14.gs
//
// これは v1.30.562「最低バージョン関門」の限界(=旧版アプリのバックグラウンド送信までは
// 止められない、と申告した穴)への答え。アプリ側の関門とサーバ側の門番で2重の保険にする。
//
// ── 運用 ────────────────────────────────────────────────────────────
// MAINT_FLAG 無設定/'' = 通常(全アクション素通し・既定)
// MAINT_FLAG='on'         = 切替作業中: 書き込み系だけ「メンテ中」を返す(読みは生かす)
// MAINT_FLAG='gatekeeper' = 切替後の旧GAS門番: 書き込みに「アプリを更新してください」を返す
// 切替は遠隔スイッチで: {action:'wt-config', token, set:{MAINT_FLAG:'on'}}
// ⚠ wt-config自体は絶対にブロックしない(自分で解除できなくなる)
// ⚠ 未知の値は素通し(タイポで業務を止めない)
// ⚠ フラグが読めない時も素通し(fail-open)
// ============================================================================

// 書き込み系アクション(api.gs の dispatch_ が受ける全アクションから仕分け)
//   読み(doGet)は別経路なので触らない。bulkSyncは中身が書き込みなので当然止める。
var MAINT_WRITE_ACTIONS_ = [
  'upsertEvent', 'deleteEvent',
  'upsertProperty', 'deleteProperty',
  'appendLog', 'deleteLog',
  'setEventStatus', 'setMembers',
  'bulkSync'
];

// 書き込みアクションをメンテ/門番フラグで拒否。通常時はnull(素通し)
function maintGuard_(action) {
  var flag;
  try { flag = (PropertiesService.getScriptProperties().getProperty('MAINT_FLAG') || '').toLowerCase(); }
  catch (e) { return null; }                                  // fail-open(フラグが読めない時は業務を止めない)
  if (!flag || MAINT_WRITE_ACTIONS_.indexOf(action) < 0) return null;
  if (flag === 'on') {
    return jsonResponse_({ ok: false, maintenance: true,
      error: 'メンテナンス中です。切替作業が終わるまでお待ちください(数十分)。入力内容は送信し直してください' });
  }
  if (flag === 'gatekeeper') {
    return jsonResponse_({ ok: false, maintenance: true, gatekeeper: true,
      error: 'アプリが古い版です。アプリを更新(再起動/リロード)してから保存し直してください' });
  }
  return null;                                                // 未知の値は素通し
}
