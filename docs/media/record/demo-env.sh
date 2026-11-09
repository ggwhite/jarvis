#!/bin/zsh
# Run a command with a clean environment whose $HOME is the demo home.
# Usage: demo-env.sh DEMO_DIR CMD [ARGS...]
DEMO=$1; shift
exec env -i HOME="$DEMO" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh \
  PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  TERM=xterm-256color COLORTERM=truecolor LANG=en_US.UTF-8 CLAUDE_CODE_NO_FLICKER=1 \
  "$@"
