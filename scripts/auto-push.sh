#!/usr/bin/env bash
# Claude Code Stop hook: after each turn, rebuild the widget ZIP (if the
# widget source changed), commit everything and push to origin/main.
# GitHub Pages then serves the new app/ files to the Zoho widget.

cd "$(dirname "$0")/.." || exit 0

# Nothing changed -> nothing to do.
[ -z "$(git status --porcelain)" ] && exit 0

# Rebuild dist zip only when widget source or manifest changed.
if git status --porcelain -- app plugin-manifest.json | grep -q .; then
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File pack.ps1 >/dev/null 2>&1
fi

git add -A
git commit -q -m "Auto-update $(date '+%Y-%m-%d %H:%M')" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" || exit 0

if out=$(GIT_TERMINAL_PROMPT=0 git push -q origin main 2>&1); then
  echo '{"systemMessage":"Auto-push: changes committed and pushed to GitHub (main)."}'
else
  msg=$(printf '%s' "$out" | tr '\n"\\' '   ' | cut -c1-300)
  echo "{\"systemMessage\":\"Auto-push FAILED: $msg\"}"
fi
exit 0
