# Changelog — Changes from BenjaminBilbro/pi-subagent

This fork adds improvements focused on local LLM usage (2-10 tok/s), timeout recovery, and eliminating file pollution.

**Base:** `BenjaminBilbro/pi-subagent` @ commit `221c382`  
**Branch:** `changes-from-bilbro`

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
