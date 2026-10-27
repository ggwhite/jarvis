# Jarvis

A [Claude Code](https://claude.com/claude-code) mod that opens a live HUD pane beside the chat. It shows what your subagents are doing right now, what they cost, which files the session touched, and every other Claude Code session running on the machine.

<!-- Screenshot: terminal pane (Now tab) -->
<!-- Screenshot: Claude Desktop (native layout) -->
<!-- Screenshot: Fleet tab -->

## Features

The pane has six tabs:

| Tab | What it shows |
| --- | --- |
| **Now** | Subagents in flight: type, task, elapsed time, tokens and estimated API cost. An animated suit stands by when nothing runs. |
| **Events** | A scrolling log of tool calls, per session or per subagent. Pause and resume. |
| **Stats** | Dispatch counts per agent type, token use and cost per model. |
| **Fleet** | Every Claude Code session in [herdr](#herdr): status (working / blocked / idle), last prompt and reply, today's tokens, and the 5-hour and 7-day quota. Click a session to jump to its pane. |
| **Changes** | Files this session edited, grouped by git repo, with diffs. Unpushed changes, ahead/behind counts and a commit graph per repo. |
| **Tasks** | A task board the model fills through the `mcp__jarvis__task` tool, so you can see its plan and progress. |

Other details:

- Detects stuck or looping subagents and flags them.
- Reports a one-line squad summary to the herdr sidebar.
- Draws a native layout in Claude Desktop and a cell grid in the terminal.
- English and Traditional Chinese UI.

## Requirements

- Claude Code with mod (function hook) support. Tested on CLI 2.1.311 and the Claude Desktop built-in 2.1.308.
- `git`, for the Changes tab.
- [herdr](#herdr) (optional), for the Fleet tab and the sidebar summary.
- A [Nerd Font](https://www.nerdfonts.com/) in the terminal, for the icons.

## Install

Clone the repo and point Claude Code at it with `CLAUDE_CODE_PLUGIN_DIRS` (a colon-separated list):

```bash
git clone https://github.com/ggwhite/jarvis.git ~/github/jarvis
```

In `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/github/jarvis",
    "JARVIS_LANG": "en"
  }
}
```

Start a new session and run `/jarvis` to open the pane. To update, `git pull` and start a new session.

## Configuration

All settings are environment variables, set in the `env` block of `settings.json`.

| Variable | Values | Default |
| --- | --- | --- |
| `JARVIS_LANG` | `en`, `zh-TW` | `zh-TW` |
| `JARVIS_DESKTOP_LAYOUT` | `native`, `cells` (Claude Desktop only) | `native` |
| `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` | `1` turns on the images inside herdr panes | unset |

## herdr

[herdr](https://herdr.dev) (`brew install herdr`, tested with 0.9.5) is a terminal multiplexer for coding agents. When Claude Code runs inside herdr (`HERDR_ENV=1`), Jarvis reads every pane through the `herdr` CLI to build the Fleet tab, and writes a squad summary to its own pane's sidebar. Without herdr, every tab except Fleet works as usual.

## Development

```bash
claude plugin validate .
claude plugin test .
```

The entry point is `hooks/register.tsx` (listed in `hooks/hooks.json`). Rendering logic is kept in pure functions under `hooks/` so the tests in `tests/` can cover them without a live session. `integration/` holds tests that run real `git`.

Type checking (`npx -p typescript tsc --noEmit -p .`) needs Claude Code's mod type files in `.claude-plugin/types/`, which are not committed. The tests do not need them.

## License

[MIT](LICENSE)
