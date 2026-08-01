# 本番GASの所在（2026-08-01 確定）

`.clasp.json` は git管理外なので、**この文書が本番の所在の正本**です。

| | 値 |
|---|---|
| スクリプト名 | 工事カレンダーDB API |
| scriptId | `11YFp4XxVOkY_1OrHVhOXPi8yyziRhlOY87fr5bd6dLUFzCNfMmLqxNf5` |
| バインド先スプシ | `1xpwjwOPSQsj9G3hZQfAwGsIUDreO6MQc8pDr7eEkKQs`（工事カレンダーDB） |
| 本番デプロイID | `AKfycbwNQiRUQe7wpgGV_XpawCbr8mmMD7J-e9owFPx_O9kgyZZ_R3eKbnBftHvk8vSppYM` |
| エディタ | https://script.google.com/home/projects/11YFp4XxVOkY_1OrHVhOXPi8yyziRhlOY87fr5bd6dLUFzCNfMmLqxNf5/edit |
| オーナー | yamada.kowa@gmail.com |

## ⚠ 2026-08-01 まで `.clasp.json` は**別物**を指していました

2026-06-03 に本番スクリプトが作り直された（22:17 JST）のに `.clasp.json` が
旧プロジェクト（`1RkgMfug…` / スプシ `1DTsJajk…`・2026-05-30製・**中身は空**）を
指したまま Mac移行フォルダにも配られていました。

**症状**：`.clasp.json` のデプロイを叩くと `{"events":[],...}` が返る＝
「直したのに本番に反映されない」。今回この取り違えを解消済み。

**本番デプロイIDから scriptId を割り出す方法**（また迷子になったとき）:

```bash
curl -si "https://script.google.com/macros/s/<デプロイID>/dev" | grep -i location
```

→ リダイレクト先の `lib=` が旧プロジェクトキー。それを
`https://script.google.com/macros/d/<lib値>/edit` に入れて `-si` で叩くと、
`location:` に `home/projects/<scriptId>/edit` が出ます。

## ⚠ ローカルとサーバーの差分（把握済み）

| ファイル | 状況 |
|---|---|
| `api.gs` | **2026-08-01 に本番＝ローカルへ揃えた**（下記 v3 の内容） |
| `setup.gs` | サーバー側の名前は `コード.gs`。末尾に `debugSpreadsheet()` が増えているだけ |

かつてローカルの `api.gs` にだけ `TIME_KEYS`（`startTime` を `10:00` 形式で返す）が
入っていましたが、**本番には一度も出ていません**。アプリ側が
`"1899-12-30T10:00" → "10:00"` を自前で正規化している（index.html 参照）ので実害はなく、
今回は**本番の挙動を変えない**ことを優先して取り込んでいません。

## 2026-08-01 に入れた変更（version 3）

1. **`Utilities.formatDate` の撤去**（`fmtDateOnly_` / `fmtDateTime_` に置換）
   1行あたり3回×数百行で数秒かかっていた。応答は**1バイトも変わらない**ことを実測で確認済み。
   → 本番 GET が **8〜12秒 → 3.1〜3.6秒**
2. **窓GET**：`?from=YYYY-MM-DD&to=YYYY-MM-DD` で `events` を期間で絞る。
   **無指定なら従来どおり全件**（旧アプリと完全互換）。絞ったときだけ応答に
   `window:{from,to}` が入るので、アプリ側は「絞られた応答」だと判別できる。
   ※ **アプリ側はまだ使っていません**（理由は下）
3. `?probe=1` で各シートの読み取りミリ秒を返す（調査用）

### 窓GETをアプリでまだ使っていない理由

実測（2026-08-01・予定369件）：全件 205KB / 窓(前1〜先3ヶ月) 143KB。
**秒数はどちらも3秒台で差が出ない**（残りはGASの起動＋往復のオーバーヘッド）。
一方で「窓の外の予定をアプリが消しにいく」prune事故のリスクがある
（過去2回発生：カテゴリ事務の消失／差分同期のprune）。
**帯域30%のために消失リスクを取る場面ではない**と判断し、サーバー側だけ用意して寝かせています。

発動条件（メモリの三層設計と同じ）＝**予定1,500件超 または 同期500KB/5秒超**。
そこに来たらアプリ側を窓要求に切り替える。

## ロールバック

デプロイのバージョンを 2 に戻すだけで即座に元へ戻ります（URLは不変）。
