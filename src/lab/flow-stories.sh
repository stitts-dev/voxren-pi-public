#!/usr/bin/env bash
# /flow user stories, run live in tmux: the real coach in the top-left pane, the story log below, each story typed as
# keystrokes and judged on the captured screen. No model turn is needed, so it runs without a sign-in; the live numbers
# come from the tree demo in a pane beside the coach.
#
#   just flow-stories            # run, print the verdicts, leave the session up to watch:  tmux attach -t voxren-flow
#   just flow-stories --close    # run and tear the session down (what CI or a pipe wants)
#
# Linux and macOS (tmux 3.2+). On Windows the same stories are src/tui.test.ts under tui-test (docs/agent-terminal.md).
set -uo pipefail
cd "$(dirname "$0")/../.."
S=voxren-flow
COLS=${COLS:-120}
ROWS=${ROWS:-44}
CLOSE=0
for arg in "$@"; do [ "$arg" = "--close" ] && CLOSE=1; done
HOME_DIR=$(mktemp -d -t voxren-flow-XXXXXX)
LOG=$HOME_DIR/stories.log
: > "$LOG"
export PATH="$PWD/node_modules/.bin:$PATH"

# The product default is auto on; a lab starts with it saved off so a live client's champ select is never answered.
printf '{"commands":{"draft":{"auto":false}}}\n' > "$HOME_DIR/profile.json"

tmux kill-session -t "$S" 2>/dev/null || true
# Pane ids, not "$S:0.0": a tmux.conf with base-index 1 has no window 0.
COACH=$(tmux new-session -d -P -F '#{pane_id}' -s "$S" -x "$COLS" -y "$ROWS" -e "VOXREN_COACH_HOME=$HOME_DIR" -e "PATH=$PATH" "node bin/coach.mjs")
tmux split-window -v -l 13 -t "$COACH" "printf '  FLOW STORIES  (the coach above, the tree demo beside it)\n'; tail -f $LOG"
DEMO=""

pass=0; fail=0
say() { printf '%s\n' "$*" | tee -a "$LOG"; }
screen() { tmux capture-pane -p -t "${1:-$COACH}"; }
key() { tmux send-keys -t "${2:-$COACH}" "$1"; }
line() { tmux send-keys -t "$COACH" -l "$1"; sleep 0.3; tmux send-keys -t "$COACH" Enter; }   # one line, then Enter (pitfall P4)
# wait_for <text> [present|absent] [pane]: poll the pane up to 20 s.
wait_for() {
  local text=$1 mode=${2:-present} pane=${3:-$COACH} i
  for i in $(seq 1 100); do
    if [ "$mode" = present ] && screen "$pane" | grep -qF -- "$text"; then return 0; fi
    if [ "$mode" = absent ] && ! screen "$pane" | grep -qF -- "$text"; then return 0; fi
    sleep 0.2
  done
  say "        timed out waiting for '$text' ($mode)"; return 1
}
seen() { screen "${2:-$COACH}" | grep -F -- "$1" | head -1 | sed 's/^ */        /' | tee -a "$LOG" | grep -q .; }
story() { local id=$1 title=$2; shift 2; if "$@"; then pass=$((pass+1)); say "  ✔ $id  $title"; else fail=$((fail+1)); say "  ✘ $id  $title"; fi; }

s1() { wait_for "VOXREN COACH" && seen "VOXREN COACH"; }
s2() { wait_for "COMMAND TREE" && seen "[/review]" && seen "Pulling Riot match history" && seen "not run this session"; }
s3() { key Right; wait_for "[/matchup]" && seen "/matchup <enemy>" && seen "1 meta"; }
s4() { key End; wait_for "[/pick]" && seen "[/pick]" && key Home && wait_for "[/review]" && seen "[/review]"; }
s5() { key Escape; wait_for "COMMAND TREE" absent && say "        panel gone, the default editor is back"; }
s6() { line "/flow"; wait_for "COMMAND TREE" && seen "[/review]"; }
s7() { tmux send-keys -t "$COACH" -l "/"; wait_for "COMMAND TREE" absent && wait_for "/" && say "        typed / closed the panel and landed in the editor"; tmux send-keys -t "$COACH" C-u; }
s8() { line "/flow matchup"; wait_for "takes no arguments" && seen "takes no arguments"; }
s9() {
  tmux resize-window -t "$S" -x 36
  line "/flow"; wait_for "COMMAND TREE" && seen "[/review]" && seen "▸" && seen "← → move"; local ok=$?
  key Escape; wait_for "COMMAND TREE" absent; tmux resize-window -t "$S" -x "$COLS"; return $ok
}
s10() {
  DEMO=$(tmux split-window -h -P -F '#{pane_id}' -t "$COACH" -l 58 "bun run src/lab/tree-demo.ts --width 56 --at draft")
  wait_for "COMMAND TREE" present "$DEMO" || return 1
  wait_for "running" present "$DEMO" || return 1
  # Prove the clock ticks by reading the displayed time twice and verifying it changed
  local first_time=$(screen "$DEMO" | grep -oE "running [0-9]+\.[0-9]+ s" | head -1)
  [ -n "$first_time" ] || { say "        no active call time found"; return 1; }
  local changed=0
  for i in $(seq 1 100); do
    local current_time=$(screen "$DEMO" | grep -oE "running [0-9]+\.[0-9]+ s" | head -1)
    if [ "$current_time" != "$first_time" ]; then
      changed=1
      say "        clock ticked: $first_time → $current_time"
      break
    fi
    sleep 0.2
  done
  [ "$changed" = 1 ] || { say "        clock did not tick after 20 s"; return 1; }
  seen "running" "$DEMO" && seen "so far" "$DEMO"
}

# restart: the coach again in the same pane, same coach home, so a saved setting has to come back from profile.json.
restart() { tmux respawn-pane -k -t "$COACH" "node bin/coach.mjs"; sleep 0.5; }
s11() {
  line "/flow"; wait_for "COMMAND TREE" || return 1
  key End; key Left; wait_for "[/draft]" || return 1
  key Down; wait_for "‹ off ›" || return 1
  key Right; wait_for "‹ on ›" || return 1
  grep -q '"auto": true' "$HOME_DIR/profile.json" && say "        profile.json: draft auto on" || return 1
  restart; wait_for "COMMAND TREE" || return 1
  key End; key Left; wait_for "[/draft]" && seen "auto   on"
}
s12() {
  key Home; wait_for "[/review]" || return 1
  key Down; wait_for "‹ none ›" || return 1
  key Right; wait_for "‹ 3 ›" || return 1
  key Right; key Right; key Right; wait_for "‹ 15 ›" || return 1   # 5, 10, 15
  key Left; key Right; wait_for "‹ 15 ›" || return 1
  restart; wait_for "COMMAND TREE" && wait_for "args   15" && seen "args   15"
}
s13() {
  key Home; key Right; key Right; key Right; wait_for "[/patch]" || return 1
  key Down; key Right; wait_for "‹ Aatrox ›" || return 1                       # Data Dragon's list, loaded live, first step lands
  key Left; wait_for "‹ none ›" || return 1
  key Left; wait_for "‹ Zyra ›" && say "        /patch wraps: none sits between Zyra and Aatrox" || return 1
  key Escape; key Right; wait_for "[/otp]" || return 1
  key Down; key Right; wait_for "No one-tricks saved yet" && seen "No one-tricks saved yet"; local ok=$?
  key Escape; key Escape; return $ok
}

say "  coach home $HOME_DIR · ${COLS}x${ROWS}"
story S1  "The coach opens and draws its header"                               s1
story S2  "The flow tree is the startup view, /review under the lens"           s2
story S3  "Right moves the lens to /matchup and its meta step"                  s3
story S4  "End jumps to /pick, Home back to /review"                           s4
story S5  "Escape returns to the default editor view"                          s5
story S6  "/flow reopens the tree"                                             s6
story S7  "Typing a character closes the tree and lands in the editor"         s7
story S8  "/flow with an argument is refused with a notice"                    s8
story S9  "At 36 columns the lens windows and the coach stays up"              s9
story S10 "Live lens (demo numbers): run counts, ● on the busy command, a clock"  s10
story S11 "Auto /draft toggles on its row and is still on after a restart"     s11
story S12 "Right steps /review through 3, 5, 10, 15, and 15 is back after a restart"  s12
story S13 "/patch steps the live Data Dragon list and wraps through none; /otp says none are saved"  s13
say ""
say "  $pass passed · $fail failed"
if [ "$CLOSE" = 1 ]; then tmux kill-session -t "$S"; say "  session closed"; else say "  watch: tmux attach -t $S   (q leaves the demo, Ctrl+C the coach)"; fi
[ "$fail" = 0 ]
