# Changelog — Changes from BenjaminBilbro/pi-subagent

This fork adds improvements focused on local LLM usage (2-10 tok/s), timeout recovery, and eliminating file pollution.

**Base:** `BenjaminBilbro/pi-subagent` @ commit `221c382`  
**Branch:** `changes-from-bilbro`

---

## Unreleased — local-hosting hardening pass

Found by auditing failed sub-agent calls across 173 local sessions (16 × `hit max turns`,
4 × `timed out (exit 124)`, 2 × `failed (exit 130)`, plus unbounded parallel fan-out).

| Area | File | Change |
|---|---|---|
| Wall-clock budget | `runner.ts` | `timeout` is enforced again as a hard deadline (`SIGTERM` → 5.5 s → `SIGKILL`) **in addition to** the 120 s silence watchdog. Buffered stdout is flushed before the kill so partial output survives. Trips report `stopReason: "timeout"`, `exitCode: 124`, and a message naming the budget. |
| Derived budget | `runner.ts` | When the caller omits `timeout`, the cap is now `min(10s × maxTurns, 1h)` instead of a flat 1 h. (The `subagent` tool still passes 600 s explicitly by default.) |
| One deadline for retries | `runner.ts` | The SIGTERM retry loop used to arm a fresh deadline per attempt — worst case 3 × the requested budget. `deadlineAt` is now computed once; each attempt gets the remaining window, backoff is clamped to it, and retries are skipped when < 15 s remains. |
| Turn budget enforced | `runner.ts` | `max_turns` now kills the child (`bailOut()`); previously the flag was recorded and the runner kept waiting for the child to finish by itself. |
| Recursion guard | `runner.ts`, `index.ts`, `types.ts` | Children get `PI_SUBAGENT_CHILD=1`; `index.ts` refuses `subagent` calls when that marker is set, and the runner kills a child that emits a `subagent` tool call (`stopReason: "subagent_recursion_blocked"`, also listed in `isResultRecoverable`). |
| Abort | `runner.ts` | `opts.signal` is finally honoured: abort flushes buffered output, records `exitCode: 130` + partial text, kills the child, and resolves — instead of `Subagent was aborted` with `(no output)` and an orphaned process. |
| Guaranteed resolution | `runner.ts` | Every kill path arms one `scheduleFinish()` fallback (cleared in `clearTimers()`), so the promise cannot strand; `finish()` no longer leaves `exitCode: -1` behind. All four timer handles are cleared on settle. |
| Heartbeat | `runner.ts` | New 10 s `onUpdate` heartbeat printing `running 42s · 7 turns · last tool: bash`. Before this the only updates came from child events, so one slow turn looked like a frozen agent. |
| Model pinning | `runner.ts` | Child receives `--provider/--model/--thinking` derived from the parent session, because pi does *not* read `PI_PROVIDER`/`PI_MODEL`/`PI_REASONING_LEVEL` — previously every child silently ran on the `settings.json` default (observed: parent on `mac`/104, children on `linux`/109). `PI_SUBAGENT_MODEL` / `PI_SUBAGENT_PROVIDER` / `PI_SUBAGENT_THINKING` override. |
| Child env | `runner.ts` | Parent session identity vars (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`) are stripped — the same list pi's bash tool strips — so the child does not believe it is the parent session. |
| Bounded stderr | `runner.ts` | stderr collection capped at 64 KB with a truncation marker. |
| Concurrency | `index.ts` | `acquireSlot()`/`releaseSlot()` gate, `PI_SUBAGENT_MAX_PARALLEL` default **1**: one child at a time, extra calls get a `queued: waiting for a free sub-agent slot` update. Self-hosted servers cannot afford parallel children (measured 17 s/turn solo vs ~60 s/turn each with 3 in flight). |
| Honest instructions | `index.ts` | Dropped the false "sub-agent receives the full session context" claims; the tool description and injected instructions now state that a child starts an empty session, inherits provider+model+tools except `subagent`, runs one at a time, and that `timeout`/`maxTurns` are hard kills. |
| Error hints | `index.ts` | `explainChildFailure()` turns the three mystery errors from the session audit into hints: `404` → provider/model not served there; `422` → server rejected the body (usually context overflow, often a high thinking level); `Connection error.`/`ECONNREFUSED`/`fetch failed` → server unreachable. |
| Small cleanup | `index.ts` | `const texts: string[]` (was inferring `never[]`). |

Behaviour changes worth knowing: `timeout` now means *silence **or** wall clock, whichever comes
first* instead of silence only; a child now **dies** at its turn budget; sub-agents run on the
parent's provider+model instead of the settings default; and parallel `subagent` calls queue
instead of all running at once.

---

## Commits (newest first)

### 1. `refactor(index): remove session forking, add partial output recovery, update instructions`

**File:** `index.ts`

**Execute handler:**
- Removed `buildForkSessionSnapshotJsonl()` and `SessionSnapshotSource` interface
- Subagent now runs fresh pi process (`--no-session`), no session snapshot passed
- Default timeout: `120s` → `600s` (consistent with schema documentation)
- Removed `forkSessionSnapshotJsonl` from `runAgent()` call
- Removed debug `console.error` statement

**Partial output recovery:**
- **Timeout handler:** Returns partial text + turn count + actionable split-and-retry guidance with code examples
- **Max turns handler:** Returns ALL accumulated assistant text (via `getAllAssistantText`) + recovery guidance
- **Generic error path:** Uses `getAllAssistantText()` for full output instead of last-message-only
- **Success path:** `getAllAssistantText()` captures structured output from earlier messages

**jiti workaround:**
- Inlined `getAllAssistantText()` locally instead of importing from `.js` file (jiti CJS/ESM interop caches stale export bindings)

**SUBAGENT_INSTRUCTIONS updates:**
- Removed generic "When to Use" section (covered by skill)
- Added timeout rule with formula (`maxTurns × 10s = min timeout`)
- Added timeout recovery guidance (partial output preserved, split/retry)
- Added subagent mode rules: no quests, no parallel calls, final message must contain full output
- Added skill pointer (`/skill:subagent`)

---

### 2. `fix(render): check stopReason instead of truthy maxTurns for icon`

**File:** `render.ts`

- `statusIcon()` checked `if (r.maxTurns)` which was always truthy (number value like 50)
- Showed max-turns icon on every result regardless of actual completion
- Fixed to check `if (r.stopReason === "max_turns")`

---

### 3. `feat(events): add getAllAssistantText to collect all assistant messages`

**Files:** `runner-events.js`, `test/runner-events.test.mjs`

- New exported function collects text from ALL assistant messages across the entire run
- Previous behavior: only last assistant message was returned
- Problem: structured output (tables, research findings) often in earlier messages while last message is just "Done."
- Added 3 unit tests: collects from all messages, returns empty for non-array input, skips non-text content

---

### 4. `refactor(runner): replace wall-clock timeout with heartbeat + eliminate session forking`

**File:** `runner.ts`

**Timeout changes:**
- Replaced single `setTimeout` with two timers:
  1. **silenceTimer (120s)** — resets on each JSON event line. Only kills if subagent goes silent (crashed/stuck), not when making progress
  2. **maxExecutionTimer (1hr)** — absolute safety net for runaway processes
- Flush buffered output before kill to preserve partial results
- Removed `exceededMaxTurns` dead code variable
- Deprecated `timeout` parameter (no longer used as wall-clock)

**Session changes:**
- Eliminated `--session` forking entirely. Child runs fresh pi process with `--no-session`
- Inherits model+tools via CLI args only
- Removed `writeForkSessionToTempFile()`, `cleanupTempDir()`
- Removed `fs`/`os`/`path` imports (no longer needed)
- **Result:** Zero temp files created anywhere

**Stderr fix:**
- Strip control characters (bell `\u0007`, escape sequences) from stderr chunks
- `pi --mode json -p` outputs bell chars that polluted error detection

---

### 5. `fix(types): fix maxTurns false positive exitCode=1 and boolean type bug`

**File:** `types.ts`

- `SingleResult.maxTurns` typed as `boolean` but used as `number` at runtime
- `normalizeCompletedResult()` checked `if (result.maxTurns)` which was always truthy when set
- Every subagent got `exitCode=1` and `stopReason="max_turns"` regardless of normal completion
- Fixed condition: `if (result.maxTurns && result.usage.turns >= result.maxTurns)`

---

## Summary of Changes by Category

| Category | Bilbro's Fork | This Fork |
|----------|--------------|-----------|
| **Timeout mechanism** | Wall-clock (fixed N seconds) | Heartbeat (120s silence) + 1hr absolute max |
| **Session handling** | Forked session JSONL → temp file → cleanup | Fresh process, `--no-session`, zero files |
| **Timeout recovery** | Hard error, messages discarded | Partial output preserved + actionable guidance |
| **Max turns recovery** | Generic error, last message only | All accumulated text + split-and-retry guidance |
| **Output extraction** | Last assistant message only | All assistant messages concatenated |
| **Default timeout** | Schema says 600s, code uses 120s (mismatch) | Consistent 600s in schema (runner uses heartbeat) |
| **maxTurns type** | `boolean` (wrong) | `number` (correct) |
| **maxTurns check** | `if (result.maxTurns)` — always true | `if (result.maxTurns && result.usage.turns >= result.maxTurns)` |
| **stderr handling** | Raw (includes bell chars) | Control chars stripped |
| **SUBAGENT_INSTRUCTIONS** | Generic best practices | Timeout rules, recovery guidance, mode rules, skill pointer |
| **Dead code** | `exceededMaxTurns` declared, never set | Removed |
