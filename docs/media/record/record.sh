#!/bin/zsh
# Record the takes the README clips are cut from, then cut them.
#
# Usage: docs/media/record/record.sh [WORK_DIR]
#
# Needs vhs, ffmpeg, img2webp, go, a logged-in Claude Code, memory-mcp (for
# Approve) and the fonts the tapes name: JetBrains Mono and Symbols Nerd Font
# Mono. It spends real tokens: a seed session with two tiny Explore
# dispatches (so the Lessons tab has a candidate), then three recorded
# sessions: tour.tape (four subagents and a walk through the tabs),
# lessons.tape (Approve, then the rule edit) and tasks.tape (the board).
# The demo home is /private/tmp/jarvis-demo, so no user name shows in paths.
set -euo pipefail
REC=${0:A:h}
WORK=${1:-$(mktemp -d)}
DEMO=/private/tmp/jarvis-demo

"$REC/setup-demo.sh" "$DEMO"

# seed: two dispatches that finish in one tool call each, two `tiny` strikes
(cd "$DEMO/todo-api" && "$REC/demo-env.sh" "$DEMO" claude -p --dangerously-skip-permissions \
  "Dispatch two Explore agents in parallel and wait for both: one reads go.mod and reports the module path, the other reads README.md and reports its first line. Then answer in one line." </dev/null)

cd "$WORK"
DEMO=$DEMO REC=$REC vhs "$REC/tour.tape"
DEMO=$DEMO REC=$REC vhs "$REC/lessons.tape"
DEMO=$DEMO REC=$REC vhs "$REC/tasks.tape"
"$REC/build.sh" "$WORK/tour.mp4" "$WORK/lessons.mp4" "$WORK/tasks.mp4"
