# Phase 1 Design: KV-Cache-Aware Subagent Delegation

> **Status:** Draft - Phase 1 design document for the pi-subagent extension
> **Date:** 2026-05-17
> **Author:** Ben + Qwen
> **Repository:** `/home/bbilbro/pi-subagent`

---

## 1. Problem Statement

The existing `pi-subagent` extension spawns isolated `pi` subprocesses for delegated tasks. This works well in cloud-model scenarios but causes **KV cache corruption** when running locally on llama.cpp:

### The KV Cache Problem

llama.cpp maintains a KV cache of pre-computed key/value token pairs in VRAM. When a new prompt arrives:

1. llama.cpp finds the longest prefix match in the existing KV cache
2. It reuses all matching prefix tokens (fast)
3. It only forward-passes the *new* tokens (minimal work)

**Example:** If the conversation history is `i1 → o1 → i2 → o2 → i3 → o3`, then for input `i4`, llama.cpp uses the cached state from `o3` and only computes `i4`.

### Three Cache-Breaking Scenarios in Current Implementation

| Scenario | What Happens | Cache Impact |
|----------|-------------|--------------|
| **1. System prompt modification** | Sub-agent plugin modifies the system prompt to inject sub-agent instructions | `i1` changes → entire chain `o1` through `o3` must be recomputed |
| **2. System prompt mutation after return** | Sub-agent inherits chat context (stable), finishes quickly, but the plugin updates the main agent's system prompt to indicate sub-agent completion | `i1` changes → entire chain recomputed when main agent resumes |
| **3. Spawn mode (no context)** | Sub-agent receives no conversation history, only task | Fresh prompt → no prefix match → full recompute |

### Root Cause

The current architecture modifies the system prompt per-agent and/or omits conversation context. This breaks the prefix match that llama.cpp relies on for KV cache reuse.

---

## 2. Design Goals

1. **Preserve KV cache** - Main agent's KV cache must not be invalidated by sub-agent operations
2. **Complete context inheritance** - Sub-agents inherit the exact same system prompt and conversation history as the main agent
3. **Tool-based communication** - Sub-agent results flow back as tool results (not user messages), keeping the conversation model clean
4. **Graceful error handling** - Sub-agent failures must not break the main session
5. **Minimal architectural change** - Work within the existing subprocess model where possible

---

## 3. Core Architecture

### 3.1 High-Level Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                        MAIN AGENT (pi process)                   │
│                                                                  │
│  KV Cache: [i1→o1] → [i2→o2] → ... → [iN→oN]                  │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  Tool Call: subagent_fork({ task: "..." })                │   │
│  └───────────────────────────────────────────────────────────┘   │
│                           │                                      │
│                           ▼                                      │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  Sub-Agent Process (fork mode, inherits full context)     │   │
│  │  KV Cache: [i1→o1] → ... → [iN→oN] → [task msg→result]  │   │
│  └───────────────────────────────────────────────────────────┘   │
│                           │                                      │
│                           ▼                                      │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  Tool Result: { content: [...], details: {...} }          │   │
│  │  Main agent sees: [i1→o1] → ... → [iN→oN] → [tool result]│   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  KV Cache (after sub-agent):                                     │
│  [i1→o1] → ... → [iN→oN]  ← prefix match found!                │
│  [tool result]  ← only this forward-passed                     │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Key Design Decisions

#### Decision 1: Sub-Agent Prompt Construction

**Choice:** Sub-agents inherit the **exact same system prompt** as the main agent. No custom system prompt.

**Rationale:**
- The current implementation appends the agent's system prompt body to Pi's default system prompt. This changes `i1`, invalidating the entire KV cache.
- By using the same system prompt, `i1` remains unchanged, and llama.cpp can find the prefix match.

**Implementation:**
- Remove `--append-system-prompt` for sub-agent invocations
- Instead, the agent's system prompt body is prepended to the task in the user message

#### Decision 2: Task Communication via User Message

**Choice:** The sub-agent's task is delivered as a **user message** after the full conversation history.

**Format:**
```
[Full conversation history — identical to parent]
[Agent body from agent file — appended as context, not system prompt]

User: [sub-agent-task] Complete the following task and respond with all results:
{task description}
```

**Why user message, not system prompt:**
- System prompt changes break KV cache
- User messages are appended to the conversation, preserving the prefix match
- The `[sub-agent-task]` tag provides a clear delimiter for the sub-agent to identify its role

#### Decision 3: System Prompt Inheritance

**Choice:** Sub-agents inherit the **exact same system prompt** as the main agent, which is Pi's default system prompt + `~/.pi/agent/APPEND_SYSTEM.md` (if it exists).

**Rationale:**
- Pi already combines its default system prompt with `APPEND_SYSTEM.md` globally for all processes
- Sub-agents are spawned as `pi` processes, so Pi's system prompt handling applies automatically
- We must NOT add `--append-system-prompt` or modify the system prompt in any way
- The agent body from the agent file is included as user message context (not system prompt)

**Assumption:** Pi's global `APPEND_SYSTEM.md` is automatically applied to all `pi` subprocesses. We verify this during testing.

#### Decision 4: No Parallel Execution

**Choice:** Parallel sub-agent execution is **not supported** in Phase 1.

**Rationale:**
- Parallel execution spawns multiple subprocesses simultaneously, each with their own KV cache
- This creates confusion about which cache belongs to which sub-agent
- It breaks the single KV cache logic — the main agent can't efficiently resume after multiple concurrent sub-agents
- Simpler to start with single sub-agents and add parallel later if needed

**Impact:** Remove `tasks` array parameter, `executeParallel()`, `mapConcurrent()`, and all parallel-related rendering.

#### Decision 5: Sub-Agent Response as Tool Result

**Choice:** Sub-agent results are returned as **tool results** to the main agent.

**Rationale:**
- Tool results are the native return path in pi's tool execution model
- The main agent receives structured content that it can process naturally
- No need for a `[sub-agent-response]` tag in the conversation - the tool result *is* the response
- This avoids polluting the main agent's conversation history with raw sub-agent output

**Tool Result Structure:**
```typescript
{
  content: [{ type: "text", text: "Sub-agent completed the task. Here are the results: ..." }],
  details: {
    results: [{
      agent: "agent-name",
      agentSource: "user" | "project",
      task: "...",
      exitCode: 0,
      messages: [...],  // Full message history from sub-agent
      stderr: "",
      usage: { ... },
      model: "...",
      stopReason: "stop",
      sawAgentEnd: true
    }]
  }
}
```

**What the main agent receives:**
- **Final output text** - The sub-agent's last assistant message (the actual work product)
- **Error messages** - If the sub-agent failed, the error is surfaced
- **NOT** - Tool calls made by sub-agent, reasoning steps, or intermediate tool results

This matches the current behavior and keeps the main agent's context clean.

#### Decision 6: Timeout and Error Handling

**Choice:** Configurable timeout with graceful degradation.

**Timeout:**
- Default: 120 seconds (configurable via `timeout` parameter)
- On timeout: sub-agent process is terminated (SIGTERM → SIGKILL after 5s)
- Main agent receives a structured error: `"Sub-agent timed out after {timeout}s"`
- Session continues normally - no cascade failure

**Error Cases:**
| Error | Handling |
|-------|----------|
| Unknown agent name | Return error to main agent, session continues |
| Fork mode without session snapshot | Return error to main agent, session continues |
| Sub-agent process crash | Capture stderr, return to main agent, session continues |
| Sub-agent timeout | Terminate process, return timeout error, session continues |
| Cycle guard triggered | Return error, session continues |
| Depth guard exceeded | Return error, session continues |

---

## 4. API Design

### 4.1 Tool Parameters

```typescript
const SubagentParams = Type.Object({
  agent: Type.String({
    description: "Agent name. Must match exactly.",
  }),
  task: Type.String({
    description: "Task description. The sub-agent receives the full session context.",
  }),
  timeout: Type.Optional(Type.Number({
    description: "Maximum execution time in seconds. Default: 120.",
    default: 120,
  })),
  maxTurns: Type.Optional(Type.Number({
    description: "Maximum number of assistant turns (LLM calls) the sub-agent can make. Default: 50.",
    default: 50,
  })),
  confirmProjectAgents: Type.Optional(Type.Boolean({
    description: "Prompt user before running project-local agents. Default: true.",
    default: true,
  })),
  cwd: Type.Optional(Type.String({
    description: "Working directory.",
  })),
});
```

### 4.2 Parameter Details

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `agent` | string | — | Agent name (required) |
| `task` | string | — | Task description (required) |
| `timeout` | number | `120` | Max seconds before killing sub-agent |
| `maxTurns` | number | `50` | Max LLM turns (tool call cycles) |
| `confirmProjectAgents` | boolean | `true` | Security confirmation for project agents |
| `cwd` | string | — | Working directory override |

### 4.3 Example Tool Call

```json
{
  "agent": "writer",
  "task": "Write a comprehensive API documentation for the endpoints in /src/api",
  "timeout": 180,
  "maxTurns": 30
}
```

---

## 5. File Changes

### 5.1 Files to Modify

| File | Change |
|------|--------|
| `index.ts` | Remove parallel mode entirely, remove `mode` param, remove spawn support, add `timeout`/`maxTurns` params, remove system prompt injection for sub-agents |
| `runner.ts` | Remove `--append-system-prompt` flag, pass agent body as context in user message, add timeout handling, add `maxTurns` support, remove forkSessionSnapshot logic, remove parallel helpers |
| `runner-cli.js` | No changes needed — inherits CLI args correctly |
| `runner-events.js` | Add maxTurns enforcement in event processing |
| `types.ts` | Remove `DelegationMode`, remove `SubagentDetails.mode`, add `timeout`/`maxTurns` to options, simplify types |
| `render.ts` | Remove delegation mode display, remove parallel rendering, simplify to single-mode only |
| `agents.ts` | No changes needed — agent discovery unchanged (agent body still used for task context)

### 5.2 Files to Remove

| File | Reason |
|------|--------|
| `mapConcurrent` logic | No longer needed — no parallel execution |

### 5.3 Files to Potentially Delete

| File | Reason |
|------|--------|
| N/A | All existing files remain; changes are modifications, not deletions |

---

## 6. Conversation Flow (End-to-End)

### 6.1 Single Sub-Agent Flow

```
MAIN AGENT CONVERSATION HISTORY:
  i1: [System Prompt - unchanged throughout]
  u1: "Summarize the src/ directory"
  o1: "Sure, let me delegate that to a sub-agent."
  tool_call: subagent({ agent: "writer", task: "Summarize the src/ directory" })

  ┌── SUB-AGENT PROCESS ──────────────────────────────────────────┐
  │                                                                │
  │  SUB-AGENT CONVERSATION HISTORY:                               │
  │    i1: [System Prompt - SAME as main agent]                   │
  │    u1: "Summarize the src/ directory"                          │
  │    o1: "Sure, let me delegate that to a sub-agent."           │
  │    tool_call: subagent({ agent: "writer", task: "..." })      │
  │                                                                │
  │    [Agent Body Context - from agent file, NOT system prompt]  │
  │    u[task]: [sub-agent-task] Complete this task:              │
  │             "Summarize the src/ directory"                     │
  │                                                                │
  │    o[task]: "Here's my summary..."                            │
  │    (sub-agent makes tool calls as needed)                     │
  │    o[final]: "Summary complete. Here are the results..."      │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘

  tool_result: { content: [{ type: "text", text: "Summary complete..." }], details: {...} }

MAIN AGENT RESUMES:
  KV Cache: [i1→o1] → [u1→o1] → [tool_call→tool_result]
  (Prefix match found at i1 → only tool_result forward-passed)
```

### 6.2 No Parallel Flow

Phase 1 supports only single sub-agent execution. Parallel execution is out of scope.

---

## 7. KV Cache Behavior Analysis

### 7.1 What Stays Stable

| Component | Stable? | Why |
|-----------|---------|-----|
| System prompt (`i1`) | ✅ Yes | Never modified - same for main agent and all sub-agents |
| Conversation history up to tool call | ✅ Yes | Sub-agent inherits identical history |
| Agent body content | ⚠️ Partial | Appended as user message context (after stable prefix) |

### 7.2 What Gets Forward-Passed

When the sub-agent finishes and returns to the main agent:

```
Main agent's view of KV cache:
  [i1→o1] → ... → [tool_call→tool_result]
              ↑
         Prefix match here!

llama.cpp behavior:
  1. Scans KV cache for longest prefix match
  2. Finds match at the tool_result position
  3. Only forward-passes: tool_result → next_input
  4. Result: minimal computation
```

### 7.3 Sub-Agent's KV Cache

The sub-agent process has its own llama.cpp instance with its own KV cache:

```
Sub-agent's KV cache:
  [i1→o1] → ... → [iN→oN] → [task_msg→tool_calls→final_response]
  ↑
  Prefix match from inherited context!

llama.cpp behavior:
  1. Scans its own KV cache (empty initially)
  2. No prefix match - must compute everything
  3. BUT: the inherited context IS the prefix, so tokens i1 through iN
     are computed once and cached
  4. Only the NEW tokens (task message + sub-agent output) are "extra"
```

### 7.4 KV Cache Savings Summary

| Approach | Prefix Match | Extra Compute |
|----------|-------------|---------------|
| **Current (spawn)** | ❌ No prefix match (no context) | Full recompute |
| **Current (fork + system prompt change)** | ❌ `i1` changed | Full recompute |
| **Current (fork + no prompt change)** | ✅ Full prefix match | Only task message + output |
| **Phase 1 (fork, same system prompt)** | ✅ Full prefix match | Only task message + output |

**Phase 1 achieves the same KV cache efficiency as the ideal case** - the sub-agent only forward-passes the new tokens (task message + sub-agent output), because the inherited context matches the prefix exactly.

---

## 8. Implementation Details

### 8.1 Prompt Construction

The sub-agent's input is constructed as follows:

```typescript
// In runner.ts - buildPiArgs()

function buildPiArgs(
  agent: AgentConfig,
  task: string,
  forkSessionPath: string | null,
): string[] {
  const args: string[] = [
    "--mode", "json",
    ...inheritedCliArgs.extensionArgs,
    ...inheritedCliArgs.alwaysProxy,
    "-p",
  ];

  // Fork mode: use the parent's session snapshot (full conversation)
  if (forkSessionPath) {
    args.push("--session", forkSessionPath);
  }

  // Model/thinking/tools from agent config
  const model = agent.model ?? inheritedCliArgs.fallbackModel;
  if (model) args.push("--model", model);

  const thinking = agent.thinking ?? inheritedCliArgs.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);

  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  // NO --append-system-prompt! The agent body is included in the session.

  // Task message with sub-agent marker
  const taskMessage = `[sub-agent-task] Complete this task:\n${task}`;
  if (agent.systemPrompt.trim()) {
    // Prepend agent body as context (not system prompt)
    args.push(`${agent.systemPrompt.trim()}\n\nUser: ${taskMessage}`);
  } else {
    args.push(`User: ${taskMessage}`);
  }

  return args;
}
```

### 8.2 Timeout Implementation

```typescript
// In runner.ts - runAgent()

const timeoutMs = opts.timeout ?? 120_000; // Default 120 seconds
const timeoutTimer = setTimeout(() => {
  proc.kill("SIGTERM");
  result.exitCode = 124; // Standard timeout exit code
  result.stopReason = "timeout";
  result.errorMessage = `Sub-agent timed out after ${timeoutMs / 1000}s`;
  result.stderr = `Sub-agent timed out after ${timeoutMs / 1000}s`;
}, timeoutMs);

// In the process close handler:
proc.on("close", (code) => {
  clearTimeout(timeoutTimer);
  // ... existing cleanup
});
```

### 8.3 Max Turns Implementation

Max turns is enforced by monitoring the event stream:

```typescript
// In runner-events.js - processPiEvent()

let turnCount = 0;

export function processPiEvent(event, result) {
  if (result.usage.turns >= result.maxTurns) {
    // Sub-agent has exceeded max turns
    result.stopReason = "max_turns";
    result.errorMessage = `Sub-agent exceeded maximum turns (${result.maxTurns})`;
    return false;
  }

  switch (event.type) {
    case "message_end":
    case "turn_end":
      return addAssistantMessage(result, event.message);
    case "agent_end":
      result.sawAgentEnd = true;
      return addAssistantMessages(result, event.messages);
    default:
      return false;
  }
}
```

### 8.4 Error Handling in Execute

```typescript
// In index.ts - executeSingle()

async function executeSingle(...) {
  const result = await runAgent({
    // ... existing options
    timeout: params.timeout ?? 120_000,
    maxTurns: params.maxTurns ?? 50,
  });

  if (isResultError(result)) {
    return {
      content: [{ type: "text", text: `Sub-agent failed: ${getResultSummaryText(result)}` }],
      details: makeDetails("single")([result]),
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: getResultSummaryText(result) }],
    details: makeDetails("single")([result]),
  };
}
```

---

## 9. Migration Path

### 9.1 From Current Extension to Phase 1

| Aspect | Current | Phase 1 |
|--------|---------|---------|
| Default mode | `spawn` | `fork` (only mode) |
| System prompt | Agent body appended to system prompt | Same as main agent; agent body in user message |
| Context inheritance | `spawn`: none, `fork`: session snapshot | Always full session snapshot |
| Task delivery | System prompt + task | User message with `[sub-agent-task]` tag |
| Result delivery | Final text output | Tool result with final text output |
| Timeout | None (kill on abort) | Configurable timeout (default 120s) |
| Max turns | None | Configurable (default 50) |

### 9.2 Backward Compatibility

- The `mode` parameter is deprecated but accepted for backwards compatibility - it will always behave as `"fork"`
- The `spawn` mode value will be rejected with a clear error message
- All other parameters (`confirmProjectAgents`, `cwd`, `tasks`, etc.) remain unchanged

---

## 10. Testing Strategy

### 10.1 Unit Tests

| Test | Description |
|------|-------------|
| `prompt construction` | Verify sub-agent prompt has same system prompt as parent |
| `timeout handling` | Verify timeout kills process and returns error |
| `max turns enforcement` | Verify max turns stops sub-agent |
| `error propagation` | Verify sub-agent errors surface correctly to main agent |
| `cycle guard` | Verify cycle detection still works |
| `depth guard` | Verify depth limiting still works |

### 10.2 Integration Tests

| Test | Description |
|------|-------------|
| `single sub-agent` | Spawn sub-agent, verify it completes and returns results |
| `timeout` | Set short timeout, verify graceful failure |
| `fork context` | Verify sub-agent sees full conversation history |
| `system prompt stability` | Verify main agent KV cache is not invalidated |
| `APPEND_SYSTEM.md` | Verify global append system prompt is inherited by sub-agents |

### 10.3 KV Cache Verification

To verify KV cache behavior:

1. Run a conversation with 10+ turns
2. Measure tokens processed before sub-agent spawn
3. Spawn sub-agent, measure tokens processed during sub-agent run
4. Resume main agent, measure tokens to next output
5. **Expected:** Main agent's resume should only forward-pass the tool_result + next input, not the full conversation

---

## 11. Open Questions

### Q1: Should the agent body be in the user message or omitted entirely?

**Option A (proposed):** Agent body is prepended as context in the user message, before the task.

```
User: [Agent body context from agent file]

[sub-agent-task] Complete this task:
{task description}
```

**Option B:** Agent body is omitted - the sub-agent only sees the task.

```
User: [sub-agent-task] Complete this task:
{task description}
```

**Recommendation:** Option A. The agent body provides behavioral context (e.g., "You are an expert technical writer") that guides the sub-agent's behavior without modifying the system prompt.

### Q2: What should the main agent see as the sub-agent result?

**Answer:** Only the final assistant text output (same as current behavior). The main agent does NOT see:
- Tool calls made by the sub-agent
- Intermediate tool results
- Reasoning/thinking steps

This keeps the main agent's context clean and focused on results.

### Q3: Timeout vs. maxTurns - which is primary?

**Answer:** Both. Timeout is wall-clock time; maxTurns is LLM call count. Either can terminate the sub-agent first. This provides defense-in-depth against runaway sub-agents.

### Q4: Should `spawn` mode be completely removed?

**Answer:** Yes. `spawn` mode is removed entirely. Only fork mode is supported.

### Q5: What about parallel execution?

**Answer:** Not supported in Phase 1. Parallel execution would break the single KV cache logic and create confusion. Removed entirely.

---

## 12. Phase 2 Considerations (Out of Scope)

- **Sub-agent result granularity** — Optionally expose sub-agent tool calls to main agent
- **Nested sub-agents** — Allow sub-agents to spawn their own sub-agents
- **Parallel execution** — Add back parallel mode with careful KV cache considerations
- **Priority queuing** — Higher-priority sub-agents preempt lower-priority ones
- **KV cache sharing** — Explore shared llama.cpp server for true KV cache sharing between parent and child

---

## 13. Summary

Phase 1 of this redesign focuses on **preserving KV cache stability** by ensuring sub-agents inherit the exact same system prompt and conversation history as the main agent. The key changes are:

1. **Remove system prompt modification** — Sub-agents use the same system prompt as the main agent (including `APPEND_SYSTEM.md`)
2. **Always fork mode** — Sub-agents inherit full session context (only mode)
3. **No parallel execution** — Single sub-agent only, to preserve KV cache logic
4. **Task via user message** — Task delivered as a user message with `[sub-agent-task]` tag
5. **Results as tool results** — Sub-agent output flows back through the tool result mechanism
6. **Timeout + maxTurns** — Configurable safeguards against runaway sub-agents

These changes ensure that llama.cpp can find a prefix match in the KV cache, minimizing recomputation and preserving VRAM efficiency.
