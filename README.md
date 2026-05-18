# Pi Subagent (Phase 1)

**Delegate tasks to specialized subagents with full context inheritance.**

Phase 1 focuses on **KV cache stability** — sub-agents inherit the exact same system prompt and conversation history as the main agent, preserving the KV cache prefix match for minimal recomputation.

## Why Pi Subagent

**KV Cache Preservation** — Sub-agents inherit the full session context without modifying the system prompt, so llama.cpp can reuse the existing KV cache.

**Full Context** — Sub-agents see the complete conversation history, not just a task description.

**Single Delegation** — Clean, predictable single sub-agent execution (no parallel complexity).

## Install

### Option 1: Install from npm (recommended)

```bash
pi install npm:@mjakl/pi-subagent
```

### Option 2: Install via git

```bash
pi install git:github.com/mjakl/pi-subagent
```

### Option 3: Manual Installation

Clone this repository to your Pi extensions directory:

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/mjakl/pi-subagent.git
cd pi-subagent
npm install
```

## Configuration

### Delegation Guards (Depth + Cycle Prevention)

By default, this extension enforces two runtime guards:

1. **Depth guard** (`--subagent-max-depth`, default `3`)
   - Main agent starts at depth `0`
   - Delegation is allowed while `currentDepth < maxDepth`
   - With default depth `3`: depth `0`, `1`, and `2` can delegate; depth `3` cannot
2. **Cycle guard** (`--subagent-prevent-cycles`, default `true`)
   - Blocks delegating to any agent name already present in the current delegation stack
   - Prevents self-recursion (`writer -> writer`) and loops (`planner -> reviewer -> planner`)

You can configure depth with either:

- CLI flag: `--subagent-max-depth <n>`
- Environment variable: `PI_SUBAGENT_MAX_DEPTH=<n>`

`n` must be a non-negative integer.

You can configure cycle prevention with either:

- CLI flag: `--subagent-prevent-cycles` / `--no-subagent-prevent-cycles`
- Environment variable: `PI_SUBAGENT_PREVENT_CYCLES=true|false`

Internal env vars managed by the extension and propagated to child processes:

- `PI_SUBAGENT_DEPTH`
- `PI_SUBAGENT_MAX_DEPTH`
- `PI_SUBAGENT_STACK` (JSON array of ancestor agent names, e.g. `["scout","planner"]`)
- `PI_SUBAGENT_PREVENT_CYCLES`

Recommended extension-integration note:

If another extension needs to detect whether it is running inside a delegated subagent process, check `PI_SUBAGENT_DEPTH`. Treat `PI_SUBAGENT_DEPTH > 0` as "this pi process is a subagent". This is the recommended way to suppress parent-only behavior such as bells, desktop notifications, or other attention-grabbing signals.

Examples:

```bash
# Default behavior: depth 3 + cycle prevention enabled
pi

# Restrict to one nested level (main -> child -> grandchild)
pi --subagent-max-depth 2

# Disable subagent delegation entirely
pi --subagent-max-depth 0

# Allow depth 3 but disable cycle prevention (not recommended)
pi --subagent-max-depth 3 --no-subagent-prevent-cycles
```

### Subagent Definitions

Subagents are defined as Markdown files with YAML frontmatter.

**User Agents:** `~/.pi/agent/agents/*.md` by default, or `$PI_CODING_AGENT_DIR/agents/*.md` when `PI_CODING_AGENT_DIR` is set
**Project Agents:** `.pi/agents/*.md`

`PI_CODING_AGENT_DIR` follows Pi's config-dir override semantics: when it is set, the extension uses `$PI_CODING_AGENT_DIR/agents` as the user/global agent directory instead of `~/.pi/agent/agents`. Project agents are still loaded in addition to the active user/global directory, and project agents win on name conflicts. When project agents are requested, Pi will prompt for confirmation before running them.

Example agent (`~/.pi/agent/agents/writer.md`):

```markdown
---
name: writer
description: Expert technical writer and editor
model: anthropic/claude-3-5-sonnet
tools: read, write
---

You are an expert technical writer. Your task is to improve the clarity and conciseness of the provided text.
```

Note: this repository includes a sample agent in `agents/oracle.md` for reference.

### Frontmatter Fields

| Field         | Required | Default                          | Description                                                                                                                                                                |
| ------------- | -------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Yes      | —                                | Agent identifier used in tool calls (must match exactly)                                                                                                                   |
| `description` | Yes      | —                                | What the agent does (shown to the main agent)                                                                                                                              |
| `model`       | No       | Uses the default pi model        | Overrides the model for this agent. You can include a provider prefix (e.g. `anthropic/claude-3-5-sonnet` or `openrouter/claude-3.5-sonnet`) to force a specific provider. |
| `thinking`    | No       | Uses Pi's default thinking level | Sets the thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). Equivalent to `--thinking`.                                                                  |
| `tools`       | No       | `read,bash,edit,write`           | Comma-separated list of **built-in** tools to enable for this agent. If omitted, defaults apply.                                                                           |

Notes:

- `model` accepts `provider/model` syntax — this is a Pi feature. Use it when multiple providers offer the same model ID.
- `thinking` uses the same values as Pi's `--thinking` flag; it's recommended to set it explicitly since thinking support varies by model.
- `tools` only controls built-in tools. Extension tools remain available unless extensions are disabled.
- The Markdown body below the frontmatter becomes the agent's system prompt and is **appended as context** (not system prompt) to the sub-agent's user message.

### Writing a Good Agent File

- **Description matters** — the main agent uses the `description` to decide which subagent to call, so be specific about what the agent is good at.
- **Tool scope is optional but helpful** — reducing tools can keep the agent focused, but you can leave defaults if unsure.
- **Model + thinking is the power combo** — selecting the right model and thinking level is often the biggest quality boost.

### Available Built-in Tools

Available Tools (default: `read`, `bash`, `edit`, `write`):

- `read` — Read file contents
- `bash` — Execute bash commands
- `edit` — Edit files with find/replace
- `write` — Write files (creates/overwrites)
- `grep` — Search file contents (read-only, off by default)
- `find` — Find files by glob pattern (read-only, off by default)
- `ls` — List directory contents (read-only, off by default)

Tip: for a read-only tool selection, use `read,find,ls,grep`. As soon as you include `edit`, `write`, or `bash`, the agent can practically go wild.

## How Communication Works

### The Isolation Model

Each subagent always runs in a **separate `pi` process**:

- ❌ No shared memory/state with the parent process
- ❌ No visibility into sibling subagents
- ✅ Its own model/tool/runtime loop
- ✅ Started with `PI_OFFLINE=1` to skip startup network operations and reduce spawn latency
- ✅ Inherits relevant parent CLI configuration such as extensions, provider/theme/skill flags, resolves inherited relative resource paths against the parent cwd, and reuses parent `--model` / `--thinking` / `--tools` values when the agent file does not override them

### What Gets Sent to Subagents

The sub-agent receives:

```
[Forked snapshot of current session context — identical to parent]
[Agent body from agent file — appended as user message context]

User: [sub-agent-task] Complete this task:
{task description}
```

**Key points:**
- The sub-agent inherits the **exact same system prompt** as the main agent (Pi default + `APPEND_SYSTEM.md`)
- The agent body from the agent file is included as user message context, NOT as system prompt
- This preserves the KV cache prefix match — llama.cpp can reuse the existing cache

### What Comes Back to the Main Agent

| Data                        | Main Agent Sees          | TUI Shows              |
| --------------------------- | ------------------------ | ---------------------- |
| Final text output           | ✅ Yes — full, unbounded | ✅ Yes                 |
| Tool calls made by subagent | ❌ No                    | ✅ Yes (expanded view) |
| Token usage / cost          | ❌ No                    | ✅ Yes                 |
| Reasoning/thinking steps    | ❌ No                    | ❌ No                  |
| Error messages              | ✅ Yes (on failure)      | ✅ Yes                 |

**Key point:** The main agent receives **only the final assistant text** from each subagent. Not the tool calls, not the reasoning, not the intermediate steps. This prevents context pollution while still giving you the results.

## Features

- **Auto-Discovery** — Agents are found at startup and their descriptions are injected into the main agent's system prompt.
- **Full Context Inheritance** — Sub-agents receive the complete session context, preserving KV cache efficiency.
- **Depth + Cycle Guards** — Depth limiting and ancestry-cycle checks prevent runaway recursive delegation by default.
- **Timeout & Max Turns** — Configurable safeguards against runaway sub-agents (default: 120s timeout, 50 max turns).
- **Streaming Updates** — Watch subagent progress in real-time as tool calls and outputs stream in.
- **Rich TUI Rendering** — Collapsed/expanded views with usage stats, tool call previews, and markdown output.
- **Security Confirmation** — Project-local agents require explicit user approval before execution.

## Project Structure

```
index.ts       — Extension entry point: lifecycle hooks, tool registration, execution
agents.ts      — Agent discovery: reads and parses .md files from the active Pi config dir and project directories
runner.ts      — Process runner: starts `pi` subprocesses with full context inheritance and streams results
runner-cli.js  — Parent CLI inheritance: parses and normalizes flags forwarded to child processes
runner-events.js — Event parser: processes Pi JSON mode events, enforces maxTurns limits
render.ts      — TUI rendering: renderCall and renderResult for the subagent tool
types.ts       — Shared types and pure helper functions
```

 Phase 1 Implementation Complete                                                                                                                                                                                                                                                                           
                                                                                                                                                                                                                                                                                                           
 ### Changes Made                                                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                                                                           
 ┌─────────────────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐ 
 │ File                        │ What Changed                                                                                                                                                                                                                                                            │ 
 ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ types.ts                    │ Removed DelegationMode, DEFAULT_DELEGATION_MODE, SubagentDetails.mode. Added timeout/maxTurns to SingleResult. Updated isResultSuccess to reject timeout/max_turns. Updated normalizeCompletedResult to handle timeout/max_turns without overwriting existing           │ 
 │                             │ errorMessage.                                                                                                                                                                                                                                                           │ 
 ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ runner-events.js            │ Added maxTurns enforcement — stops processing events when usage.turns >= maxTurns.                                                                                                                                                                                      │ 
 ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ runner.ts                   │ Major rewrite: removed parallel helpers (mapConcurrent), removed --append-system-prompt, removed forkSession per-agent temp files. Added timeout timer (SIGTERM → SIGKILL). Added maxTurns passed to result. Agent body included as user message context with           │ 
 │                             │ [sub-agent-task] tag.                                                                                                                                                                                                                                                   │ 
 ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ render.ts                   │ Removed delegation mode display, removed parallel rendering. Simplified to single-mode only. Added status icons for timeout (⏰) and maxTurns (🔄).                                                                                                                     │ 
 ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ index.ts                    │ Major rewrite: removed mode param, removed tasks array/parallel mode, removed spawn support. Always uses fork mode (full context). Added timeout/maxTurns params. Removed system prompt injection for sub-agents.                                                       │ 
 ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ README.md                   │ Updated to reflect Phase 1: single sub-agent, full context inheritance, no parallel, KV cache preservation focus.                                                                                                                                                       │ 
 ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ test/runner.test.mjs        │ Added 4 new tests for timeout/maxTurns handling.                                                                                                                                                                                                                        │ 
 ├─────────────────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤ 
 │ test/runner-events.test.mjs │ Added maxTurns enforcement test.                                                                                                                                                                                                                                        │ 
 └─────────────────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘ 
                                                                                                                                                                                                                                                                                                           
 ### Key Design Decisions Implemented                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                           
 1. Same system prompt — Sub-agents inherit Pi's default + APPEND_SYSTEM.md automatically (no --append-system-prompt)                                                                                                                                                                                      
 2. Agent body as user context — Agent file body prepended to task in user message, not system prompt                                                                                                                                                                                                      
 3. [sub-agent-task] tag — Clear delimiter for sub-agents to identify their role                                                                                                                                                                                                                           
 4. No parallel execution — Single sub-agent only, preserving KV cache logic                                                                                                                                                                                                                               
 5. Timeout (120s default) — SIGTERM → SIGKILL after 5s grace period                                                                                                                                                                                                                                       
 6. Max turns (50 default) — Enforced in event processing stream                                                                                                                                                                                                                                           
                                                                                                                                                                                                                                                                                                           
 ### Test Results: 20/20 passing  

## Attribution

Inspired by implementations from [vaayne/agent-kit](https://github.com/vaayne/agent-kit) and [mariozechner/pi-mono](https://github.com/badlogic/pi-mono).

## License

MIT
