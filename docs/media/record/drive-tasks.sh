#!/bin/zsh
# Drives tasks.tape: opens the Tasks tab first, then sends a prompt whose plan
# the main agent tracks on the board, so the clip shows it filling live.
# Usage: drive-tasks.sh DEMO_DIR FIFO
DEMO=$1 FIFO=$2
source "${0:A:h}/lib.sh"

ROW_TABS=3 TASKS=145

PROMPT='Check the repo before release and track it with the jarvis task tool, one subtask per step, marking each in progress and then done as you go: run go build ./..., run go vet ./..., run go test ./..., then count the lines of Go code. Report in two lines.'

sleep 7
typeit '/jarvis'; sleep 0.6; enter
sleep 3
click $TASKS $ROW_TABS; sleep 2
TYPE_DELAY=0.012 typeit "$PROMPT"; sleep 0.6; enter
wait_idle 10 300
sleep 4
typeit '/exit'; sleep 0.5; enter
