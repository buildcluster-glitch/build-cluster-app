# 工事カレンダーアプリ バックエンド (デプロイ手順)

`Desktop/在庫管理アプリ/backend/` と同じ思想で組まれた、別の Google スプシ + Apps Script Web App。
**在庫管理アプリとは完全独立**: 別ファイル・別 Apps Script プロジェクト・別 URL・別 ScriptProperties。

---

## 全体構成

```
工事カレンダーDB (スプシ)
  ├ シート events     : 予定本体
  ├ シート properties : 物件マスタ
  ├ シート logs       : 操作ログ(監査用)
  ├ シート members    : メンバー名
  └ シート config     : key-value 設定
       ↑
Apps Script (api.gs + setup.gs)
  ├ doGet  → 全データスナップショット
  ├ doPost → upsertEvent / deleteEvent / appendLog / bulkSync 等
  └ LockService + ScriptProperties で同時書き込み制御
       ↑
Web App URL (/exec)
       ↑
クライアント (Desktop/スケジュール管理アプリ/index.html)
```

---

## 🚀 自動デプロイ (clasp 使用 / 推奨)

clasp が入っていれば**ほぼワンコマンド**で完了:

```bash
cd backend
bash deploy.sh
```

これで以下を全自動:
1. スプシ「工事カレンダーDB」を新規作成
2. setup.gs + api.gs + appsscript.json をアップロード
3. setupBackend を実行 (5シート初期化)
4. Web App としてデプロイ
5. URLを表示 (Windows: クリップボードに自動コピー)

### 前提
- Node.js + clasp: `npm i -g @google/clasp`
- 1回だけ: `clasp login` (ブラウザ認証)
- 1回だけ: [Apps Script API 有効化](https://script.google.com/home/usersettings)

### 2回目以降の更新
```bash
bash deploy.sh  # 既存スプシに push + 新バージョンデプロイ
```
.clasp.json がある限り同じスプシに紐付き、URLも維持されます。

---

## 手動デプロイ (15〜20分)

### STEP 1: 新しいスプシ作成

1. https://drive.google.com/ で「+ 新規」→「Google スプレッドシート」
2. ファイル名を **「工事カレンダーDB」** に変更
3. **重要**: 在庫管理DB とは別のファイルにする。既存ファイルを使い回さないこと

### STEP 2: setup.gs を貼り付けて実行

1. 拡張機能 → Apps Script
2. 既存の `コード.gs` (中身は `function myFunction() {}` のみ) の中身を全削除
3. このリポジトリの `setup.gs` 全文をコピペ
4. **保存** (💾 / Ctrl+S)
5. ファイル名を **`setup`** に変更しておくと分かりやすい (拡張子 `.gs` は自動)
6. 関数セレクタで **`setupBackend`** を選択 → **▶ 実行**
7. 「権限を確認」ダイアログ → 自分のアカウントで承認
   - 「このアプリは確認されていません」が出たら **「詳細」→「(安全ではないページ) に移動」→「許可」**
8. 完了通知が出るか、Logger に `✅ setupBackend 完了` が出ればOK
9. スプシに戻ると **events / properties / logs / members / config** の5シートが作成されている

### STEP 3: api.gs を追加してデプロイ

1. Apps Script 画面で 左のファイル一覧の **「＋」 → 「スクリプト」**
2. ファイル名を **`api`** に変更
3. このリポジトリの `api.gs` 全文をコピペ
4. **保存** (💾)
5. 右上の **「デプロイ」 → 「新しいデプロイ」**
6. 歯車アイコン → **「ウェブアプリ」** を選択
7. 設定:
   - **説明**: `工事カレンダーAPI v1`
   - **次のユーザーとして実行**: **自分**
   - **アクセスできるユーザー**: **全員**
8. **「デプロイ」** ボタン
9. 権限承認ダイアログ → **「アクセスを承認」** → 自分のGoogleアカウントで許可
10. デプロイ完了画面に **ウェブアプリURL** が表示される:
    ```
    https://script.google.com/macros/s/XXXXXXXXXXXXXX/exec
    ```
    このURL全体をコピーしておく。

### STEP 4: 動作確認

ブラウザで上記 URL を直接開く。JSON が返ってくればOK:

```json
{
  "events": [],
  "properties": [],
  "logs": [],
  "members": [
    {"name": "鈴木悠平"},
    {"name": "大村将史"},
    ...
  ],
  "config": {
    "version": "1",
    "appName": "工事カレンダー",
    "createdAt": "2026-..."
  },
  "serverTime": "2026-..."
}
```

### STEP 5: クライアントに URL を設定

1. スケジュール管理アプリを開く
2. ⚙ 設定ボタン → 「クラウド同期 URL」欄に上記 URL を貼り付け
3. 「接続テスト」 → ✓接続OK
4. ☁ アイコンが緑に点灯すれば成功

---

## 更新の再デプロイ

`api.gs` や `setup.gs` を修正した後、変更を有効にするには:

1. **「デプロイ」 → 「デプロイを管理」**
2. 該当デプロイの ✏️ 編集アイコン
3. **「バージョン」** を「新バージョン」に変更 → **「デプロイ」**

> ⚠️ URL は変わらない (同じデプロイIDが維持される)。
> 別の「新しいデプロイ」を作ると URL が変わるので、必ず既存デプロイを「編集」すること。

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 権限承認で「このアプリは確認されていません」 | 「詳細」→「〜(安全ではないページ)に移動」→「許可」。個人開発のGASでは通常これ |
| URL を開くと「スクリプトに問題が発生しました」 | Apps Script で `testGet` を関数実行してエラーログを見る。多くは シートのヘッダー不一致か `setup.gs` 未実行 |
| JSON に `{error: "..."}` が出る | `stack` 情報を見てどの関数で落ちているか特定 |
| `{ok:false, error:"Cannot read property 'contents' of undefined"}` | GET URLを直接POST試行のエラー。正しいリクエストを送ること |
| 変更が反映されない | 「新バージョン」でのデプロイを忘れている。保存だけでは反映されない |
| 在庫管理DBに書き込まれてしまった | 別のスプシ・別のApps Scriptプロジェクトであることを確認 |

---

## セキュリティメモ

- **アクセス「全員」** = URLを知っている人なら誰でも読み書き可能
- 情報漏洩リスクは低い (URL推測困難) が、完全な公開API扱い
- 強化したい場合は、`doPost` の冒頭で共有トークン検証を追加可能

---

## データ構造詳細

### events シート

| 列名 | 型 | 例 | 備考 |
|---|---|---|---|
| id | string | `ev_lr2k1...` | 主キー (クライアントが生成) |
| date | date | `2026-06-03` | yyyy-MM-dd |
| startTime | string | `09:00` | HH:mm |
| endTime | string | `10:00` | HH:mm |
| allday | bool | true/false | 終日フラグ |
| timeMode | string | `timed`/`allday`/`anytime` | 時間モード |
| title | string | `フォーチュンヒルズ立会` | タイトル(改行可) |
| category | string | `立会` | カテゴリ |
| contractor | string | `山一` | 元請け |
| staff | string | `山田裕貴` | リーダー(主担当) |
| participants | json[] | `["鈴木悠平","大村将史"]` | 参加者配列(JSON) |
| commute | string | `直行`/`直帰`/`直行直帰`/`` | 勤怠 |
| importance | json[] | `["緊急"]` | 重要マーク配列(JSON) |
| color | string | `#a7f3d0` or `` | 色上書き(空なら担当色) |
| memo | string | | メモ(改行可) |
| createdBy | string | `山田裕貴` | 作成者 |
| createdAt | datetime | ISO8601 | 作成時刻 |
| updatedAt | datetime | ISO8601 | 最終更新時刻(自動付与) |

### properties シート

| 列名 | 型 | 備考 |
|---|---|---|
| id | string | 主キー |
| name | string | 物件名 |
| address | string | 住所 |
| propertyType | string | 種別 |
| contractor | string | 元請け |
| note | string | 備考 |
| updatedAt | datetime | 最終更新 |

### logs シート (監査用)

| 列名 | 型 | 備考 |
|---|---|---|
| id | string | 主キー |
| type | string | `create`/`update`/`delete`/`status` 等 |
| eventId | string | 対象イベントID |
| member | string | 操作者 |
| datetime | datetime | 操作時刻 |
| note | string | 操作内容 |
| opId | string | 冪等性キー |

---

## Phase 2 以降の予定

- 楽観的ロック (`updatedAt` 比較で「他の人が編集しました」エラー)
- 時間競合検出 (同メンバー同時刻の重複拒否)
- イベントステータス変更の atomic 化 (events.status 列追加)
- 一覧APIのページング (1000件超対応)

---

## 参考

- 在庫管理アプリのバックエンド: `Desktop/在庫管理アプリ/backend/`
- 実装指示書: `Desktop/工事カレンダー_同期実装指示書.md`
