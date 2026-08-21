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

## 2026-08-01 に入れた変更（version 4・現在の本番）

4. **`withPull`**：`doPost` の本文に `withPull:true` を入れると、書き込みの応答に
   `doGet` と同じ内容を `snapshot` として同梱する。指定が無ければ従来の応答＝旧アプリ互換。
   アプリ側は保存時の「push→pull の2往復」を1往復にした（v1.30.529）。
   GASは1回呼ぶだけで2〜3秒の固定オーバーヘッドがあるので効果が大きい。
5. **`bulkSync` のロックをバッチ全体で1回**に。従来は1件ごとに取り直していて、
   その隙間に他端末の書き込みが割り込めた（`dispatchInner_` を追加）。

## 2026-08-20 に入れた変更（version 5・現在の本番）

6. **write-through**（`wt_writethrough.gs` 新規）: 保存/削除をSupabase影DBへも送る。
   **WT_FLAG=off でデプロイ＝挙動は version 4 と同一**。カナリアは `wt-config` で遠隔操作。
   ロックの禁止事項対応＝ロック内はキューに積むだけ→解放後に送信。
7. **MAINT_FLAG**（`maint_flag.gs` 新規）: 切替当日の書き込み停止フラグ（on/gatekeeper）。wt-config は止めない。
8. サーバー側ファイル名を `コード.gs`→`setup.gs` に整理（debugSpreadsheet は setup.gs 末尾に継承）。
   appsscript.json は明示スコープ無し（自動検出）に統一。

## 2026-08-21 に入れた変更（version 7・現在の本番）

9. **gatekeeper細分化**（決定メモ2026-08-21・社長裁定(b)）: MAINT_FLAG='gatekeeper' で塞ぐのは
   **eventsドメインだけ**（upsertEvent/deleteEvent/setEventStatus/bulkSync）。properties/logs/members は
   切替後もGASに残るドメインなので素通し。`body.client==='kurasuke'` は門番素通し（見積GAS ver83と同じ識別子）。
   'on'（切替30分）は従来どおり全停止（クラ助含む）。
10. setEventStatus に「有効化時はversion採番+wt必須」の注記（部分更新の穴・現在は休眠で実害なし）。

## ロールバック

デプロイのバージョンを戻すだけで即座に元へ戻ります（URLは不変）。
version 2＝改修前 / 3＝高速化 / 4＝withPull・一括ロック / 5〜6＝write-through / **version 7＝現在(gatekeeper細分化)**。

## ⚠ curl で叩くときの罠

- **`-X POST` を付けない**（`-d` だけにする）。付けると302リダイレクト後もPOSTのままになり、
  404のHTML（3253バイト）が返ってきて「壊れた」と誤診します。
- **@HEADデプロイは匿名で叩けません**（Bearer必須）。検証は
  「版を切って**テスト用デプロイ**を作る→終わったら削除」が確実です。
- **バージョン差し替え直後は数十秒〜1分ほど404を返すことがあります**。待てば戻るので、
  慌ててロールバックしないこと。GASの所要時間は同じ条件でも2秒〜35秒とばらつきます。
