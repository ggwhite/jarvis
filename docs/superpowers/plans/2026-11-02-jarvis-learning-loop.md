# Jarvis Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each task is implemented by a `worker` subagent and gated by a separate `verifier` subagent before the next task starts; a whole-branch review closes the plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Jarvis into a closed learning loop: record every subagent dispatch to a cross-session ledger, flag bad outcomes with fixed rules, group them into lessons (Two-Strikes), let the user approve / reject / revert them in a new Lessons tab, inject open lessons into the main agent's context, and measure each applied lesson.

**Architecture:** Pure modules (`ledger.ts`, `flags.ts`, `lessons.ts`, `backfill.ts`) hold every rule and are unit-tested without the engine. `learn.ts` is the only stateful piece: an in-memory recorder per session with injected file I/O (`ChangesIo` from `ioOf`), debounced writes to its own per-session files, and the read/fold of all sessions' files. `register.tsx` only forwards hook events to `learn.ts`, registers `mcp__jarvis__lesson`, adds `prompt.submit` context, and hands the view its data. Views (`lessonsView.ts`, a Desktop page) draw what `lessons.ts` computed.

**Tech Stack:** TypeScript Claude Code mod (function hooks, `claude-code` engine API, `claude-code/testing`).

**Spec:** `docs/superpowers/specs/2026-11-02-jarvis-learning-loop-design.md`

## Global Constraints

- Tests: `claude plugin test .` (CLI) **and** the Desktop built-in binary: `"$(ls "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude | sort -V | tail -1)" plugin test .` — both all-pass, and neither output contains `refused` or `is not allowed`.
- Types: `npx -p typescript tsc --noEmit -p .` → 0 errors. The worktree has a copied `.claude-plugin/types/` (git-ignored); do not delete it.
- TDD: every task's report shows the RED output (the failing run, before code) and the GREEN output. A report without RED output is rejected.
- Git: only `/usr/bin/git`, run in the worktree directory. Never `rtk git`, never `cd $VAR && git`, never git with globs.
- i18n: every UI string and every injected / tool text has a key in **both** dictionaries of `hooks/i18n.ts` (zh-TW first block, en second); TS enforces equal keys. Use `t()` / `tr()` like existing code.
- Comments: Jarvis source and comments are English throughout (public repo); follow that existing file convention, not the global Traditional-Chinese comment rule.
- No `$.store`. Each session writes only files named with its own session id. No `prompt.compose` changes. Never write files or state during render (writes only in hooks and `onPress`).
- Paths: ledger `${HOME}/.claude/jarvis/ledger/<YYYY-MM-DD>/<sessionId>.jsonl`; backfill `${HOME}/.claude/jarvis/ledger/<YYYY-MM-DD>/backfill.jsonl`; lesson events `${HOME}/.claude/jarvis/lessons/<sessionId>.jsonl`. `HOME` from `$.env.get('HOME')` (already read at `register.tsx:1040` as `home`).
- memory-mcp: `${HOME}/.local/bin/memory-mcp` (absolute path; `$.process.run` has no shell).
- Spec numbers (copy exactly): retention 60 days; lesson window 30 days; health window 14 days; backfill 14 days; debounce 2 s; read refresh ≥ 60 s; `tiny` tools ≤ 2 (not verifier/clerk); `heavy` > 300 000 tokens (in + cw + out) or > 10 min, Explore/clerk only; `tool-errors` ≥ 3 and ratio ≥ 0.3; `stuck` 5 min (`STUCK_MS`); `corrected` within 15 min; injection ≤ 3 lines; reject/revert reopen after 3 new strikes; metric needs ≥ 8 after-rows, helping ≤ 0.5 × before, not-helping ≥ before; desc ≤ 120 chars; health highlight flag rate ≥ 20%.

## Review Focus

1. **Corrupt or partial ledger lines** (a crash mid-write, a hand edit): reading must skip bad lines and keep the rest — test in Task 1 (`decodeRows skips bad lines`).
2. **Two sessions open at once**: session A's Approve must not make session B ask for the rule edit; B shows it read-only — test in Task 7 (`only the approving session gets the apply request`).
3. **memory-mcp missing or failing** (binary absent, non-zero exit, non-JSON stdout): the lesson stays `approved` with an error and Retry; nothing throws out of the hook — test in Task 7 (`memory store failure keeps approved with error`).
4. **No HOME / unwritable `~/.claude/jarvis`**: recording silently does nothing, the pane still draws, the tab shows the empty state — test in Task 7 (`no home records nothing and never throws`).
5. **Midnight and long sessions**: a row spawned before midnight and finished after it is written once, to the day of its `at` — test in Task 1 (`a row goes to the day of its spawn`).

---

### Task 1: Ledger rows, codec, paths, roll-up

**Files:**
- Create: `hooks/ledger.ts`
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Produces:
  - Reuse `Family` and `nameFamilyOf` from `hooks/jarvis.ts` (do not redefine them). `type RowFamily = Family | 'other'`.
  - `rowFamily(model: string): RowFamily` — `nameFamilyOf(model) ?? 'other'` (covers ids and aliases like `opus`).
  - `type Verdict = 'pass' | 'fail' | 'partial'`
  - `type DispatchRow = { v: 1; id: string; session: string; project: string; at: number; type: string; model: string; family: RowFamily; background: boolean; desc: string; promptLen: number; doneAt?: number; durationMs?: number; reason?: 'answer' | 'aborted' | 'refusal' | 'error'; tokens: { in: number; out: number; cr: number; cw: number }; cost?: number; tools: number; toolErrors: number; health?: ('loop' | 'stuck')[]; verdict?: Verdict; subtask?: string; redispatchOf?: string; corrected?: boolean; backfill?: true }`
  - `const DESC_LEN = 120`, `const RETAIN_DAYS = 60`, `const HEALTH_DAYS = 14`
  - `dayKey(ms: number): string` — local `YYYY-MM-DD`.
  - `ledgerDir(home: string): string`, `ledgerFile(home: string, day: string, session: string): string`, `lessonsFile(home: string, session: string): string`
  - `encodeRows(rows: readonly DispatchRow[]): string` (one JSON per line, trailing `\n`); `decodeRows(text: string): DispatchRow[]` (skips lines that fail JSON.parse or lack `v === 1`, `id`, `at`).
  - `dedupe(rows: readonly DispatchRow[]): DispatchRow[]` — by `id`; a row without `backfill` wins; else the later `doneAt`.
  - `rowsByDay(rows: readonly DispatchRow[]): Map<string, DispatchRow[]>` — grouped by `dayKey(row.at)`.
  - `expiredDays(days: readonly string[], now: number): string[]` — names matching `^\d{4}-\d{2}-\d{2}$` older than `RETAIN_DAYS`; other names never returned.
  - `type HealthRow = { type: string; family: RowFamily; runs: number; medianMs: number; p90Ms: number; meanTokens: number; flagRate: number; topFlag?: string }`
  - `dispatchHealth(rows: readonly DispatchRow[], flagsOf: (r: DispatchRow) => readonly string[], now: number): HealthRow[]` — finished rows (`doneAt` set) with `at` within `HEALTH_DAYS`; sorted by runs desc, then type.

- [ ] **Step 1: Write the failing tests** in `tests/ledger.test.ts`:
  - `rowFamily maps ids and aliases`: `claude-opus-5-5`→opus, `opus`→opus, `claude-sonnet-5-5`→sonnet, `claude-haiku-5-5`→haiku, `claude-fable-5-1`→fable, `''`→other.
  - `encode then decode round-trips`.
  - `decodeRows skips bad lines`: input `good\n{oops\n{"v":2,...}\n\ngood2` → 2 rows.
  - `a row goes to the day of its spawn`: `at` = 23:59 local, `doneAt` next day → `rowsByDay` has only the first day.
  - `dedupe prefers the live row over backfill`.
  - `expiredDays keeps 60 days and ignores odd names`: `['2026-08-01','2026-10-30','notes','2026-1-1']` at 2026-11-02 → `['2026-08-01']`.
  - `dispatchHealth`: 3 Explore/haiku rows (1 s, 2 s, 10 s; one flagged `tiny`) + 1 worker/opus → first row `{type:'Explore', family:'haiku', runs:3, medianMs:2000, flagRate:1/3, topFlag:'tiny'}`; a row 15 days old is excluded; an unfinished row is excluded.
- [ ] **Step 2: Run** `claude plugin test .` → expect FAIL (module not found). Paste the output.
- [ ] **Step 3: Implement** `hooks/ledger.ts`. p90 = value at index `ceil(0.9·n)−1` of the sorted durations; median = lower middle for even n.
- [ ] **Step 4: Run** `claude plugin test .` → PASS; `tsc` → 0 errors.
- [ ] **Step 5: Commit** `/usr/bin/git add hooks/ledger.ts tests/ledger.test.ts && /usr/bin/git commit -m "feat(jarvis): add the dispatch ledger rows and codec"`

### Task 2: Flag rules

**Files:**
- Create: `hooks/flags.ts`
- Test: `tests/flags.test.ts`

**Interfaces:**
- Consumes: `DispatchRow`, `RowFamily` (Task 1).
- Produces:
  - `type FlagKind = 'verify-fail' | 'redispatch' | 'loop' | 'stuck' | 'error-end' | 'tool-errors' | 'tiny' | 'heavy' | 'corrected'`
  - `const FLAG_RULES = { tinyMaxTools: 2, tinyExempt: ['verifier', 'clerk'], heavyTypes: ['Explore', 'clerk'], heavyTokens: 300_000, heavyMs: 600_000, toolErrorsMin: 3, toolErrorsRatio: 0.3, correctionMs: 900_000 } as const`
  - `parseVerdict(answer: string): Verdict | undefined`
  - `isCorrection(text: string): boolean`
  - `rowFlags(row: DispatchRow): FlagKind[]` — the per-row kinds: `loop`/`stuck` from `row.health`, `error-end`, `tool-errors`, `tiny`, `heavy`, `corrected` (from `row.corrected`). Unfinished rows → `[]`. Backfilled rows only `tiny`, `heavy`, `tool-errors`, `error-end`.
  - `sessionFlags(rows: readonly DispatchRow[]): Map<string, FlagKind[]>` — row id → all kinds: `rowFlags` plus the cross-row kinds: `verify-fail` (for each verifier row with `verdict === 'fail'`: the latest worker row of the same session with `doneAt ≤ verifier.at`), `redispatch` (each row whose id is some row's `redispatchOf`).

Verdict parsing (first match wins, case-insensitive, scan all lines):
```ts
const VERDICT_LINE = /^\s*\**\s*VERDICT\s*\**\s*[:：]\s*\**\s*(PASS|FAIL|PARTIAL)/im
const ZH_LINE = /結論\**\s*[:：]?\s*\**\s*(.*)$/m        // then: 不通過→fail, 部分→partial, 通過→pass
const EN_LINE = /conclusion\**\s*[:：]\s*\**\s*(pass|fail|partial)/im
```
Correction pattern (case-insensitive):
```ts
const CORRECTION = /你不是說|不是叫你|不對|錯了|為什麼沒|為什麼又|又忘|you said|that's wrong|not what i|why didn't you|you forgot/i
```

- [ ] **Step 1: Write the failing tests** in `tests/flags.test.ts`:
  - `parseVerdict reads the VERDICT line`: `'…\nVERDICT: FAIL'`→fail; `'**VERDICT:** pass'`→pass.
  - `parseVerdict falls back to the 結論 line`: `'- **結論**：不通過'`→fail; `'結論：部分未驗證'`→partial; `'結論：通過'`→pass; `'Conclusion: fail'`→fail; `'all good'`→undefined.
  - `isCorrection`: true for `'你不是說要先測試？'`, `'That's wrong'`; false for `'ok, go ahead'`, `'不錯'` (note: `不錯` must not match `錯了`).
  - `tiny`: Explore with 2 tools → `['tiny']`; verifier with 1 tool → `[]`; Explore with 3 tools → `[]`.
  - `heavy`: Explore with in+cw+out = 300 001 → heavy; worker with 1M → not heavy; clerk 11 min → heavy.
  - `tool-errors`: 3 of 10 → flagged; 3 of 11 → not; 2 of 2 → not.
  - `error-end`: reason `refusal` → flagged; `answer` → not.
  - `backfilled rows trip only four kinds`: backfill row with `corrected: true` and `health:['loop']` → neither kind.
  - `verify-fail lands on the latest earlier worker`: worker A done t=10, worker B done t=20, verifier spawned t=25 verdict fail → B flagged, A not; a worker done after the verifier spawned is not flagged.
  - `redispatch flags the previous row`.
- [ ] **Step 2: Run** → FAIL. Paste the output.
- [ ] **Step 3: Implement** `hooks/flags.ts`.
- [ ] **Step 4: Run** tests → PASS; `tsc` → 0.
- [ ] **Step 5: Commit** `feat(jarvis): add the dispatch flag rules`

### Task 3: Lessons — keys, event fold, metrics, texts

**Files:**
- Create: `hooks/lessons.ts`
- Modify: `hooks/i18n.ts` (keys `lesson.*` in both dictionaries)
- Test: `tests/lessons.test.ts`

**Interfaces:**
- Consumes: `DispatchRow`, `FlagKind`, `sessionFlags` (Tasks 1–2).
- Produces:
  - `lessonKey(kind: FlagKind, row: DispatchRow): string` — `${kind}:${row.type}:${row.family}`; for `corrected`, `corrected:${row.type}:*`.
  - `type LessonEventKind = 'approve' | 'memory' | 'memory-error' | 'apply-cancel' | 'applied' | 'reject' | 'revert-request' | 'reverted'`
  - `type LessonEvent = { key: string; kind: LessonEventKind; at: number; session: string; memoryId?: number; file?: string; error?: string }`
  - `type LessonState = 'watching' | 'candidate' | 'approved' | 'applied' | 'rejected' | 'reverted'`
  - `type Measure = { verdict: 'helping' | 'not-helping' | 'unclear' | 'too-early'; beforeRate: number; afterRate: number; beforeN: number; afterN: number }`
  - `type Evidence = { at: number; project: string; desc: string; detail: string }`
  - `type Lesson = { key: string; kind: FlagKind; type: string; family: string; state: LessonState; strikes: number; evidence: Evidence[]; approvedIn?: string; memoryId?: number; memoryError?: string; file?: string; appliedAt?: number; measure?: Measure; revertRequested?: boolean; muted: number }` — `muted` is unused (0) except on hidden rejected/reverted.
  - `const LESSON_DAYS = 30`, `const REOPEN_STRIKES = 3`, `const MEASURE_MIN = 8`, `const INJECT_MAX = 3`
  - `encodeEvents / decodeEvents` (same skip-bad-lines rule as rows).
  - `foldLessons(rows: readonly DispatchRow[], events: readonly LessonEvent[], now: number): Lesson[]`
  - `measureOf(rows: readonly DispatchRow[], key: string, appliedAt: number): Measure`
  - `lessonLine(l: Lesson): string` — i18n `lesson.line`: en `Jarvis lesson ({n}× in 30d): {key} — {text}`.
  - `lessonText(kind: FlagKind, type: string, family: string): string` — i18n `lesson.text.<kind>` (en copy below).
  - `injectLines(lessons: readonly Lesson[], shown: ReadonlyMap<string, number>): { lines: string[]; shown: Map<string, number> }` — candidates only, strikes desc, ≤ `INJECT_MAX`; skip a key whose shown strike count equals its current strikes; returns the updated map.
  - `applyRequest(l: Lesson, file: string): string` and `revertRequest(l: Lesson): string` — i18n `lesson.apply` / `lesson.revert`.
  - `suggestedFile(kind: FlagKind, type: string, home: string, agentFiles: readonly string[]): string` — table in spec §4; `agentFiles` = names present in `${home}/dotfiles/claude/agents/`.
  - `memoryArgv(home: string, l: Lesson): string[]` → `[`${home}/.local/bin/memory-mcp`, 'store', '--json', '-t', 'feedback', '--tags', `jarvis-lesson,${l.kind}`, <lessonText + ' Evidence: ' + first evidence desc>]` (no `--project`).
  - `memoryIdOf(stdout: string): number | undefined` — JSON `id` field, else the first `#?(\d+)` match.

Fold algorithm (per key; events sorted by `at`, ties by file order):
```
strikes(since) = flagged rows of key with at ≥ max(now − 30d, since)
state = none; cut = 0
for ev of events(key):
  approve        → state = approved; approvedIn = ev.session; memoryError = undefined
  memory         → memoryId = ev.memoryId
  memory-error   → memoryError = ev.error
  apply-cancel   → state = none (back to strike-derived)
  applied        → state = applied; appliedAt = ev.at; file = ev.file; revertRequested = false
  reject         → state = rejected; cut = ev.at
  revert-request → revertRequested = true
  reverted       → state = reverted; cut = ev.at; revertRequested = false
if state ∈ {rejected, reverted} and strikes(cut) ≥ 3 → state = none
if state = none → s = strikes(0): s ≥ 2 → candidate, s = 1 → watching, s = 0 → drop the lesson
applied → measure = measureOf(rows, key, appliedAt)
```
Strike counts for `applied` keep counting (shown) but never change the state.

Measure: `rate(rows) = flagged(kind,type,family) / finished(type,family)`; before = `[appliedAt − 30d, appliedAt)`, after = `[appliedAt, now]`; `afterN < 8` → too-early; `afterRate ≤ 0.5·beforeRate` → helping; `afterRate ≥ beforeRate` → not-helping; else unclear. (before rate 0 and after rate 0 → helping.)

En copy for `lesson.text.<kind>` (zh-TW equivalents written by the worker, same meaning):
- tiny: `{type} ({family}) finished with ≤ 2 tool calls; do it yourself when it fits in 3 calls.`
- heavy: `{type} ({family}) used over 300k tokens or 10 min; narrow the brief or pick another agent.`
- redispatch: `a {type} ({family}) task was dispatched again; give the first brief clear acceptance criteria.`
- verify-fail: `a verifier failed {type} ({family}) work; require tests and RED/GREEN output in the brief.`
- loop: `{type} ({family}) looped on one failing tool; tell it to stop and report after 2 failures.`
- stuck: `{type} ({family}) went quiet for 5 min; set a time limit or split the task.`
- tool-errors: `{type} ({family}) hit many tool errors; give exact paths and commands in the brief.`
- error-end: `{type} ({family}) ended with an error, refusal or abort; check the brief and permissions.`
- corrected: `the user corrected the result of a {type} dispatch; restate the goal and check it before reporting.`

`lesson.apply` (en): `Jarvis: the user approved lesson {key} ({n}×): {text} Evidence: {evidence}. Memory #{id}. Add ONE imperative rule (一律 / NEVER) for it to {file}, ending with <!-- ev: #{id} -->, show the diff, then call mcp__jarvis__lesson with op "applied", key "{key}", file "<the file you edited>". If another file fits better, use it and say why.`
`lesson.revert` (en): `Jarvis: lesson {key} is not helping (before {before}, after {after}). Remove its rule line (the one with <!-- ev: #{id} -->) from {file}, show the diff, then call mcp__jarvis__lesson with op "reverted", key "{key}".`

- [ ] **Step 1: Write the failing tests** in `tests/lessons.test.ts`:
  - `one strike watches, two make a candidate`.
  - `strikes older than 30 days do not count`.
  - `approve then applied gives applied with file and appliedAt`.
  - `apply-cancel returns to candidate and keeps the memory id`.
  - `a rejected key reopens only after 3 new strikes` (2 new → rejected; 3 new → candidate).
  - `a reverted key reopens only after 3 new strikes`.
  - `an applied key stays applied while strikes grow`.
  - `measure: too-early under 8 rows; helping at half; not-helping at equal; zero/zero helping`.
  - `injectLines: at most 3, strikes desc, skips keys shown at the same count, re-shows when the count grows`.
  - `suggestedFile follows the spec table` (tiny → `${home}/dotfiles/claude/skills/model-routing/SKILL.md`; verify-fail → `…/agents/worker.md`; loop for Explore with `Explore.md` present → `…/agents/Explore.md`; loop for fork (no file) → model-routing; corrected → `${home}/dotfiles/agents/core.md`).
  - `memoryArgv has no --project and uses the absolute binary`.
  - `memoryIdOf reads JSON id and falls back to #123`; garbage → undefined.
  - `decodeEvents skips bad lines`.
- [ ] **Step 2: Run** → FAIL. Paste the output.
- [ ] **Step 3: Implement** `hooks/lessons.ts` and the i18n keys (both dictionaries).
- [ ] **Step 4: Run** → PASS (including `tests/i18n.test.ts` key parity); `tsc` → 0.
- [ ] **Step 5: Commit** `feat(jarvis): fold lessons from flags and events`

### Task 4: Backfill parser

**Files:**
- Create: `hooks/backfill.ts`
- Test: `tests/backfill.test.ts`

**Interfaces:**
- Consumes: `DispatchRow`, `rowFamily`, `DESC_LEN` (Task 1).
- Produces:
  - `const BACKFILL_DAYS = 14`
  - `backfillRow(meta: string, jsonl: string, ctx: { id: string; session: string; project: string }): DispatchRow | undefined` — from `agent-<id>.meta.json` (`agentType`, `description`, `model`, `requestShape`, `isFork`, `finished`) and `agent-<id>.jsonl`. Undefined when meta is bad JSON or `finished !== true`. `type` = `fork` when `isFork`, else `agentType`. `at` = first line's `timestamp`; `doneAt` = last line's; `durationMs` = difference. Tokens: sum `message.usage` over `type === 'assistant'` lines, counted once per `message.id`. `tools` = count of `tool_use` content blocks; `toolErrors` = count of `tool_result` blocks with `is_error: true`. `reason` = `'answer'`. `backfill: true`.
  - `backfillPlan(home: string, now: number): { projectsDir: string; sinceMs: number }` — `${home}/.claude/projects`, `now − 14d`.
- [ ] **Step 1: Write the failing tests** with inline fixtures: a 4-line jsonl (user, assistant with tool_use + usage, user with tool_result is_error, assistant final with same message.id repeated twice) → tools 1, toolErrors 1, usage counted once per message id, durationMs from timestamps; `finished:false` → undefined; bad meta → undefined; `isFork:true` → type `fork`; `model:'opus'` → family opus.
- [ ] **Step 2: Run** → FAIL. Paste.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `tsc` → 0.
- [ ] **Step 5: Commit** `feat(jarvis): parse past subagent transcripts for backfill`

### Task 5: Per-agent health signals

**Files:**
- Modify: `hooks/jarvis.ts:437-596` (`looping`, `healthOf`)
- Test: `tests/jarvis.test.ts` (new `describe('per-agent health')`)

**Interfaces:**
- Produces:
  - `loopActors(events: readonly JarvisEvent[], live: ReadonlySet<string>): string[]` — the subagent actors (not main) whose last `LOOP_FAILS` events are the same failing tool.
  - `stuckAgents(agents: readonly JarvisAgent[], events: readonly JarvisEvent[], inflight: readonly JarvisInflight[], now: number): string[]` — running subagents with no in-flight call of their own whose own last activity (`max(runStartedAt, ev.ts + ev.ms of their events)`) is older than `STUCK_MS`.
  - `healthOf` keeps its signature and behaviour (`looping` now built on the same per-actor scan; main-loop loops still return `'loop'`).
- [ ] **Step 1: Write the failing tests**: two subagents, one with 3 same failing Bash → `loopActors` = [that id]; main-loop loop → not in `loopActors` but `healthOf` = 'loop' (existing tests stay green); `stuckAgents` flags a running agent idle 5 min + 1 ms, not one with an in-flight call, not a finished one, not the main loop.
- [ ] **Step 2: Run** → FAIL. Paste.
- [ ] **Step 3: Implement** in `hooks/jarvis.ts`.
- [ ] **Step 4: Run** the full suite → PASS (all existing `healthOf` tests unchanged); `tsc` → 0.
- [ ] **Step 5: Commit** `feat(jarvis): name the looping and stuck subagents`

### Task 6: Keep a subtask's earlier agents

**Files:**
- Modify: `types/index.d.ts:81-90` (`JarvisSubtask`), `hooks/tasks.ts:187-192`
- Test: `tests/tasks.test.ts`

**Interfaces:**
- Produces: `JarvisSubtask.prevAgents?: string[]` — when an update sets an `agent` different from the current `agentId`, the old id is appended (no duplicates, max 5).
- [ ] **Step 1: Write the failing test** `an update with a new agent keeps the old one in prevAgents`; and `the same agent again changes nothing`.
- [ ] **Step 2: Run** → FAIL. Paste.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full suite → PASS; `tsc` → 0.
- [ ] **Step 5: Commit** `feat(jarvis): remember a subtask's earlier agents`

### Task 7: The session recorder (`learn.ts`)

**Files:**
- Create: `hooks/learn.ts`
- Test: `tests/learn.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `ChangesIo` type (`{ stat, read, write, run }`, declared in `hooks/changes.ts:8`; built by `ioOf` in `register.tsx`).
- Produces `createLearn(io: ChangesIo & { list: (dir: string) => Promise<{ name: string; kind: string }[]> }, opts: { home: string; session: string; project: string; agentFiles?: string[] }): Learn` with:
  - `spawn(s: { id: string; type: string; model: string; background: boolean; desc: string; promptLen: number; at: number }): void`
  - `tool(id: string, ok: boolean): void` — counts `tools` / `toolErrors` for a subagent row.
  - `finish(id: string, c: { reason: string; durationMs: number; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; model?: string }; answer: string; cost?: number }, now: number): void` — accumulates; sets `verdict` via `parseVerdict` when the row's type is `verifier`.
  - `health(loop: readonly string[], stuck: readonly string[]): void` — adds `loop` / `stuck` to `row.health` (once each).
  - `subtask(agentId: string, subtaskId: string, prevAgentId?: string): void` — sets `subtask` and `redispatchOf`.
  - `prompt(text: string, now: number): void` — when `isCorrection(text)`, marks `corrected` on rows finished since the previous `prompt()` call and within `FLAG_RULES.correctionMs`.
  - `flush(now: number): Promise<void>` — writes this session's rows grouped by `dayKey(at)` to their files and this session's lesson events; no-op when nothing changed. Callers debounce (2 s) via `due(now): boolean`.
  - `due(now: number): boolean` — dirty and ≥ 2 s since the last flush.
  - `load(now: number, force?: boolean): Promise<void>` — reads all day dirs within 60 days + all lesson files; skipped when < 60 s since the last load unless `force`; runs retention once per session: `io.run(['/bin/rm', '-rf', dir])` for each `expiredDays` name (names already validated). Missing dirs read as empty.
  - `backfill(now: number): Promise<number>` — when no loaded row is older than today and no `backfill.jsonl` exists in any loaded day dir: scan `projects/*/<session>/subagents/` (via `io.list`) for `agent-*.meta.json` with mtime ≥ now − 14d, build rows, write them to `<day>/backfill.jsonl`; returns the count.
  - `lessons(now: number): Lesson[]` — `foldLessons(dedupe(loaded ∪ own rows), loaded ∪ own events, now)`.
  - `health14(now: number): HealthRow[]`
  - `inject(now: number): string[]` — `injectLines` lines, plus the pending apply / revert request (once) for lessons this session approved / asked to revert.
  - `approve(key: string, now: number): Promise<void>` — event `approve`; runs `memoryArgv` via `io.run`; on exit 0 with an id → event `memory`; else event `memory-error` with stderr or `'no id'`; queues the apply request for this session only.
  - `reject(key: string, now: number): void`, `cancel(key: string, now: number): void` (event `apply-cancel`), `retry(key: string): void` (re-queues the apply request), `requestRevert(key: string, now: number): void`.
  - `toolCall(input: Record<string, unknown>, now: number): string` — the `mcp__jarvis__lesson` handler: `list` → text of candidate + applied lessons (key, state, strikes, measure); `applied` (needs `key`, `file`; state must be `approved`) → event `applied`; `reverted` (state `applied` with revert requested) → event `reverted`; anything else → an error string starting with `error:`.
  - `turnEnded(): void` — a main turn ended: a queued apply request that was injected and got no `applied` becomes `waiting` (`lessons()` shows it via `Lesson.state === 'approved'` and `waiting` true on the view model: add `waiting?: boolean` to `Lesson` here).
- [ ] **Step 1: Write the failing tests** with a fake in-memory io (a `Map<string,string>` of files; `run` records argv and returns a canned result):
  - `spawn, tool, finish produce one finished row with tokens and counts`.
  - `a verifier's VERDICT line sets its verdict`.
  - `flush writes only this session's file, grouped by spawn day`.
  - `load merges other sessions and dedupes`; `load skips within 60 s unless forced`.
  - `retention removes only expired day dirs` (argv `['/bin/rm','-rf', <home>/.claude/jarvis/ledger/2026-08-01]`).
  - `a correction prompt marks rows finished since the last prompt` and `not after 15 min`.
  - `only the approving session gets the apply request` (two `createLearn` on one fake fs; B's `inject` has no apply request; B's `lessons` show `approved`).
  - `memory store failure keeps approved with error` (exit 1) and `memoryId set on success` (stdout `{"id":1901}`).
  - `the apply request is injected once; after turnEnded without applied the lesson is waiting; retry injects again`.
  - `toolCall applied moves approved to applied; applied on a candidate is an error`.
  - `no home records nothing and never throws` (`home: ''` → flush/load/approve resolve, no writes).
  - `backfill writes backfill.jsonl once`.
- [ ] **Step 2: Run** → FAIL. Paste.
- [ ] **Step 3: Implement** `hooks/learn.ts`. Every io failure is caught; nothing throws to callers.
- [ ] **Step 4: Run** → PASS; `tsc` → 0.
- [ ] **Step 5: Commit** `feat(jarvis): record dispatches and lessons per session`

### Task 8: Wire the recorder into the hooks

**Files:**
- Modify: `hooks/register.tsx` (session.start ~1008, agent.spawn ~1296, tool.call task ~1354, tool.call ~1370, turn.complete ~1499, prompt.submit ~1569, tick), `types/index.d.ts:310-312` (`McpToolInputs.mcp__jarvis__lesson: Record<string, unknown>`), `hooks/tasks.ts` or a new `LESSON_TOOL_SPEC` export in `hooks/lessons.ts`
- Test: `tests/learnHooks.test.ts`

**Interfaces:**
- Consumes: `createLearn`, `Learn` (Task 7), `loopActors`, `stuckAgents` (Task 5), `JarvisSubtask.prevAgents` (Task 6).
- Produces: a module-level `learn: Learn | undefined` in register's closure, created at `session.start` once `home`, `$.session.id()` and `cwd` are known (project = cwd basename); `LESSON_TOOL_SPEC` (name `lesson`, description and schema via i18n `lesson.tool.*`: `op` enum `list|applied|reverted`, `key` string, `file` string).
- Wiring (each call wrapped in try/catch, "bookkeeping only"):
  - `session.start`: create learn; `$.tool.register(LESSON_TOOL_SPEC)`; `await learn.load(now, true)`; `void learn.backfill(now)`.
  - `agent.spawn` after `next`: `learn.spawn({ id, type: e.fork ? 'fork' : e.subagentType, model, background: e.background === true, desc: e.description, promptLen: e.prompt?.length ?? 0, at: now })`.
  - `tool.call` (generic) `finally`: for a subagent call (`id !== undefined`) `learn.tool(id, ok)`.
  - `tool.call` for `mcp__jarvis__task`: before the board write, read the subtask's current `agentId`; after a successful write, if the input had `agent` and it differs, `learn.subtask(agent, id, previous)`.
  - `on('tool.call', { tool: 'mcp__jarvis__lesson' })` → `{ result: learn.toolCall(input, now) }`, or `{ deny }` when it starts with `error:`.
  - `turn.complete`: subagent → `learn.finish(id, { reason, durationMs, usage, answer: e.answer, cost })` (cost = `costAt(tokens, family)` from `hooks/jarvis.ts` when the family is known); main → `learn.turnEnded()`. Then `if (learn.due(now)) void learn.flush(now)`.
  - tick (the existing periodic tick): `learn.health(loopActors(events, live), stuckAgents(agents, events, inflight, now))`; `if (learn.due(now)) void learn.flush(now)`.
  - `prompt.submit`: `learn.prompt(e.text, now)`; `const extra = learn.inject(now)`; append `extra.join('\n')` as one context string when non-empty — on **both** paths (the early `return next(e)` path and the request path).
  - `session.end`: `await learn.flush(now)`.
- [ ] **Step 1: Write the failing engine tests** (style of `tests/tasks.test.ts`, full required inputs): spawn + tool calls + turn.complete → after a forced flush the fake fs (stub `$.fs` / `$.process` per existing test helpers) holds one row for this session; `prompt.submit` with two `tiny` strikes loaded carries the `Jarvis lesson (2× in 30d): tiny:Explore:haiku — …` context line, and does not carry it on the next prompt; `mcp__jarvis__lesson` `list` returns text; `applied` on a non-approved key is denied.
- [ ] **Step 2: Run** → FAIL. Paste.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4: Run** CLI and Desktop `plugin test .` → PASS, no `refused` / `is not allowed`; `tsc` → 0.
- [ ] **Step 5: Commit** `feat(jarvis): feed the learning loop from the hooks`

### Task 9: Terminal Lessons tab

**Files:**
- Create: `hooks/lessonsView.ts`
- Modify: `types/index.d.ts:229` (`| 'lessons'`), `hooks/cockpit.tsx` (`TABS` after tasks; `Ctx` gains `lessons?: LessonsView` and `lessonAct?: (op: 'approve' | 'reject' | 'cancel' | 'retry' | 'revert', key: string) => void`; render branch `page === 'lessons'`), `hooks/icons.ts` (`TAB_ICON.lessons = ''`), `hooks/i18n.ts` (`tab.lessons`: 教訓 / Lessons; all view strings), `hooks/register.tsx` (page data at ~1699: when `page === 'lessons'`, `await learn.load(now)` then `{ health: learn.health14(now), lessons: learn.lessons(now), ledgerPath }`; `lessonAct` calls the matching `learn` method inside `onPress`, then `flush`).
- Test: `tests/lessonsView.test.ts`

**Interfaces:**
- Produces: `type LessonsView = { health: HealthRow[]; lessons: Lesson[]; ledgerPath: string }`; `lessonsLines(v: LessonsView, cols: number): Seg[][]` (pure, for tests) and the cockpit block that renders it with Buttons.
- Layout (spec §8): section **Dispatch health** (header row; one row per `HealthRow`: type, family, runs, median, p90, mean tokens, flag rate %, top flag; flag rate ≥ 20% in `THEME.error`); section **Lessons**: candidates (key, `n×`, evidence lines, `[Approve] [Reject]`), approved (`waiting` → `[Retry] [Cancel]`; approved in another session → read-only "approved in another session"; `memoryError` → `[Retry]` with the error), applied (before → after %, n, verdict; `[Revert]` when not-helping), watching (one dim line each), then `+N rejected / reverted` count. Empty: `No dispatches recorded yet` + ledger path. Narrow widths (< 64 cols) drop the p90 and mean-token columns.
- [ ] **Step 1: Write the failing tests**: tab list includes `lessons` with its label in both locales; empty state text; health row highlighted at 20%; a candidate draws Approve and Reject Buttons; pressing Approve calls `lessonAct('approve', key)`; narrow layout drops p90; `drawOn($,'terminal')` on the lessons page renders without throwing.
- [ ] **Step 2: Run** → FAIL. Paste.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** CLI + Desktop `plugin test .` → PASS, no `refused` / `is not allowed`; `tsc` → 0.
- [ ] **Step 5: Commit** `feat(jarvis): add the Lessons tab`

### Task 10: Desktop Lessons page

**Files:**
- Modify: `hooks/desktopPagesA.tsx` (`drawPageA` dispatch + `lessonsPage(kit)`), `hooks/desktopView.tsx` (if its page list needs `lessons`), `hooks/desktopIcons` mapping if tabs need a desktop icon (follow how `tasks` is done)
- Test: `tests/desktopPagesA.test.ts`

**Interfaces:**
- Consumes: `LessonsView`, `ctx.lessonAct` (Task 9).
- [ ] **Step 1: Write the failing tests**: `drawOn($,'desktop')` on the lessons page shows the two section headers and an Approve Button; every Text prop is in `tests/allowedProps.ts`.
- [ ] **Step 2: Run** → FAIL. Paste.
- [ ] **Step 3: Implement** with `kit.card` / `kit.head` like `tasksPage`.
- [ ] **Step 4: Run** CLI + Desktop `plugin test .` → PASS, no `refused` / `is not allowed`; `tsc` → 0.
- [ ] **Step 5: Commit** `feat(jarvis): draw the Lessons page on Desktop`

### Task 11: README and the verifier's verdict line

**Files:**
- Modify: `README.md` (tab table: a **Lessons** row; "Other details": the ledger path and that nothing is edited without Approve)
- Modify (outside the repo): `~/dotfiles/claude/agents/verifier.md` — under 回報格式 add: `- 最後一行一律寫 \`VERDICT: PASS\`、\`VERDICT: FAIL\` 或 \`VERDICT: PARTIAL\`（給 Jarvis 解析）。`
- [ ] **Step 1:** Edit README; commit in the worktree `docs: describe the Lessons tab`.
- [ ] **Step 2:** Edit `verifier.md`; commit in `~/dotfiles` with `/usr/bin/git -C ~/dotfiles add claude/agents/verifier.md && /usr/bin/git -C ~/dotfiles commit -m "verifier: end reports with a VERDICT line"`. Do not push.
- [ ] **Step 3:** Run `claude plugin test .` once more → PASS.

### Task 12: Whole-branch gate

- [ ] **Step 1:** `npx -p typescript tsc --noEmit -p .` → 0 errors.
- [ ] **Step 2:** CLI `claude plugin test .` and Desktop binary `plugin test .` → all pass; `grep -c "refused\|is not allowed"` on both outputs → 0.
- [ ] **Step 3:** `/usr/bin/git log --oneline main..HEAD` lists the task commits; `/usr/bin/git status --short` clean.
