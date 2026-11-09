# Helpers the drive-*.sh scripts source. They write to $FIFO, which ptyproxy.py
# feeds to Claude Code's input, so every key or click lands as one write.
# Coordinates are 1-based terminal cells (column, row).

# one raw string
send() { printf '%b' "$1" > "$FIFO"; }

# text, a key at a time, like a person typing
typeit() {
  local text=$1 i
  for (( i = 1; i <= ${#text}; i++ )); do
    printf '%s' "${text[i]}" > "$FIFO"
    sleep ${TYPE_DELAY:-0.025}
  done
}

enter() { send '\r'; }

# a left click: SGR mouse press then release
click() { send "\e[<0;$1;$2M"; sleep 0.05; send "\e[<0;$1;$2m"; }

# wait until the main turn is over: the newest transcript's last turn_duration
# comes after its last prompt, and nothing under the project (main or subagent
# transcripts) changed for $1 seconds
wait_idle() {
  local quiet=${1:-20} limit=${2:-600} start=$SECONDS main newest
  zmodload zsh/datetime zsh/stat
  while (( SECONDS - start < limit )); do
    sleep 3
    main=( "$DEMO"/.claude/projects/*/*.jsonl(N.om[1]) )
    newest=( "$DEMO"/.claude/projects/**/*(N.om[1]) )
    (( ${#main} && ${#newest} )) || continue
    (( EPOCHSECONDS - $(zstat +mtime "$newest[1]") >= quiet )) || continue
    python3 -I -c '
import json, sys
last_prompt = last_end = -1
for i, line in enumerate(open(sys.argv[1])):
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if d.get("type") == "user" and not d.get("toolUseResult") and not d.get("isMeta"):
        last_prompt = i
    if d.get("subtype") == "turn_duration":
        last_end = i
sys.exit(0 if last_end > last_prompt >= 0 else 1)
' "$main[1]" && return 0
  done
  return 1
}
