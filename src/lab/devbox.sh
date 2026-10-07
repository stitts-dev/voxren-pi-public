#!/usr/bin/env bash
# Run checks on another machine over SSH instead of this one: copies the working tree (tracked and untracked files,
# never ignored ones) into a mirror there, replacing the last copy, then runs a command in it (default: the typecheck
# and the full test suite). The mirror is its own directory, never a checkout on that machine: ~/voxren-pi-mirror for
# the primary checkout, ~/voxren-pi-mirror-<directory> for a worktree.
#
#   bash src/lab/devbox.sh                          npx tsc --noEmit && bun test, over there
#   bash src/lab/devbox.sh bun test src/ui.test.ts  any command, run in the mirror
#   bash src/lab/devbox.sh --no-sync <command>      the mirror as it is: a later step of a run started there (rung 5)
#
# VOXREN_DEVBOX (required) is the SSH destination, user@host. VOXREN_DEVBOX_PREFIX goes before each command there, for a
# machine whose non-interactive SSH session has no bun on PATH (a version manager's exec, for one). VOXREN_DEVBOX_MIRROR
# names another mirror directory: one run holds a mirror at a time, so a flow of several steps (open a window, then
# drive it) that must not be replaced between them, or a second agent session, uses a mirror of its own.
set -euo pipefail
# with_timeout SECONDS COMMAND...: GNU timeout, else gtimeout (Homebrew coreutils), else a POSIX-sh kill after SECONDS
# (macOS ships neither). The fallback stops its own sleeper when the command ends, so nothing is left behind.
with_timeout() {
	secs=$1; shift
	if [ -z "${VOXREN_DEVBOX_PORTABLE_TIMEOUT:-}" ]; then # set by the test to reach the fallback where timeout exists
		if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; return; fi
		if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"; return; fi
	fi
	"$@" <&0 &
	cmd=$!
	# Once a second the timer checks the command is still running, so it ends within 1 s even if the kill below is lost,
	# and its sleeps hold no pipe open (no child of ours outlives the call by more than that second).
	( i=0; while [ $i -lt "$secs" ] && kill -0 $cmd 2>/dev/null; do sleep 1 </dev/null >/dev/null 2>&1; i=$((i+1)); done
	  kill $cmd 2>/dev/null ) &
	timer=$!
	rc=0; wait $cmd || rc=$?
	kill $timer 2>/dev/null || true
	wait $timer 2>/dev/null || true
	return $rc
}
[ -z "${VOXREN_DEVBOX_FUNCTIONS_ONLY:-}" ] || return 0 2>/dev/null || exit 0
host="${VOXREN_DEVBOX:?set VOXREN_DEVBOX to the ssh destination (user@host)}"
prefix="${VOXREN_DEVBOX_PREFIX:-}"
limit="${VOXREN_DEVBOX_TIMEOUT:-900}"
sync=1
if [ "${1:-}" = "--no-sync" ]; then sync=0; shift; fi
command="${*:-npx tsc --noEmit && bun test}"
cd "$(dirname "$0")/../.."
# A worktree (its .git is a file) gets a mirror of its own, named for its directory, so a run tests that task's change
# and nobody else's half-made one. Mirrors are not removed when a worktree is: rm -rf ~/voxren-pi-mirror-<name> there.
own=""
if [ -f .git ]; then own="-$(basename "$PWD" | tr -c 'A-Za-z0-9_.\n-' '_')"; fi
mirror="${VOXREN_DEVBOX_MIRROR:-voxren-pi-mirror$own}"
run="$prefix sh -c '$command'"
# A stalled connection fails within a minute; a client that never exits after the remote side finished (seen from Git
# Bash) is cut off at VOXREN_DEVBOX_TIMEOUT seconds instead of hanging the caller.
ssh=(with_timeout "$limit" ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$host")
# One run at a time per mirror: a second caller waits, and says so, instead of replacing the mirror under a run in
# progress (seen when two agent sessions synced at once). A lock older than the time limit was left by a run that was
# cut off, and is taken over.
lock="until mkdir ~/$mirror.lock 2>/dev/null; do
		[ -n \"\${told:-}\" ] || { echo \"waiting for ~/$mirror: another run is using it\" >&2; told=1; }
		if since=\$(cat ~/$mirror.lock/since 2>/dev/null) && [ \$((\$(date +%s) - since)) -gt $limit ]; then rm -rf ~/$mirror.lock; else sleep 2; fi
	done
	date +%s > ~/$mirror.lock/since
	trap 'rm -rf ~/$mirror.lock' EXIT"

if [ "$sync" = 0 ]; then
	"${ssh[@]}" -n "$lock
		cd ~/$mirror && $run"
	exit
fi
# Only files that exist: a tracked file deleted here is gone from the mirror too.
git ls-files -co --exclude-standard -z | while IFS= read -r -d '' file; do [ -e "$file" ] && printf '%s\0' "$file"; done |
	tar --null -T - -czf - |
	"${ssh[@]}" "set -e
		$lock
		mkdir -p ~/$mirror && cd ~/$mirror
		find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
		tar xzf -
		$prefix bun install --frozen-lockfile >/dev/null
		$run"
