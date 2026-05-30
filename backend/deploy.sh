#!/usr/bin/env bash
# 工事カレンダーDB ワンコマンドデプロイ
# 前提:
#   - clasp インストール済 (`npm i -g @google/clasp`)
#   - 初回 `clasp login` 済
#   - Apps Script API 有効化済 (https://script.google.com/home/usersettings)
# 使い方:
#   cd backend && bash deploy.sh
# 2回目以降は --new で新規作成、それ以外は既存への push + 再デプロイ

set -e
cd "$(dirname "$0")"

# Git Bash on Windows: npm のグローバル bin を PATH に追加
if [ -d "$HOME/AppData/Roaming/npm" ]; then
  export PATH="$PATH:$HOME/AppData/Roaming/npm"
fi
# 念のためフォールバック確認
if ! command -v clasp >/dev/null 2>&1; then
  echo "❌ clasp が見つかりません。"
  echo "   インストール: npm i -g @google/clasp"
  echo "   または PATH に追加: export PATH=\"\$PATH:\$HOME/AppData/Roaming/npm\""
  exit 1
fi
echo "ℹ️  clasp: $(clasp --version)"
echo ""

# ============================================================
# 1. スプシ + Apps Script を新規作成 (初回のみ)
# ============================================================
if [ ! -f .clasp.json ]; then
  echo "📋 スプシ「工事カレンダーDB」を新規作成中..."
  clasp create --type sheets --title "工事カレンダーDB" --rootDir .
  echo "✅ 作成完了"
  echo ""
fi

# ============================================================
# 2. ローカルの .gs / .json をプッシュ
# ============================================================
echo "📤 setup.gs / api.gs / appsscript.json をプッシュ中..."
clasp push --force
echo "✅ プッシュ完了"
echo ""

# ============================================================
# 3. setupBackend() を実行 (シート初期化)
# ============================================================
echo "🔧 setupBackend を実行中 (シート初期化)..."
if clasp run setupBackend 2>/dev/null; then
  echo "✅ シート初期化完了 (events / properties / logs / members / config)"
else
  echo "⚠️ clasp run でエラー。Apps Script エディタを開いて手動で setupBackend を実行してください:"
  echo "   clasp open"
  echo ""
  echo "   実行できたら Enter キーを押して続行..."
  read -r
fi
echo ""

# ============================================================
# 4. Web App としてデプロイ
# ============================================================
echo "🚀 Web App としてデプロイ中..."
DEPLOY_OUT=$(clasp deploy --description "calendar-v$(date +%Y%m%d-%H%M)")
echo "$DEPLOY_OUT"

# デプロイIDを抽出 (フォーマット: "- AKfycb... @1 - description")
DEPLOY_ID=$(echo "$DEPLOY_OUT" | grep -oE 'AKfyc[A-Za-z0-9_-]{50,80}' | head -1)

echo ""
echo "============================================================"
echo "✅ デプロイ完了"
echo "============================================================"
if [ -n "$DEPLOY_ID" ]; then
  URL="https://script.google.com/macros/s/${DEPLOY_ID}/exec"
  echo ""
  echo "🔗 Web App URL:"
  echo "   $URL"
  echo ""
  echo "📋 次の手順:"
  echo "   1. アプリ (index.html) を開く"
  echo "   2. ヘッダーの ☁ ボタンをクリック"
  echo "   3. 上記URLを貼り付けて「保存」"
  echo "   4. ☁が緑になれば成功"
  # クリップボードにコピー (Windows/macOS)
  if command -v clip.exe >/dev/null 2>&1; then
    echo "$URL" | clip.exe
    echo ""
    echo "📋 URLをクリップボードにコピーしました"
  elif command -v pbcopy >/dev/null 2>&1; then
    echo "$URL" | pbcopy
    echo ""
    echo "📋 URLをクリップボードにコピーしました"
  fi
else
  echo ""
  echo "⚠️ デプロイIDを自動抽出できませんでした。"
  echo "   手動で確認: clasp deployments"
fi
echo ""
