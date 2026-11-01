# Jarvis learning loop — design

Date: 2026-11-02 · Status: draft · Branch: `feat-learning-loop`

## Intent

The user dispatches many subagents a day (Explore, clerk, worker, verifier, fork). Today, lessons from bad dispatches are learned by hand: the user notices, corrects the main agent, and a `feedback` memory is stored. Most of the 125 feedback memories are never recalled (only the 10 newest are injected at session start), and nothing measures whether a rule really changed behaviour.

Jarvis already sees every dispatch. This feature turns Jarvis from a viewer into a closed loop:

1. **Record** every subagent dispatch and its outcome to a ledger that survives sessions.
2. **Flag** bad outcomes with fixed, deterministic rules (no model call).
3. **Lesson**: group flags by a stable key. One strike is noise (the user's Two-Strikes rule).
4. **Promote**: at two strikes, the lesson becomes a candidate. The user approves or rejects it in a new **Lessons** tab. On approve, Jarvis stores a memory and asks the main agent to write one imperative rule into the right rule file.
5. **Measure**: after a rule is applied, Jarvis compares the flag rate before and after, and proposes a revert when the rule does not help.

The Lessons tab also answers the user's direct question about Events: which agent runs most, which runs longest, which fails most.

## Goals

- A cross-session dispatch ledger with outcome fields.
- Deterministic flag rules, each testable as a pure function.
- A Lessons tab (terminal and Desktop) with a dispatch health table and a lesson list with Approve / Reject / Revert buttons.
- Recall without luck: every candidate lesson is injected into the main agent's context once per session (no prompt classifier in v1).
- A before/after metric for every applied lesson.

## Non-goals

- No context-budget view (the user declined it: they compact by hand).
- No automatic edits to rule files without the user pressing Approve.
- No model call in record, flag, or measure. The only model work is the main agent writing the rule text after Approve.
- No cross-machine sync.
- No change to how the main agent routes work, beyond the rules the user approves.

## Anti-goals (failure even if it works)

- **Rule bloat.** Every promoted rule must pass Two-Strikes, be approved, and be measured; rules that do not help get a revert proposal.
- **Noisy injection.** Injected lessons are short (≤ 3 lines per prompt) and a lesson is injected at most once per session unless its strike count grows.
- **Memory pollution.** Flags never go to memory-mcp. Only an approved lesson writes one `feedback` memory.
- **Slow pane.** Ledger I/O never runs in render. Aggregates are cached and recomputed only when the ledger changes.
- **Cache breaks.** Nothing is added through `prompt.compose`; lessons go through `prompt.submit` context.

## Constraints (from the code, see `register.tsx`, `jarvis.ts`, engine types)

- Atoms are session-scoped. `$.store` persists but is capped at 4 MiB. `$.fs` can read/write files. `$.process.run(argv)` runs commands without a shell.
- Dispatch data: `agent.spawn` (type, description, model, agentId, prompt, background, fork, tool_use_id), `turn.complete` with agentId (reason, durationMs, answer, usage), `tool.call` events (actor, tool, ok, ms), `prompt.submit` (`e.text` = the user's prompt), health checks `loop` / `stuck` in `jarvis.ts:556-596`.
- Effort is not in the spawn input; it is left out of v1.
- Task board subtasks overwrite `agentId` on re-dispatch; history must be kept before the overwrite.
- Desktop (2.1.308 built-in) rejects some Text props; every view must pass `plugin test` on both the CLI and the Desktop binary, with no "refused" / "is not allowed" output.
- i18n: every UI string and injected text has zh-TW and en entries in `hooks/i18n.ts`.
- Several Claude sessions run at once (herdr). Two sessions must never write the same file. `$.store` is one shared file, so this feature does not use it.
- Engine types (`.claude-plugin/types/claude-code/index.d.ts`) are git-ignored; a new worktree needs a symlink to the main repo's copy before `tsc` can run.

## Design

### 1. Ledger

- Location: `~/.claude/jarvis/ledger/<YYYY-MM-DD>/<sessionId>.jsonl` via `$.fs`. **Each session writes only its own file**, so concurrent sessions never race. A session rewrites its own file (small) after each change, debounced to at most once per 2 s and flushed on session end.
- Retention: on session start, delete day folders older than 60 days.
- Reading: rows are de-duplicated by `id`; a live row wins over a backfilled row.
- Reading: the Lessons tab and the flag/lesson logic read the last 60 days of all sessions. Read once on session start and when the Lessons tab opens; then refresh at most every 60 s. Rows from the current session come from memory, not disk.
- One row per dispatch (schema `v: 1`):

| field | source |
|---|---|
| `id` (agentId), `session`, `project` (cwd basename), `at` (spawn ms) | `agent.spawn` |
| `type` (subagent_type, `fork` for forks), `model` (full id), `family` (opus/sonnet/haiku/fable/other), `background`, `desc` (≤ 120 chars), `promptLen` | `agent.spawn` |
| `doneAt`, `durationMs`, `reason` (answer/aborted/refusal/error), `tokens {in,out,cr,cw}`, `cost` | `turn.complete` |
| `tools`, `toolErrors` | `tool.call` events with this actor |
| `health` (`loop` / `stuck` seen at any time) | health check |
| `verdict` (`pass` / `fail` / `partial` / null) | verifier only, parsed from its answer |
| `subtask`, `redispatchOf` (previous agentId of the same subtask) | `mcp__jarvis__task` update with `agent` |
| `corrected` (bool) | next user prompt, see flags |
| `flags` (kinds, computed) | flag rules |

### 2. Flag rules (pure functions in `hooks/flags.ts`)

| kind | rule | flagged row |
|---|---|---|
| `verify-fail` | a verifier ends with verdict `fail` | the latest finished `worker` row in the same session that ended before the verifier spawned |
| `redispatch` | a task-board subtask gets a new `agent` while its previous agent is finished | the previous row |
| `loop` | the health check's loop rule fired for this subagent (its last 3 events are the same failing tool) | that row |
| `stuck` | this subagent is running and its **own** last event is older than `STUCK_MS` (5 min) | that row; a stalled main loop flags nothing |
| `error-end` | `reason` is `error`, `refusal` or `aborted` | that row |
| `tool-errors` | `toolErrors ≥ 3` and `toolErrors / tools ≥ 0.3` | that row |
| `tiny` | finished with `tools ≤ 2`, type is not `verifier` or `clerk` | that row (the user's rule: ≤ 3 tool calls → do it yourself) |
| `heavy` | type `Explore` or `clerk`, and `in + cw + out > 300k` tokens or `durationMs > 10 min` | that row |
| `corrected` | the user's next prompt in the same session, within 15 min of the row's `doneAt`, matches the correction pattern | every row that finished during the previous request |

Verdict parsing (verifier answer): first match wins — a line `VERDICT: PASS|FAIL|PARTIAL`; else the `結論` line containing `不通過` → fail, `部分` → partial, `通過` → pass; else English `Conclusion: pass/fail`. The verifier agent definition (`~/dotfiles/claude/agents/verifier.md`) gets one line asking it to end with `VERDICT: PASS|FAIL|PARTIAL`.

Correction pattern (case-insensitive): `你不是說|不是叫你|不對|錯了|為什麼沒|為什麼又|又忘|you said|that's wrong|not what i|why didn't you|you forgot`.

Thresholds live in one exported `FLAG_RULES` constant so tests and the view use the same numbers.

### 3. Lessons (`hooks/lessons.ts`)

- **Key**: `<kind>:<type>:<family>`, e.g. `verify-fail:worker:sonnet`, `tiny:Explore:haiku`. For `corrected` the family is ignored (`corrected:worker:*`).
- **Window**: flags from the last 30 days.
- **States**: `watching` (1 strike) → `candidate` (≥ 2 strikes) → `approved` → `applied` → measured (`helping` / `not-helping` / `too-early`). Side states: `rejected`, `reverted`.
- Lesson state is an **event log**: `~/.claude/jarvis/lessons/<sessionId>.jsonl`, one line per event (`approve`, `memory`, `apply-cancel`, `applied`, `reject`, `revert-request`, `reverted`) with key, time and data. Each session writes only its own file; all files are folded in time order on read. Strike counts are always recomputed from the ledger.
- Lessons are **global** (the rule files are global): the key has no project, and candidates are injected in every session.
- A `rejected` or `reverted` key becomes a candidate again only after 3 new strikes since that event.
- An `applied` key never returns to candidate; its new strikes feed the metric (§7).
- Each candidate has **evidence**: the last 3 flagged rows (date, project, `desc`, the numbers that tripped the rule).

### 4. Approve / Reject / Revert (Lessons tab buttons, `onPress`)

- **Approve**:
  1. Jarvis runs `~/.local/bin/memory-mcp store --json -t feedback --tags jarvis-lesson,<kind> "<lesson text>"` (no `--project`: the lesson is global) and keeps the returned id. If it fails, the lesson stays `approved` with an error note and the button shows Retry.
  2. Only the session where Approve was pressed asks for the edit. On its next `prompt.submit`, Jarvis adds context: the lesson, its evidence, the memory id, and a suggested rule file (table below). It asks the main agent to add **one** imperative rule (`一律` / `NEVER`) with `<!-- ev: #<memoryId> -->`, show the diff, and then call `mcp__jarvis__lesson` with `op: "applied"`.
- If that turn ends without the `applied` call (the user declined the diff, or the agent did not act), the lesson shows **Waiting** with two buttons: Retry (inject the request again on the next prompt) and Cancel (back to `candidate`; the memory stays). Other sessions show the lesson as `approved`, read-only.
- **Reject**: state `rejected`. Nothing is written.
- **Revert** (only shown for `not-helping`): on the next `prompt.submit`, Jarvis asks the main agent to remove that rule line (found by its `ev` tag) and call `mcp__jarvis__lesson` with `op: "reverted"`.

Suggested rule file per kind (the main agent may choose another and must say why):

| kind | file |
|---|---|
| `tiny`, `heavy`, `redispatch` | `~/dotfiles/claude/skills/model-routing/SKILL.md` (path resolved from `~/.claude/skills/model-routing`) |
| `verify-fail` | `~/dotfiles/claude/agents/worker.md` |
| `loop`, `stuck`, `tool-errors`, `error-end` | `~/dotfiles/claude/agents/<type>.md` if it exists, else model-routing |
| `corrected` | `~/dotfiles/agents/core.md` |

### 5. Tool `mcp__jarvis__lesson`

- `op: "list"` → candidate and applied lessons with strikes, evidence and metrics (text, for the main agent).
- `op: "applied"`, `key`, `file` → state `applied`, `appliedAt = now`, records the file.
- `op: "reverted"`, `key` → state `reverted`.
- Unknown key or wrong state → an error string, no state change.

### 6. Recall injection (`prompt.submit` context)

- Inject when at least one lesson is `candidate` (not yet acted on) or `approved`/`revert` needs the main agent.
- Candidate lines: at most 3, highest strikes first, one line each: `Jarvis lesson (2× in 30d): tiny:Explore:haiku — Explore finished with ≤ 2 tool calls; do it yourself when it fits in 3 calls.` Each key once per session, again only if its strike count grows.
- Approve / revert requests are injected once, in the session where the button was pressed; Retry injects again.
- Text comes from i18n (`JARVIS_LANG`).

### 7. Measure

- For an applied key: `rate = flagged rows of (kind, type, family) / all finished rows of (type, family)`.
- `before` = the 30 days before `appliedAt`; `after` = since `appliedAt`.
- Verdict when `after` has ≥ 8 rows: `helping` if `afterRate ≤ 0.5 × beforeRate`; `not-helping` if `afterRate ≥ beforeRate`; else `unclear`. Fewer than 8 rows → `too-early`.

### 8. Lessons tab

New tab `lessons` (icon, i18n `tab.lessons`), after Tasks. Two sections:

1. **Dispatch health** (last 14 days, all sessions): one row per `type × family` with runs, median and p90 duration, mean tokens, flag rate, top flag kind. Sorted by runs. Rows with a flag rate ≥ 20% are highlighted. This is "which runs most / longest / fails most".
2. **Lessons**: candidates first (strikes, evidence lines, Approve / Reject), then approved (waiting for the main agent), then applied (before → after rate, n, verdict; Revert when not-helping), then watching (one dim line each). Rejected and reverted are hidden behind a count.

Terminal: rendered in `hooks/lessonsView.ts` in the cockpit style (amber theme), with RWD like other tabs. Desktop: a page in `desktopPages*.tsx` using only allowed props. Buttons use `<Button plain onPress>`; state writes happen in `onPress`, never during render.

Empty state: "No dispatches recorded yet" with the ledger path.

### 9. Backfill (first run)

When the ledger has no rows older than today, backfill the last 14 days once from `~/.claude/projects/*/<session>/subagents/agent-*.{meta.json,jsonl}`: type, model, description, tokens, duration, tool count and errors. Backfilled rows get `backfill: true` and can trip only `tiny`, `heavy`, `tool-errors` and `error-end`. They are written into `<day>/backfill.jsonl` by whichever session runs it first (guarded by a `$.store` flag `backfillDone`).

## Module layout

- New: `hooks/ledger.ts` (row type, encode/decode, day files, retention, roll-up), `hooks/flags.ts`, `hooks/lessons.ts` (keys, states, evidence, metrics, injection text, memory-mcp argv), `hooks/lessonsView.ts`, `hooks/backfill.ts`, tests for each.
- Touched: `jarvis.ts` (health check returns the looping actor and per-agent stuck), `register.tsx` (hooks wiring, store I/O, tool registration, onPress handlers), `types/index.d.ts` (`JarvisPage | 'lessons'`, row types, `McpToolInputs.mcp__jarvis__lesson`), `cockpit.tsx` (TABS, render branch), `icons.ts`, `i18n.ts`, `desktopPagesA/B.tsx`, `tasks.ts` (keep the previous agentId), README (feature row).
- Outside the repo: one line in `~/dotfiles/claude/agents/verifier.md` (verdict line).

## Acceptance

- All existing tests and new tests pass on `claude plugin test .` (CLI) and on the Desktop built-in binary, with no "refused" / "is not allowed".
- `npx -p typescript tsc --noEmit -p .` passes.
- Real run in herdr: a session that dispatches a tiny Explore twice shows a `tiny:Explore:haiku` candidate in the Lessons tab; the ledger file exists for that session; the next prompt carries the lesson line; Approve stores a memory (id visible) and the main agent receives the apply request.

## Left to the builder

Exact layout and colours of the tab, file split inside `register.tsx`, debounce details, and test structure.
