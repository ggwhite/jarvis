# The long take every clip is cut from: a real Claude Code session in the demo
# home with the jarvis pane open. Run through record.sh, which sets DEMO.
Output tour.mp4
Set Shell zsh
Set FontFamily "JetBrains Mono, Symbols Nerd Font Mono"
Set FontSize 12
Set Width 1400
Set Height 820
Set Padding 10
Set Framerate 20
Set TypingSpeed 0

Hide
Type `cd "$DEMO/todo-api" && rm -f "$DEMO/in.fifo" && mkfifo "$DEMO/in.fifo" && clear && ("$REC/drive-tour.sh" "$DEMO" "$DEMO/in.fifo" > "$DEMO/drive.log" 2>&1 &) && "$REC/demo-env.sh" "$DEMO" python3 -I "$REC/ptyproxy.py" "$DEMO/in.fifo" claude --dangerously-skip-permissions --append-system-prompt "$(cat "$REC/system-prompt.txt")"; clear; echo TOUR''DONE`
Enter
Sleep 1s
Show
Wait+Screen@20m /TOURDONE/
