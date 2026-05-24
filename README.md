# Pi Subagent for LocalLLMs

Forked from [BenjaminBilbro/pi-subagent](https://github.com/BenjaminBilbro/pi-subagent), itself forked from [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent). I fully acknowledge that my fork is pure unadulterated AI slop, for my own personal use. Use or adapt at your own risk.

**Delegate tasks to isolated sub-agents running in separate `pi` processes.**

This extension is designed for local LLM users (llama.cpp, 2-10 tok/s) who need KV cache preservation and robust timeout handling. It adds significant improvements over the upstream fork — see [Changes From Upstream](#changes-from-upstream) below.

## Motivation Behind Local Sub-Agents

Local LLMs build up a unique KV token cache throughout a conversation. If the input/output chain looks like:

```
i1 -> o1 -> i2 -> o2 -> i3 -> o3
```

Then for `i4`, we MUST preserve the prefix starting from `i1`. If you modify the system prompt or strip context, llama.cpp discards the cached KV state and reprocesses everything from scratch — at 200-300 token/s on consumer hardware, that's painful.

**The solution:** sub-agents inherit the exact same system prompt as the main agent. No modifications, no context stripping. The task is delivered as a user message. This way:

- `i1` (system prompt) never changes → prefix match preserved
- Main agent's KV cache stays valid before, during, and after the sub-agent run
- llama.cpp finds the prefix match and only forward-passes the new tokens

## Changes From Upstream

This fork addresses issues discovered through real-world use with slow local LLMs. Here's what changed and why:

### Heartbeat-Based Timeout (replaces wall-clock)

**Problem:** A fixed wall-clock timeout kills sub-agents that are making steady progress. Long research tasks (many web searches at 2-10 tok/s) hit the timeout even though they're working fine.

**Solution:** Two-tier timeout:
- **Silence timer (120s):** Resets on every JSON event line. Only fires if the sub-agent goes silent (crashed/stuck). A productive sub-agent never hits this.
- **Absolute max (1 hour):** Safety net for truly runaway processes.

### Zero Temp Files (eliminates session forking)

**Problem:** Forking the parent session to a temp file (`/tmp/pi-subagent-*`) created disk pollution. If the process crashed, files leaked. Child pi processes also created their own session files.

**Solution:** Sub-agents run as fresh `pi` processes with `--no-session`. They inherit model and tools via CLI args only. Task is self-contained. No files created anywhere.

> **Trade-off:** The child doesn't see parent conversation history. Tasks must be descriptive enough to stand alone. For most use cases (research, code analysis, file operations) this works well since the child has full tool access.

### Partial Output Recovery on Failure

**Problem:** When a sub-agent timed out or hit max turns, all accumulated work was discarded. The main agent saw only `"Sub-agent timed out after 300s"` — no partial results, no guidance.

**Solution:** On timeout or max turns:
- Flush any buffered output before killing the child
- Return ALL assistant text collected so far (not just the last message)
- Include turn count and actionable recovery guidance ("split into smaller subtasks")

### Full Output Extraction (all messages, not just last)

**Problem:** `getFinalAssistantText()` returned only the last assistant message. Sub-agents that output structured data (tables, research findings) in earlier messages followed by a short "Done." summary lost everything.

**Solution:** `getAllAssistantText()` concatenates text from ALL assistant messages across the entire run. Success path and error path both use this.

### Bug Fixes

| Bug | Impact | Fix |
|-----|--------|-----|
| `maxTurns` typed as `boolean`, used as `number` | Every sub-agent got `exitCode=1` and `stopReason="max_turns"` regardless of actual completion | Type corrected to `number`; check now verifies `turns >= maxTurns` |
| stderr bell char (`\u0007`) pollution | Control chars from `pi --mode json -p` interfered with error detection | Strip control characters in stderr handler |
| TUI always showed max-turns icon | `if (r.maxTurns)` was truthy for any number value | Check `if (r.stopReason === "max_turns")` instead |
| Dead `exceededMaxTurns` variable | Declared but never set to `true` | Removed |

### Improved Sub-Agent Instructions

The auto-injected system prompt instructions now include:
- Timeout rule with formula (`maxTurns × 10s = min timeout`)
- Timeout recovery guidance (partial output preserved, split-and-retry pattern)
- Sub-agent mode rules: no quest tool (IDs meaningless), no parallel tool calls (MCP transport limitation), final message must contain full output

## Install

```bash
pi install git:github.com/PadraigOreilly251/pi-subagent
```

### Manual Installation

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/PadraigOreilly251/pi-subagent.git
cd pi-subagent
npm install
```

## Usage

### The `subagent` Tool

```typescript
subagent({
  name: "researcher",     // Freeform name (human-like, for your reference)
  task: "Research the latest about quantum computing",
  timeout: 600,           // Optional: max seconds (default: 600). Local LLMs slow — set generous.
  maxTurns: 50,           // Optional: max LLM turns (default: 50)
  cwd: "/path/to/dir"     // Optional: working directory
})
```

There is no option to specify a model. It always uses the current session's model.

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `name` | Yes | — | Freeform human-like name. Used for display only. |
| `task` | Yes | — | Task description. Make it self-contained — child doesn't see parent conversation. |
| `timeout` | No | 600 | Maximum silence time in seconds before assuming stuck. Not wall-clock — resets on activity. |
| `maxTurns` | No | 50 | Maximum number of LLM turns the sub-agent can make. |
| `cwd` | No | Parent cwd | Working directory for the sub-agent process. |

> **Timeout tip:** Formula is `maxTurns × 10s = min timeout`. For deep research: `maxTurns: 50, timeout: 600`.

### On Timeout or Max Turns

If the sub-agent times out or hits max turns, you get back:
1. All text the sub-agent produced before failure
2. Turn count and stop reason
3. Actionable guidance to split the task into smaller subtasks

This lets you recover partial work instead of starting from scratch.

## How It Works

**What Gets Sent to Sub-Agents:**

```
[Fresh pi process, --no-session]
[Same system prompt as the main agent (inherited via CLI)]

User: [sub-agent-task] Complete this task:
{task description}
```

**What Comes Back to the Main Agent:**

| Data | Main Agent Sees | TUI Shows |
|------|-----------------|-----------|
| Final text output (all messages) | ✅ Yes | ✅ Yes |
| Tool calls made by sub-agent | ❌ No | ✅ Yes (expanded view) |
| Token usage / cost | ❌ No | ✅ Yes |
| Error messages + partial output | ✅ Yes (on failure) | ✅ Yes |

## Features

- **Heartbeat Timeout** — Kills only on silence (stuck/crashed), not on slow progress. 120s silence threshold + 1hr absolute max.
- **Zero File Pollution** — No temp files, no session forking. Clean execution.
- **Partial Output Recovery** — On timeout or max turns, all accumulated text is returned with recovery guidance.
- **Full Output Extraction** — Text from ALL assistant messages, not just the last one.
- **Auto-Injection** — Sub-agent instructions injected into system prompt at startup (constant text, KV cache stable).
- **Recursion Guard** — Sub-agents cannot spawn further sub-agents. Enforced at runner level.
- **Streaming Updates** — Watch sub-agent progress in real-time.
- **Rich TUI Rendering** — Collapsed/expanded views with usage stats and tool call previews.

## Example of it working

Ask the main agent to spawn a sub-agent:

![Sub-Agent Example](static/sub-agent-example.png)

The sub-agent recognizes its in sub-agent mode and begins its assigned task:

![Sub-Agent Example 2](static/sub-agent-example-2.png)

This is right when the sub-agent finished. From the llama.cpp logs it reverted all the way back from the kv slot with 43k tokens to the kv slot state it was before the sub-agent invocation:

![Agent Handoff Example](static/agent-handoff-example.png)

You can see all the files that the sub-agent read, and the final message returned to the main agent. The sub-agent grew the kv cache all the way to 44k tokens, but after llama.cpp restored, the main agent remains at 6k tokens and responded immediately. It only had to process the sub-agent message.

![Final Result Example](static/final-result-example.png)

## Project Structure

```
index.ts          — Extension entry point: tool registration, auto-injection, execution
runner.ts         — Process runner: spawns `pi` subprocesses, heartbeat timeout, zero-file design
runner-cli.js     — Parent CLI inheritance: parses and normalizes flags forwarded to child processes
runner-events.js  — Event parser: processes Pi JSON mode events, enforces maxTurns and recursion guard
render.ts         — TUI rendering: renderCall and renderResult for the subagent tool
types.ts          — Shared types and pure helper functions
CHANGELOG.md      — Detailed changelog of changes from upstream fork
test/             — Unit tests for runner-events and CLI parsing
```

## Attribution

- Upstream fork: [BenjaminBilbro/pi-subagent](https://github.com/BenjaminBilbro/pi-subagent)
- Original: [mjakl/pi-subagent](https://github.com/mjakl/pi-subagent)

## License

MIT
