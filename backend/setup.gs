/**
 * 工事カレンダーアプリ バックエンド一発セットアップ
 *
 * 使い方:
 *   1. Google スプレッドシート「工事カレンダーDB」を新規作成
 *   2. 拡張機能 → Apps Script
 *   3. コード.gs の中身を全削除、このファイル全文をコピペ
 *   4. 保存
 *   5. 関数セレクタで `setupBackend` を選んで実行
 *   6. 権限承認ダイアログで「許可」
 *   7. 完了！
 *
 * 在庫管理DBとは完全に別のスプシ。同時稼働しても干渉しません。
 * 詳細は ./README.md 参照
 */

// ===== 設定 =====
const RESET_IF_EXISTS = false;  // true にすると既存シートも削除して作り直す（危険）

const SHEETS = {
  events: {
    headers: [
      'id','date','startTime','endTime','allday','timeMode',
      'title','category','contractor','staff','participants',
      'commute','importance','color','memo',
      'comments',
      'createdBy','createdAt','updatedAt',
      'version'   // 🔢 write-through の版番号(2026-08-19)。api.gs の API_SHEETS.events と必ず揃えること
    ],
    freezeRows: 1,
  },
  properties: {
    headers: ['id','name','address','propertyType','contractor','note','updatedAt'],
    freezeRows: 1,
  },
  logs: {
    headers: ['id','type','eventId','member','datetime','note','opId'],
    freezeRows: 1,
  },
  members: {
    headers: ['name'],
    freezeRows: 1,
  },
  config: {
    headers: ['key','value'],
    freezeRows: 1,
  },
};

// ===== シード: メンバー (8名・松尾は履歴用に含める) =====
const SEED_MEMBERS = ['鈴木悠平','大村将史','山田裕貴','木村優作','南部大我','最上登生','まどか','松尾'];

// ===== メイン関数 =====

/**
 * 初期セットアップ: 5シートを作成し、ヘッダー・シード投入
 */
function setupBackend() {
  const ss = SpreadsheetApp.getActive();

  Object.entries(SHEETS).forEach(([name, spec]) => {
    let sheet = ss.getSheetByName(name);
    if (sheet) {
      if (RESET_IF_EXISTS) {
        ss.deleteSheet(sheet);
        sheet = null;
      } else {
        Logger.log(`${name}: 既存シートあり。スキップ（RESET_IF_EXISTSをtrueにすると作り直し）`);
        return;
      }
    }
    sheet = ss.insertSheet(name);
    // ヘッダー
    sheet.getRange(1, 1, 1, spec.headers.length).setValues([spec.headers]);
    sheet.getRange(1, 1, 1, spec.headers.length)
      .setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
    sheet.setFrozenRows(spec.freezeRows || 1);
    sheet.autoResizeColumns(1, spec.headers.length);
    Logger.log(`${name}: シート作成 (${spec.headers.length}列)`);
  });

  seedMembers_();
  seedConfig_();
  applyEventsFormatting_();

  Logger.log('✅ setupBackend 完了');
  SpreadsheetApp.getUi && SpreadsheetApp.getUi().alert
    && SpreadsheetApp.getUi().alert('工事カレンダーDB のセットアップが完了しました！');
}

// ===== シードヘルパー =====

function seedMembers_() {
  const sh = SpreadsheetApp.getActive().getSheetByName('members');
  if (sh.getLastRow() > 1) { Logger.log('members: 既にデータあり'); return; }
  sh.getRange(2, 1, SEED_MEMBERS.length, 1).setValues(SEED_MEMBERS.map(m => [m]));
  Logger.log(`members: ${SEED_MEMBERS.length}行シード`);
}

function seedConfig_() {
  const sh = SpreadsheetApp.getActive().getSheetByName('config');
  if (sh.getLastRow() > 1) { Logger.log('config: 既にデータあり'); return; }
  const rows = [
    ['version', '1'],
    ['appName', '工事カレンダー'],
    ['lastSyncAt', ''],
    ['createdAt', new Date().toISOString()],
  ];
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
  Logger.log(`config: ${rows.length}行シード`);
}

// ===== 書式設定 =====

function applyEventsFormatting_() {
  const sh = SpreadsheetApp.getActive().getSheetByName('events');
  if (!sh) return;
  // 列幅調整
  sh.setColumnWidth(1, 160); // id
  sh.setColumnWidth(2, 100); // date
  sh.setColumnWidth(7, 240); // title
  sh.setColumnWidth(15, 220);// memo
  Logger.log('events: 書式設定完了');
}

// ===== ヘルスチェック =====

/**
 * 現在のシート構造を確認（任意）
 */
function checkBackend() {
  const ss = SpreadsheetApp.getActive();
  const report = [];
  Object.entries(SHEETS).forEach(([name, spec]) => {
    const sh = ss.getSheetByName(name);
    if (!sh) { report.push(`❌ ${name}: シートなし`); return; }
    const headers = sh.getRange(1, 1, 1, spec.headers.length).getValues()[0];
    const ok = spec.headers.every((h, i) => headers[i] === h);
    const rows = Math.max(0, sh.getLastRow() - 1);
    report.push(`${ok ? '✅' : '⚠️'} ${name}: ${rows}行 ${ok ? '' : '(ヘッダー不一致)'}`);
  });
  Logger.log(report.join('\n'));
}

// ===== リセット（注意） =====

/**
 * 全シートを削除して作り直す。データが消えます。
 */
function resetBackend_DANGEROUS() {
  const ui = SpreadsheetApp.getUi && SpreadsheetApp.getUi();
  if (ui) {
    const res = ui.alert('データ全消去', '全シートを削除して作り直します。続行しますか？', ui.ButtonSet.YES_NO);
    if (res !== ui.Button.YES) return;
  }
  const ss = SpreadsheetApp.getActive();
  Object.keys(SHEETS).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh) ss.deleteSheet(sh);
  });
  setupBackend();
}
