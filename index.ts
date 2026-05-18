/**
 * Pi Subagent Extension (Simplified)
 *
 * Delegates tasks to sub-agents running in isolated `pi` processes.
 *
 * Simplified design:
 * - Sub-agents identified by a freeform name (no config files)
 * - Sub-agents inherit the exact same system prompt and session context as the main agent
 * - Sub-agents cannot spawn further sub-agents (enforced at runner level)
 * - No named agents, no tool sets, no model overrides
 *
 * This preserves KV cache stability: the main agent's KV cache prefix
 * remains valid because the system prompt is never modified (auto-injected constant text only).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { renderCall, renderResult } from "./render.js";
import { getFinalAssistantText, getResultSummaryText } from "./runner-events.js";
import { runAgent } from "./runner.js";
import {
	type SingleResult,
	emptyUsage,
	isResultError,
	isResultSuccess,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000; // 120 seconds
const DEFAULT_MAX_TURNS = 50;

/**
 * Constant sub-agent instructions injected into the system prompt.
 *
 * This text is deterministic — it never changes regardless of session,
 * project, or model. KV cache stable.
 */
const SUBAGENT_INSTRUCTIONS = `
## Sub-Agent Tools/Extension

You can delegate tasks to sub-agents running in isolated processes using the \`subagent\` tool.

### How Sub-Agents Work

- **Full context inheritance** — Sub-agents receive your complete conversation history and the same system prompt.
- **Isolated processes** — Each sub-agent runs in its own \`pi\` process with \`PI_OFFLINE=1\`.
- **No recursion** — Sub-agents are explicitly forbidden from spawning further sub-agents. This is enforced at the runner level.
- **Same model** — Sub-agents use the same model as the main agent.
- **Results** — You receive only the final assistant text from each sub-agent, not intermediate tool calls or reasoning steps.

### When to Use Sub-Agents

Use sub-agents when you need to:
- Do heavy research across many files without polluting your context
- Run long-running tasks that would consume your context window
- Offload specialized work while you continue other tasks
- Preserve context efficiency by keeping only summaries in your context

### Calling the Subagent Tool

\`\`\`
subagent({
  name: "researcher",     // Freeform name (human-like, for your reference)
  task: "Research the latest about quantum computing",
  timeout: 180,           // Optional: max seconds (default: 120)
  maxTurns: 80,           // Optional: max LLM turns (default: 50)
  cwd: "/path/to/dir"     // Optional: working directory
})
\`\`\`

### Sub-Agent Mode

When you spawn a sub-agent, it will see this marker when operating in sub-agent mode:

\`\`\`
**[BEGIN SUB AGENT MODE]**: <prompt and task will go here>
\`\`\`

If you are in sub-agent mode, you are explicitly forbidden from spawning more sub-agents.

### Best Practices

1. Give sub-agents clear, specific task descriptions
2. Set appropriate timeouts for long-running tasks
3. Let sub-agents write results to files — you can read them back
4. Use sub-agents to consolidate knowledge into summaries before bringing it back into your context
`;

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const SubagentParams = Type.Object({
	name: Type.String({
		description: "A human-like name for the sub-agent (e.g., 'researcher', 'analyst'). Freeform, no config lookup.",
	}),
	task: Type.String({
		description:
			"Task description. The sub-agent receives the full session context.",
	}),
	timeout: Type.Optional(
		Type.Number({
			description: "Maximum execution time in seconds. Default: 120.",
			default: 120,
		}),
	),
	maxTurns: Type.Optional(
		Type.Number({
			description:
				"Maximum number of assistant turns (LLM calls) the sub-agent can make. Default: 50.",
			default: 50,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process.",
		}),
	),
});

// ---------------------------------------------------------------------------
// Session snapshot helper
// ---------------------------------------------------------------------------

interface SessionSnapshotSource {
	getHeader: () => unknown;
	getBranch: () => unknown[];
}

function buildForkSessionSnapshotJsonl(
	sessionManager: SessionSnapshotSource,
): string | null {
	const header = sessionManager.getHeader();
	if (!header || typeof header !== "object") return null;

	const branchEntries = sessionManager.getBranch();
	const lines = [JSON.stringify(header)];
	for (const entry of branchEntries) lines.push(JSON.stringify(entry));
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Auto-inject constant sub-agent instructions into system prompt.
	// This is deterministic — same text every session — so KV cache is stable.
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + SUBAGENT_INSTRUCTIONS,
		};
	});

	// Register the subagent tool
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to a sub-agent running in an isolated pi process.",
			"",
			"The sub-agent inherits your full session context (conversation history + system prompt).",
			"",
			"Optional parameters:",
			"  timeout: Max execution time in seconds (default: 120)",
			"  maxTurns: Max LLM turns/calls (default: 50)",
			"",
			"Example: { name: \"researcher\", task: \"Research the latest about quantum computing\", timeout: 180 }",
		].join("\n"),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Build session snapshot for fork mode (full context inheritance)
			let forkSessionSnapshotJsonl: string | undefined;
			forkSessionSnapshotJsonl = buildForkSessionSnapshotJsonl(
				ctx.sessionManager,
			);
			if (!forkSessionSnapshotJsonl) {
				return {
					content: [
						{
							type: "text",
							text: "Cannot spawn sub-agent: failed to snapshot current session context.",
						},
					],
					details: { results: [] },
					isError: true,
				};
			}

			// Execute sub-agent
			const timeoutMs = (params.timeout ?? 120) * 1000;
			const maxTurns = params.maxTurns ?? 50;

			const result = await runAgent({
				cwd: ctx.cwd,
				agentName: params.name,
				task: params.task,
				taskCwd: params.cwd,
				forkSessionSnapshotJsonl,
				signal,
				onUpdate,
				makeDetails: (results) => ({ results }),
				timeout: timeoutMs,
				maxTurns,
			});

			console.error(`[DEBUG execute] isResultError check: exitCode=${result.exitCode} stopReason=${result.stopReason} sawAgentEnd=${result.sawAgentEnd} messages.length=${result.messages.length} stderr=${result.stderr.substring(0,100)} hasFinalText=${getFinalAssistantText(result.messages).substring(0,80)}`);
			if (isResultError(result)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Sub-agent failed: ${getResultSummaryText(result)}`,
						},
					],
					details: { results: [result] },
					isError: true,
				};
			}
			return {
				content: [
					{
						type: "text" as const,
						text: getResultSummaryText(result),
					},
				],
				details: { results: [result] },
			};
		},

		renderCall: (args, theme) => renderCall(args, theme),
		renderResult: (result, { expanded }, theme) =>
			renderResult(result, expanded, theme),
	});
}
