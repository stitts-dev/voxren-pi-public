#!/bin/bash
# Claude Code on the web: install dependencies so `npm run typecheck` and `bun test` work.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# `bun test` is the test runner (AGENTS.md); the base image ships bun, this is the fallback.
if ! command -v bun >/dev/null 2>&1; then
  npm install -g bun
fi

# `npm ci` matches CI and AGENTS.md; `npm install` on this npm version rewrites package-lock.json and dirties the tree.
npm ci --no-audit --no-fund
