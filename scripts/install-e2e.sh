#!/usr/bin/env bash
# Clean-machine check of the README one-liner (#126). Runs it twice as a throwaway user: a temp HOME and npm prefix,
# PATH reduced to node, npm and git. Prints the lines the issue asks for, then deletes everything it made.
#   scripts/install-e2e.sh                      the real raw URL (needs the repo public, #125)
#   INSTALL_URL=file:///x/install.mjs VOXREN_REPO=/x/origin.git scripts/install-e2e.sh    pre-public: a local copy
set -u
URL=${INSTALL_URL:-https://raw.githubusercontent.com/stitts-dev/voxren-pi-public/main/bin/install.mjs}
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/install-e2e.XXXXXX")
trap 'chmod -R u+w "$ROOT"; rm -rf "$ROOT"' EXIT
mkdir "$ROOT/tools" "$ROOT/work"
for tool in node npm npx git curl; do ln -s "$(command -v "$tool")" "$ROOT/tools/$tool" || exit 2; done
export HOME="$ROOT/home" NPM_CONFIG_PREFIX="$ROOT/prefix" NPM_CONFIG_CACHE="$ROOT/home/.npm"
export PATH="$ROOT/prefix/bin:$ROOT/tools:/usr/bin:/bin"
mkdir "$HOME"
cd "$ROOT/work" || exit 2

echo "OS: $(uname -sr)  $(command -v sw_vers >/dev/null && sw_vers -productVersion)"
echo "Node: $(node -v)  npm: $(npm -v)  git: $(git --version)"
echo "Line: curl -fsSL $URL | node"
status=0
for run in 1 2; do
	echo; echo "=== run $run ==="
	curl -fsSL "$URL" | node; code=("${PIPESTATUS[@]}")
	echo "exit: curl=${code[0]} node=${code[1]}"
	[ "${code[0]}" = 0 ] && [ "${code[1]}" = 0 ] || status=1
	echo "coach --version: $(coach --version 2>&1)"
	command -v coach >/dev/null || { echo "coach is not on PATH"; status=1; }
done
exit $status
