# Pi Subagent

**Delegate tasks to isolated sub-agents with full context inheritance.**

Sub-agents run in separate `pi` processes and inherit your complete conversation history and system prompt. This preserves KV cache efficiency while offloading heavy work.

## Why Pi Subagent

**KV Cache Preservation** — Sub-agents inherit the full session context via a JSONL snapshot. The system prompt is never modified at runtime, so llama.cpp can reuse the existing KV cache.

**Context Efficiency** — Sub-agents do all the heavy lifting (reading files, running commands, synthesizing information). You receive only the final result, keeping your context window lean.

**Recursive Prevention** — Sub-agents cannot spawn further sub-agents. This is enforced at the runner level (code, not just a system prompt instruction).

## Install

```bash
pi install git:github.com/BenjaminBilbro/pi-subagent
```

### Option 3: Manual Installation

Clone this repository to your Pi extensions directory:

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/mjakl/pi-subagent.git
cd pi-subagent
npm install
```

## Usage

### The `subagent` Tool

```typescript
subagent({
  name: "researcher",     // Freeform name (human-like, for your reference)
  task: "Research the latest about quantum computing",
  timeout: 180,           // Optional: max seconds (default: 120)
  maxTurns: 80,           // Optional: max LLM turns (default: 50)
  cwd: "/path/to/dir"     // Optional: working directory
})
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `name` | Yes | — | Freeform human-like name (e.g., "researcher", "analyst"). Used for display only. |
| `task` | Yes | — | Task description. The sub-agent receives the full session context. |
| `timeout` | No | 120 | Maximum execution time in seconds. |
| `maxTurns` | No | 50 | Maximum number of LLM turns the sub-agent can make. |
| `cwd` | No | Parent cwd | Working directory for the sub-agent process. |

### How It Works

**What Gets Sent to Sub-Agents:**

```
[Forked snapshot of current session context — identical to parent]
[Same system prompt as the main agent]

User: [sub-agent-task] Complete this task:
{task description}
```

**What Comes Back to the Main Agent:**

| Data | Main Agent Sees | TUI Shows |
|------|-----------------|-----------|
| Final text output | ✅ Yes | ✅ Yes |
| Tool calls made by sub-agent | ❌ No | ✅ Yes (expanded view) |
| Token usage / cost | ❌ No | ✅ Yes |
| Error messages | ✅ Yes (on failure) | ✅ Yes |

**Key point:** The main agent receives **only the final assistant text** from each sub-agent. Not the tool calls, not the reasoning, not the intermediate steps. This prevents context pollution while still giving you the results.

## System Prompt Requirements

This extension auto-injects sub-agent instructions into the system prompt at runtime. The injected text is **constant** (never changes), so KV cache stability is preserved.

If you want to understand what gets injected, the extension adds these instructions:

```markdown
## Sub-Agent Tools/Extension

You can delegate tasks to sub-agents running in isolated processes using the `subagent` tool.

### How Sub-Agents Work
- **Full context inheritance** — Sub-agents receive your complete conversation history and the same system prompt.
- **Isolated processes** — Each sub-agent runs in its own `pi` process with `PI_OFFLINE=1`.
- **No recursion** — Sub-agents are explicitly forbidden from spawning further sub-agents. This is enforced at the runner level.
- **Same model** — Sub-agents use the same model as the main agent.
- **Results** — You receive only the final assistant text from each sub-agent.

### When to Use Sub-Agents
- Do heavy research across many files without polluting your context
- Run long-running tasks that would consume your context window
- Offload specialized work while you continue other tasks
- Preserve context efficiency by keeping only summaries in your context

### Calling the Subagent Tool
(subagent({ name, task, timeout?, maxTurns?, cwd? }))

### Sub-Agent Mode
When a sub-agent is spawned, it sees the **[BEGIN SUB AGENT MODE]** marker.
Sub-agents are explicitly forbidden from spawning more sub-agents.

### Best Practices
1. Give sub-agents clear, specific task descriptions
2. Set appropriate timeouts for long-running tasks
3. Let sub-agents write results to files — you can read them back
4. Use sub-agents to consolidate knowledge into summaries
```

## Features

- **Full Context Inheritance** — Sub-agents receive the complete session context via JSONL snapshot.
- **Auto-Injection** — Sub-agent instructions are injected into the system prompt at startup (constant text, KV cache stable).
- **Recursion Guard** — Sub-agents cannot spawn further sub-agents. Enforced at the runner level by blocking `subagent` tool calls.
- **Timeout & Max Turns** — Configurable safeguards against runaway sub-agents (default: 120s timeout, 50 max turns).
- **Streaming Updates** — Watch sub-agent progress in real-time as tool calls and outputs stream in.
- **Rich TUI Rendering** — Collapsed/expanded views with usage stats and tool call previews.

## Project Structure

```
index.ts       — Extension entry point: tool registration, auto-injection, execution
runner.ts      — Process runner: starts `pi` subprocesses with full context inheritance
runner-cli.js  — Parent CLI inheritance: parses and normalizes flags forwarded to child processes
runner-events.js — Event parser: processes Pi JSON mode events, enforces maxTurns and recursion guard
render.ts      — TUI rendering: renderCall and renderResult for the subagent tool
types.ts       — Shared types and pure helper functions
```

## Attribution

Inspired by implementations from [vaayne/agent-kit](https://github.com/vaayne/agent-kit) and [mariozechner/pi-mono](https://github.com/badlogic/pi-mono).

## License

MIT


