#!/usr/bin/env bash
# GitHub Pages 初回公開スクリプト
# 前提: gh auth login 済み
set -e
cd "$(dirname "$0")"

REPO_NAME="build-cluster-app"

# 1. git init (初回のみ)
if [ ! -d .git ]; then
  echo "📦 git init..."
  git init -b main
  git add .
  git commit -m "Initial: ビルドクラスタ工事管理アプリ v46"
fi

# 1.5 sw.js のキャッシュ名を index.html の版に必ず合わせる
#     ⚠据え置きだと古い実体が居座る(実際 v1.30.406 のまま何十版も放置されていた・2026-09-20)
VER=$(grep -o 'appVerChip[^<]*<span[^>]*>v[0-9.]*' index.html | grep -o 'v[0-9.]*' | head -1)
if [ -n "$VER" ]; then
  CUR=$(grep -o "build-cluster-app-v[0-9.]*" sw.js | head -1)
  if [ "$CUR" != "build-cluster-app-$VER" ]; then
    echo "🧹 sw.js のキャッシュ名を更新: $CUR → build-cluster-app-$VER"
    perl -pi -e "s/build-cluster-app-v[0-9.]+/build-cluster-app-$VER/" sw.js
  fi
else
  echo "⚠ index.html から版番号が読めませんでした(sw.js はそのまま)"
fi

# 2. GitHubリポジトリ作成 + push
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "🚀 GitHubリポジトリ作成中..."
  gh repo create "$REPO_NAME" --public --source=. --remote=origin --push
else
  echo "📤 既存リポジトリにpush中..."
  git add .
  git commit -m "Update app" || echo "(変更なし)"
  git push
fi

# 3. オーナー名取得
OWNER=$(gh api user --jq .login)
echo "✅ オーナー: $OWNER"

# 4. GitHub Pages 有効化
echo "🌐 GitHub Pages を有効化中..."
gh api -X POST "/repos/$OWNER/$REPO_NAME/pages" \
  -f "source[branch]=main" \
  -f "source[path]=/" 2>/dev/null || echo "(既に有効化済かも)"

# 5. URL表示
URL="https://$OWNER.github.io/$REPO_NAME/"
echo ""
echo "============================================================"
echo "✅ デプロイ完了"
echo "============================================================"
echo ""
echo "🔗 公開URL (1〜2分後にアクセス可能):"
echo "   $URL"
echo ""
echo "📋 スタッフへの配布手順:"
echo "   1. 上記URLを共有"
echo "   2. 各自ブラウザで開く"
echo "   3. ☁設定でクラウド同期URL貼付"
echo "   4. 👤マイ で自分の名前選択"
echo ""

# クリップボードにコピー (Windows/macOS)
if command -v clip.exe >/dev/null 2>&1; then
  echo "$URL" | clip.exe
  echo "📋 URLをクリップボードにコピーしました"
elif command -v pbcopy >/dev/null 2>&1; then
  echo "$URL" | pbcopy
  echo "📋 URLをクリップボードにコピーしました"
fi
