/**
 * 工事カレンダーアプリ Web API
 *
 * 設置方法:
 *   1. setup.gs を実行済みのApps Scriptプロジェクトに、このファイルを「+」で追加
 *      （または既存コード.gsの末尾に追記）
 *   2. 保存
 *   3. 右上「デプロイ」→「新しいデプロイ」
 *      - 種類: ウェブアプリ
 *      - 説明: "工事カレンダーAPI v1"
 *      - 次のユーザーとして実行: 自分
 *      - アクセスできるユーザー: 全員
 *   4. デプロイ → 権限承認
 *   5. ウェブアプリURL（/exec で終わる）をコピー。クライアント側設定で使う。
 *
 * 在庫管理アプリの api.gs と完全独立。別のApps Scriptプロジェクト = ScriptPropertiesも別。
 *
 * エンドポイント:
 *   GET  /exec          → {events, properties, logs, members, config, serverTime}
 *   POST /exec (JSON)   → {action, data} で操作
 *
 * POSTアクション一覧:
 *   upsertEvent     / deleteEvent
 *   upsertProperty  / deleteProperty
 *   appendLog       / deleteLog
 *   setEventStatus  (atomic + 冪等性キー対応)
 *   setMembers      (全置換)
 *   bulkSync        (複数操作の一括実行)
 */

// 列定義は setup.gs の SHEETS と同じにしておく
const API_SHEETS = {
  events: [
    'id','date','startTime','endTime','allday','timeMode',
    'title','category','contractor','staff','participants',
    'commute','importance','color','memo',
    'comments',
    'createdBy','createdAt','updatedAt'
  ],
  properties: ['id','name','address','propertyType','contractor','note','updatedAt'],
  logs:       ['id','type','eventId','member','datetime','note','opId'],
  members:    ['name'],
  config:     ['key','value'],
};

// 数値として扱う列 (カレンダーには加算系の数値カラム無し)
const NUMERIC_KEYS = new Set([]);
// 真偽値
const BOOL_KEYS = new Set(['allday']);
// JSON配列として扱う列 (シートには JSON文字列で保存)
const JSON_ARRAY_KEYS = new Set(['participants','importance','comments']);
// 日付のみ (yyyy-MM-dd で返す)
const DATE_KEYS = new Set(['date']);
// 日時 (yyyy-MM-ddTHH:mm で返す)
const DATETIME_KEYS = new Set(['datetime','createdAt','updatedAt']);
// 時刻のみ (HH:mm で返す) — Sheetsが時刻を 1899-12-30 ベースの日付に変換するのを吸収
const TIME_KEYS = new Set(['startTime','endTime']);

// ===== エンドポイント =====

function doGet(e) {
  try {
    const data = {};
    Object.keys(API_SHEETS).forEach(name => { data[name] = readSheet_(name); });
    // config は key-value 連想配列に変換
    const cfg = {};
    (data.config || []).forEach(r => { if (r.key) cfg[r.key] = r.value; });
    data.config = cfg;
    data.serverTime = new Date().toISOString();
    return jsonResponse_(data);
  } catch (err) {
    return jsonResponse_({ error: String(err), stack: err.stack });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;
    const data = body.data;
    const result = dispatch_(action, data);
    // lastSyncAt を更新
    upsertConfig_('lastSyncAt', new Date().toISOString());
    return jsonResponse_({ ok: true, action, result });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err), stack: err.stack });
  }
}

// ===== アクションディスパッチ =====

// opId 冪等性チェック対象アクション
const IDEMPOTENT_ACTIONS = new Set(['setEventStatus']);

function dispatch_(action, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // 10秒、同時書き込み待機
  try {
    // 冪等性: 指定アクションは opId 重複時にスキップ（再送による二重適用防止）
    if (data && data.opId && IDEMPOTENT_ACTIONS.has(action)) {
      if (isOpIdSeen_(data.opId)) {
        return { skipped: true, reason: 'duplicate', opId: data.opId };
      }
    }
    let result;
    switch (action) {
      case 'upsertEvent':     result = upsertRow_('events', data); break;
      case 'deleteEvent':     result = deleteRowById_('events', data.id); break;
      case 'upsertProperty':  result = upsertRow_('properties', data); break;
      case 'deleteProperty':  result = deleteRowById_('properties', data.id); break;
      case 'appendLog':       result = appendRow_('logs', data); break;
      case 'deleteLog':       result = deleteRowById_('logs', data.id); break;
      case 'setEventStatus':  result = setEventStatus_(data.eventId, data.status); break;
      case 'setMembers':      result = setMembers_(data); break;
      case 'bulkSync':        result = bulkSync_(data); break;
      default: throw new Error('unknown action: ' + action);
    }
    if (data && data.opId && IDEMPOTENT_ACTIONS.has(action)) {
      markOpIdSeen_(data.opId);
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

// ===== 冪等性: 処理済みopIdをScriptPropertiesで管理（直近200件） =====
function isOpIdSeen_(opId){
  const seen = PropertiesService.getScriptProperties().getProperty('seenOps') || '';
  return seen.split(',').includes(opId);
}
function markOpIdSeen_(opId){
  const props = PropertiesService.getScriptProperties();
  const seen = (props.getProperty('seenOps') || '').split(',').filter(Boolean);
  seen.push(opId);
  // 直近200件のみ保持
  const trimmed = seen.slice(-200);
  props.setProperty('seenOps', trimmed.join(','));
}

// イベントステータス変更 (atomic) ※Phase2 用に予約。currentはstatus列なし → events.metaを使うなら拡張
// 現状の events シートには status 列が無いので、必要なら events.headers に追加してから使う
function setEventStatus_(eventId, newStatus){
  const sh = SpreadsheetApp.getActive().getSheetByName('events');
  if (!sh) throw new Error('events sheet not found');
  const rowIdx = findRowIndexById_(sh, eventId);
  if (rowIdx === -1) throw new Error('event not found: ' + eventId);
  const statusCol = API_SHEETS.events.indexOf('status') + 1;
  if (statusCol <= 0) throw new Error('events.status 列がありません。Phase2でevents.headersに追加してください');
  const updatedAtCol = API_SHEETS.events.indexOf('updatedAt') + 1;
  sh.getRange(rowIdx, statusCol).setValue(newStatus);
  if (updatedAtCol > 0) sh.getRange(rowIdx, updatedAtCol).setValue(new Date().toISOString());
  return { eventId, status: newStatus };
}

function bulkSync_(ops) {
  if (!Array.isArray(ops)) throw new Error('bulkSync: data must be array');
  const results = ops.map(op => {
    try { return { ok: true, action: op.action, result: dispatch_(op.action, op.data) }; }
    catch (e) { return { ok: false, action: op.action, error: String(e) }; }
  });
  return results;
}

// ===== シート読み書き =====

function readSheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const headers = API_SHEETS[name];
  const values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  return values.map(row => rowToObject_(row, headers)).filter(o => o.id || o.name || o.key);
}

function rowToObject_(row, headers) {
  const o = {};
  headers.forEach((h, i) => {
    let v = row[i];
    if (v === '' || v === null || v === undefined) {
      if (NUMERIC_KEYS.has(h)) o[h] = null;
      else if (JSON_ARRAY_KEYS.has(h)) o[h] = [];
      else if (BOOL_KEYS.has(h)) o[h] = false;
      else o[h] = '';
      return;
    }
    if (v instanceof Date) {
      const fmt = TIME_KEYS.has(h) ? 'HH:mm'
                : DATE_KEYS.has(h) ? 'yyyy-MM-dd'
                : DATETIME_KEYS.has(h) ? "yyyy-MM-dd'T'HH:mm"
                : "yyyy-MM-dd'T'HH:mm";
      v = Utilities.formatDate(v, 'Asia/Tokyo', fmt);
    }
    if (NUMERIC_KEYS.has(h)) { const n = Number(v); o[h] = isNaN(n) ? null : n; return; }
    if (BOOL_KEYS.has(h)) { o[h] = (v === true || String(v).toUpperCase() === 'TRUE'); return; }
    if (JSON_ARRAY_KEYS.has(h)) {
      const s = String(v).trim();
      if (!s) { o[h] = []; return; }
      try { o[h] = JSON.parse(s); if (!Array.isArray(o[h])) o[h] = []; }
      catch(e) { o[h] = []; }
      return;
    }
    if (DATE_KEYS.has(h)) {
      const s = String(v);
      const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
      o[h] = m ? m[1] : s;
      return;
    }
    o[h] = String(v);
  });
  return o;
}

function objectToRow_(obj, headers) {
  return headers.map(h => {
    const v = obj[h];
    if (v === undefined || v === null) return '';
    if (BOOL_KEYS.has(h)) return v ? true : false;
    if (JSON_ARRAY_KEYS.has(h)) {
      if (Array.isArray(v)) return v.length ? JSON.stringify(v) : '';
      return String(v); // 文字列なら素通し
    }
    return v;
  });
}

function findRowIndexById_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues().map(r => r[0]);
  const idx = ids.indexOf(id);
  return idx === -1 ? -1 : idx + 2; // 1-indexed row with header
}

function appendRow_(name, data) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('sheet not found: ' + name);
  const headers = API_SHEETS[name];
  if (!data.id) data.id = generateId_(name);
  const row = objectToRow_(data, headers);
  sh.appendRow(row);
  return { id: data.id };
}

function upsertRow_(name, data) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('sheet not found: ' + name);
  const headers = API_SHEETS[name];
  if (!data.id) data.id = generateId_(name);
  // updatedAt 自動付与
  if (headers.includes('updatedAt') && !data.updatedAt) {
    data.updatedAt = new Date().toISOString();
  }
  const rowIdx = findRowIndexById_(sh, data.id);
  const row = objectToRow_(data, headers);
  if (rowIdx === -1) {
    if (headers.includes('createdAt') && !data.createdAt) {
      data.createdAt = new Date().toISOString();
      // createdAt セット後、行を作り直す
      const row2 = objectToRow_(data, headers);
      sh.appendRow(row2);
    } else {
      sh.appendRow(row);
    }
    return { id: data.id, action: 'inserted' };
  }
  sh.getRange(rowIdx, 1, 1, headers.length).setValues([row]);
  return { id: data.id, action: 'updated' };
}

function deleteRowById_(name, id) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('sheet not found: ' + name);
  const rowIdx = findRowIndexById_(sh, id);
  if (rowIdx === -1) return { id, action: 'not_found' };
  sh.deleteRow(rowIdx);
  return { id, action: 'deleted' };
}

function setMembers_(names) {
  if (!Array.isArray(names)) throw new Error('setMembers: data must be array');
  const sh = SpreadsheetApp.getActive().getSheetByName('members');
  if (!sh) throw new Error('members sheet not found');
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 1).clearContent();
  if (names.length) sh.getRange(2, 1, names.length, 1).setValues(names.map(n => [n]));
  return { count: names.length };
}

function upsertConfig_(key, value) {
  const sh = SpreadsheetApp.getActive().getSheetByName('config');
  if (!sh) return;
  const last = sh.getLastRow();
  if (last >= 2) {
    const keys = sh.getRange(2, 1, last - 1, 1).getValues().map(r => r[0]);
    const idx = keys.indexOf(key);
    if (idx !== -1) { sh.getRange(idx + 2, 2).setValue(value); return; }
  }
  sh.appendRow([key, value]);
}

function generateId_(name) {
  const prefix = name === 'events' ? 'ev_'
              : name === 'properties' ? 'p_'
              : name === 'logs' ? 'l_'
              : 'x_';
  return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ===== ユーティリティ =====

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== テスト用 =====

/**
 * スクリプトエディタから実行可能。動作確認用。
 */
function testGet() {
  const result = doGet({});
  Logger.log(result.getContent().slice(0, 2000));
}

function testPost() {
  const body = { action: 'appendLog', data: {
    type: 'create', eventId: 'test_ev', member: 'テスト',
    datetime: new Date().toISOString(), note: 'test log'
  }};
  const result = doPost({ postData: { contents: JSON.stringify(body) }});
  Logger.log(result.getContent());
}
