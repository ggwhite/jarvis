<p align="center">
  <img src="docs/images/banner.png" alt="J.A.R.V.I.S. — a live HUD for Claude Code" width="100%">
</p>

<p align="center">
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Claude%20Code-mod-F2B84B?style=flat-square&labelColor=101012" alt="Claude Code mod"></a>
  <img src="https://img.shields.io/badge/UI-en%20%7C%20zh--TW-5CE1FF?style=flat-square&labelColor=101012" alt="UI languages: English and Traditional Chinese">
  <img src="https://img.shields.io/badge/surface-terminal%20%7C%20Desktop-B07A2A?style=flat-square&labelColor=101012" alt="Runs in the terminal and in Claude Desktop">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-FFF1D6?style=flat-square&labelColor=101012" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#the-learning-loop">Learning loop</a> ·
  <a href="#install">Install</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#herdr">herdr</a> ·
  <a href="#development">Development</a>
</p>

Jarvis is a [Claude Code](https://claude.com/claude-code) mod that opens a live HUD pane beside the chat. It shows what your subagents are doing right now, what they cost, which files the session touched, and every other Claude Code session on the machine. It also keeps a record of every dispatch and turns repeated bad outcomes into rules — but only the ones you approve.

![Jarvis beside a Claude Code session in herdr, with three Explore subagents in flight](docs/screenshots/now.png)

## Features

| | Tab | What it shows |
| :-: | --- | --- |
| ⚡ | **Now** | Subagents in flight: type, task, elapsed time, tokens and estimated API cost. An animated suit stands by when nothing runs. |
| ☰ | **Events** | A scrolling log of tool calls, per session or per subagent. Pause and resume. |
| ▤ | **Stats** | Dispatch counts per agent type, token use and cost per model. |
| 🚀 | **Fleet** | Every Claude Code session in [herdr](#herdr): status (working / blocked / idle), last prompt and reply, today's tokens, and the 5-hour and 7-day quota. Click a session to jump to its pane. |
| ⇄ | **Changes** | Files this session edited, grouped by git repo, with diffs. Unpushed changes, ahead/behind counts and a commit graph per repo. |
| ✓ | **Tasks** | A task board the model fills through the `mcp__jarvis__task` tool, so you can see its plan and progress. |
| 💡 | **Lessons** | Dispatch health per agent type × model, and lessons drawn from repeated bad outcomes. Approve, Reject or Revert each one. |

<p align="center">
  <img src="docs/screenshots/tabs.png" alt="The Tasks, Changes, Commits, Fleet, Stats and Events tabs" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/lessons.png" alt="The Lessons tab: dispatch health per agent type and model, and a candidate lesson with Approve and Reject" width="70%">
</p>

Also:

- Flags stuck and looping subagents as they happen.
- Writes a one-line squad summary to the herdr sidebar.
- Draws a native layout in Claude Desktop and a cell grid in the terminal.
- Speaks English and Traditional Chinese.

## The learning loop

<p align="center">
  <img src="docs/images/learning-loop.png" alt="Record, flag, lesson, promote (you approve), measure — and back to record" width="100%">
</p>

1. **Record.** Every subagent dispatch is written to `~/.claude/jarvis/ledger/<day>/<session>.jsonl`: type, model, duration, tokens, tool errors, and how it ended. Each session writes only its own file, so parallel sessions never collide. On the first run, Jarvis backfills the last 14 days from your transcripts.
2. **Flag.** Fixed rules, no model call:

   | Flag | Rule |
   | --- | --- |
   | `tiny` | finished with ≤ 2 tool calls (not a verifier or clerk) — you could have done it yourself |
   | `heavy` | an Explore or clerk run over 300k tokens or 10 minutes |
   | `tool-errors` | ≥ 3 tool errors and ≥ 30 % of its calls |
   | `loop` / `stuck` | the same tool failing 3 times in a row / silent for 5 minutes |
   | `error-end` | ended with an error, a refusal or an abort |
   | `verify-fail` | a verifier failed the worker's result |
   | `redispatch` | the same task was dispatched again |
   | `corrected` | your next prompt corrects the result ("that's wrong", "你不是說…") |

3. **Lesson.** Flags group by kind × agent type × model. One strike is noise; two strikes in 30 days make a candidate. Open candidates are added to the main agent's next prompt, once per session.
4. **Promote.** Nothing changes until you press **Approve** in the Lessons tab. Then Jarvis stores one `feedback` memory through [memory-mcp](https://github.com/ggwhite/memory-mcp) and asks the main agent to add one rule line to the right file, tagged `<!-- ev: #id -->`, and to show you the diff.
5. **Measure.** For every applied lesson, Jarvis compares the flag rate before and after. When the rule does not help, the tab offers **Revert**.

## Requirements

- Claude Code with mod (function hook) support. Tested on CLI 2.1.311 and the Claude Desktop built-in 2.1.308.
- `git`, for the Changes tab.
- [herdr](#herdr) (optional), for the Fleet tab and the sidebar summary.
- [memory-mcp](https://github.com/ggwhite/memory-mcp) at `~/.local/bin/memory-mcp` (optional), for approving lessons.
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

The entry point is `hooks/register.tsx` (listed in `hooks/hooks.json`). Rendering and every learning-loop rule live in pure functions under `hooks/` (`ledger.ts`, `flags.ts`, `lessons.ts`, `learn.ts`), so the tests in `tests/` cover them without a live session. `integration/` holds tests that run real `git`. The banner and the loop diagram are drawn from the SVG sources in `docs/images/`.

Type checking (`npx -p typescript tsc --noEmit -p .`) needs Claude Code's mod type files in `.claude-plugin/types/`, which are not committed. The tests do not need them.

## License

[MIT](LICENSE)
