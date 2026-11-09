#!/bin/zsh
# Drives the recorded session for tour.tape: opens the pane, sends one real
# prompt that dispatches subagents, waits for the turn to finish, then walks
# the pane's tabs. Usage: drive-tour.sh DEMO_DIR FIFO
DEMO=$1 FIFO=$2
source "${0:A:h}/lib.sh"

# tab labels on row 3 of a 169x49 terminal (vhs 1400x820, font 12, padding 10)
ROW_TABS=3
NOW=98 EVENTS=106 STATS=116 FLEET=125 CHANGES=135 TASKS=145 LESSONS=154

PROMPT='Add a DELETE /todos/{id} endpoint. Track the plan with the jarvis task tool. First dispatch three Explore agents in parallel in the background: one maps internal/todo, one checks the routes in cmd/server, one finds the existing tests. When they report back, implement the endpoint with a table-driven test, then dispatch a general-purpose agent to run go test ./... and go vet ./... and review the diff.'

sleep 7
typeit '/jarvis'; sleep 0.6; enter
sleep 4
typeit "$PROMPT"; sleep 0.8; enter

wait_idle 20 900
sleep 2

click $TASKS $ROW_TABS;   sleep 5
click $CHANGES $ROW_TABS; sleep 4
click 123 6;              sleep 4   # Commits
click 100 6;              sleep 2   # This session
click 110 8;              sleep 5   # first file: its diff
click $STATS $ROW_TABS;   sleep 5
click $EVENTS $ROW_TABS;  sleep 5
click $LESSONS $ROW_TABS; sleep 6
click $NOW $ROW_TABS;     sleep 3
typeit '/exit'; sleep 0.5; enter
