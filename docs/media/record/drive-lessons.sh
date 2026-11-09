#!/bin/zsh
# Drives lessons.tape: opens the Lessons tab, approves the candidate the seed
# and tour sessions left behind, and lets the main agent write the rule.
# Usage: drive-lessons.sh DEMO_DIR FIFO [APPROVE_COL APPROVE_ROW]
DEMO=$1 FIFO=$2
source "${0:A:h}/lib.sh"

ROW_TABS=3 LESSONS=154
# [Approve] on the first candidate, with two rows of dispatch health above it
APPROVE_COL=${3:-127} APPROVE_ROW=${4:-12}

sleep 7
typeit '/jarvis'; sleep 0.6; enter
sleep 3
click $LESSONS $ROW_TABS;           sleep 4
click $APPROVE_COL $APPROVE_ROW;    sleep 4
typeit 'Go ahead.'; sleep 0.6; enter
wait_idle 12 300
sleep 6
typeit '/exit'; sleep 0.5; enter
