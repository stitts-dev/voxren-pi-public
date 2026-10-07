#!/usr/bin/env bash
# Rebuild an integration worktree the way AGENTS.md rule 8 defines dev: origin/main plus every open pull request that
# merges cleanly, lowest number first, drafts included, checks pending or not. A pull request that conflicts is left out
# and named with its files and with what it conflicts with (main itself, or a pull request already in), so its session
# knows whether to rebase. One recipe for every machine and every loop (docs/loops.md): the Windows dev feeds the
# player's coach, the Mac dev is the merge gate, the QA loop's worktree is scored.
#
#   just dev                            .claude/worktrees/dev
#   just dev --worktree qa              another worktree by the same recipe (created, detached, when missing)
#   DEV_SKIP="167 213@<sha>" just dev   leave pull requests out: a bare number always, number@sha only while its head is that commit
#   DEV_FORCE=1 just dev                rebuild even when main and every head are where the last rebuild left them
#
# Prints one line per pull request (in, left out, skipped), "dependencies changed" when package-lock.json moved (run
# npm run setup:worktree there before any suite), and last one of: "<name>: no change (<sha>)", "<name>: same content as
# before (<sha>); no new suite run needed", "<name> rebuilt: <sha>, <diffstat>". The suite run on the result is the
# gate, not this script: it exits non-zero only when it cannot build at all.
set -u
name=dev
while [ $# -gt 0 ]; do
	case "$1" in
		--worktree) name=$2; shift 2 ;;
		*) echo "unknown argument: $1 (usage: dev-rebuild.sh [--worktree <name>])" >&2; exit 2 ;;
	esac
done
# The primary checkout, from wherever this runs: the common git dir is <primary>/.git for every worktree of it.
root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)") || exit 1
dev=$root/.claude/worktrees/$name
cd "$root" || exit 1
git fetch origin -q --prune || { echo "$name: fetch failed; not rebuilt" >&2; exit 1; }
if [ ! -f "$dev/.git" ]; then
	git worktree add -q --detach "$dev" origin/main || { echo "$name: cannot create the worktree at $dev" >&2; exit 1; }
	echo "$name: worktree created at $dev (detached at origin/main); run npm run setup:worktree there before any suite"
fi
# The last rebuild's inputs, kept in the worktree's own git dir so a reset never touches it.
state=$(git -C "$dev" rev-parse --path-format=absolute --git-dir)/dev-rebuild.key
skip=" ${DEV_SKIP:-} "
prs=$(gh pr list --state open --limit 100 --json number,headRefName,headRefOid,isDraft \
	| jq -r 'sort_by(.number)[] | "\(.number) \(.headRefName) \(.headRefOid) \(if .isDraft then "draft" else "open" end)"' | tr -d '\r')
# What the result depends on: main, every open head, and the skip list; the same key means the same tree.
# An editor's sync can give this branch main as its upstream and then push dev's merge commits to main (seen 2026-10-06, twice):
# the branch never has an upstream, so a plain push or sync has nowhere to go.
git -C "$dev" branch --unset-upstream 2>/dev/null
key="$(git rev-parse origin/main) ${DEV_SKIP:-} $prs"
if [ -f "$state" ] && [ "$(cat "$state")" = "$key" ] && [ -z "${DEV_FORCE:-}" ]; then
	echo "$name: no change ($(git -C "$dev" rev-parse --short HEAD))"
	exit 0
fi
tree_before=$(git -C "$dev" rev-parse 'HEAD^{tree}')
lock_before=$(git -C "$dev" rev-parse HEAD:package-lock.json 2>/dev/null)
git -C "$dev" reset -q --hard origin/main
while read -r number branch oid kind; do
	[ -z "$number" ] && continue
	case "$skip" in *" $number "*|*" $number@$oid "*) echo "skipped #$number $branch (DEV_SKIP)"; continue ;; esac
	# The merge commits stay in this worktree, so a machine with no git identity (CI, a fresh account) gets a fixed one.
	if err=$(git -C "$dev" -c user.name=dev-rebuild -c user.email=dev-rebuild@localhost merge -q --no-edit "origin/$branch" 2>&1 >/dev/null); then
		echo "in $name: #$number $branch${kind:+ ($kind)}"
	else
		files=$(git -C "$dev" diff --name-only --diff-filter=U | tr '\n' ' ' | sed 's/ $//')
		git -C "$dev" merge --abort 2>/dev/null
		# No conflicting file means the merge failed for another reason: say which, instead of calling it a conflict.
		if [ -z "$files" ]; then echo "LEFT OUT #$number $branch (merge failed): $(printf '%s' "$err" | tail -n 1)"; continue; fi
		# Against main alone (a merge in memory, nothing written): a conflict there is the author's to rebase; one only
		# against a pull request already in waits for that one to merge first.
		if git -C "$dev" merge-tree --write-tree origin/main "origin/$branch" >/dev/null 2>&1; then with="another pull request in $name"; else with=main; fi
		echo "LEFT OUT #$number $branch (conflicts with $with): $files"
	fi
done <<EOF2
$prs
EOF2
printf '%s' "$key" > "$state"
if [ "$lock_before" != "$(git -C "$dev" rev-parse HEAD:package-lock.json)" ]; then echo "dependencies changed: run npm run setup:worktree in $dev before any suite"; fi
if [ "$tree_before" = "$(git -C "$dev" rev-parse 'HEAD^{tree}')" ]; then
	echo "$name: same content as before ($(git -C "$dev" rev-parse --short HEAD)); no new suite run needed"
else
	echo "$name rebuilt: $(git -C "$dev" rev-parse --short HEAD), $(git -C "$dev" diff --shortstat origin/main)"
fi
