#!/usr/bin/env bash
# 1回分のコミット+プッシュ (watch.sh から呼ばれる)
set +e  # エラーで止めない
cd "$(dirname "$0")"

git add . >/dev/null 2>&1

# 変更なしならスキップ
if git diff --cached --quiet 2>/dev/null; then
  exit 0
fi

MSG="auto: $(date +%Y-%m-%d_%H:%M:%S)"
git commit -m "$MSG" >/dev/null 2>&1
PUSH_OUT=$(git push 2>&1)
if [ $? -eq 0 ]; then
  echo "✅ $(date +%H:%M:%S) pushed → $MSG"
else
  echo "❌ $(date +%H:%M:%S) push failed:"
  echo "$PUSH_OUT" | tail -3
fi
