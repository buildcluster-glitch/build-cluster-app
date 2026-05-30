#!/usr/bin/env bash
# ファイル監視 → 保存検知 → 2秒後に自動 commit + push
# 起動: bash watch.sh (Ctrl+C で停止)
set -e
cd "$(dirname "$0")"

# npm 経由でclasp/chokidar用にPATH追加 (Git Bash on Windows)
if [ -d "$HOME/AppData/Roaming/npm" ]; then
  export PATH="$PATH:$HOME/AppData/Roaming/npm"
fi

echo "============================================================"
echo "👀 ファイル監視開始 (Ctrl+C で停止)"
echo "============================================================"
echo "📂 監視対象:"
echo "   - index.html"
echo "   - backend/*.gs / *.md"
echo "   - *.sh (このスクリプト類)"
echo ""
echo "📝 動作: 変更検知 → 2秒待機 → git add + commit + push"
echo "🔗 公開URL: https://buildcluster-glitch.github.io/build-cluster-app/"
echo "============================================================"
echo ""

# chokidar-cli の存在確認 (なければ自動インストール)
if ! npx --no-install chokidar --version >/dev/null 2>&1; then
  echo "📦 chokidar-cli をインストール中... (初回のみ・1分程度)"
  npm install -g chokidar-cli
  echo "✅ インストール完了"
  echo ""
fi

# ウォッチ起動
npx chokidar \
  "index.html" \
  "backend/*.gs" \
  "backend/*.md" \
  "*.sh" \
  "*.md" \
  --initial=false \
  -d 2000 \
  -c 'bash auto-push.sh'
