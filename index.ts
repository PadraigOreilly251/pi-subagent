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
import { type SingleResult, emptyUsage, isResultError } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers (inlined to avoid jiti CJS/ESM interop issues with runner-events.js)
// ---------------------------------------------------------------------------

/**
 * Collect ALL assistant text content across all messages (not just the last one).
 * This ensures structured output from earlier assistant turns is visible to the main agent.
 */
function getAllAssistantText(messages) {
	if (!Array.isArray(messages)) return "";

	const texts = [];
	for (const message of messages) {
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}

		for (const part of message.content) {
			if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
				texts.push(part.text);
			}
		}
	}

	return texts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Constant sub-agent instructions injected into the system prompt.
 *
 * This text is deterministic — it never changes regardless of session,
 * project, or model. KV cache stable.
 */
const SUBAGENT_INSTRUCTIONS = `
## Sub-Agent Tools/Extension

Since we are running all our LLMs locally, we have to use a modified version of sub-agents. This means that you may switch between main agent and sub agent mode at any point during the session. 

You will know sub-agent mode is active when you see a user message that follows this format:

\`\`\`
**[BEGIN SUB AGENT MODE]**: <prompt and task will go here>
\`\`\`

Once you see that then you will be operating in sub-agent mode, where you have an assigned task and should work to complete it. You will not be able to spawn any sub agents while operating in sub agent mode.
Your primary goal is to accomplish the task and report back to the main agent.

Another way to tell if you are in sub-agent mode is to look at the most recent tool call. You will see the sub-agent tool call followed by an empty tool result "No result provided". You ARE the tool result actively running in sub-agent mode.
This means your final response will be the tool_result.

### Calling the Subagent Tool

\`\`\`
subagent({
  name: "researcher",     // Freeform name (human-like, for your reference)
  task: "Research the latest about quantum computing",
  timeout: 600,           // Optional: max seconds (default: 600). Local LLMs slow — set generous.
  maxTurns: 50,           // Optional: max LLM turns (default: 50)
  cwd: "/path/to/dir"     // Optional: working directory
})
\`\`\`

### Timeout rule (IMPORTANT)

Local LLMs run 2-10 tok/s. Large context = slow first turn.
Always set explicit timeout + maxTurns. Formula: maxTurns × 10s = min timeout.
- Quick lookup (1-3 calls): maxTurns:10, timeout:120
- Deep research (5+ calls): maxTurns:50, timeout:600

### Timeout recovery

Subagent timeout = task too broad. Split and retry, don't just increase timeout.
**Partial output IS preserved** — read it from tool result before splitting.
Split task into 2 independent subtasks, run sequentially.
See \`subagent\` skill (/skill:subagent) → Timeout recovery for full pattern.

### Subagent mode rules (IMPORTANT)

1. **Do NOT use the quest tool.** Quest IDs are meaningless in subagent context. Your quests don't affect the parent. Skip quest management entirely.

2. **Do NOT call tools in parallel.** MCP transport can't handle concurrent requests. Call web_search, web_fetch, and other tools one at a time, sequentially. Parallel calls fail with transport errors.

3. **Your final message = your full output.** The main agent only sees your final text. Put ALL findings in your last message. Don't say "Done." without including the actual data.

See \`subagent\` skill (/skill:subagent) for full best practices.
`;

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const SubagentParams = Type.Object({
	name: Type.String({
		description: "A human-like name for the sub-agent (e.g., 'researcher', 'analyst', or even something like 'Albert', 'Isaac', 'Ben' for non-focused tasks). Freeform, no config lookup.",
	}),
	task: Type.String({
		description:
			"Task description. The sub-agent receives the full session context.",
	}),
	timeout: Type.Optional(
		Type.Number({
			description: "Maximum execution time in seconds. Default: 600.",
			default: 600,
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
			description: "Working directory for the agent process. Will default to your CWD.",
		}),
	),
});

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
			"  timeout: Max execution time in seconds (default: 600)",
			"  maxTurns: Max LLM turns/calls (default: 50)",
			"",
			"Example: { name: \"researcher\", task: \"Research the latest about quantum computing\", timeout: 600 }",
		].join("\n"),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Execute sub-agent — fresh pi process, inherits model + tools via CLI args
			const timeoutMs = (params.timeout ?? 600) * 1000;
			const maxTurns = params.maxTurns ?? 50;

			const result = await runAgent({
				cwd: ctx.cwd,
				agentName: params.name,
				task: params.task,
				taskCwd: params.cwd,
				signal,
				onUpdate,
				makeDetails: (results) => ({ results }),
				timeout: timeoutMs,
				maxTurns,
			});

			if (result.stopReason === "timeout") {
				// Timeout with potential partial output — return actionable guidance
				const partialText = getFinalAssistantText(result.messages);
				const summary = partialText
					? `Partial result before timeout:\n${partialText}\n\n`
					: "";
				const turnInfo = result.usage.turns > 0
					? `${result.usage.turns} turns completed`
					: "no turns completed";
				return {
					content: [
						{
							type: "text" as const,
							text:
								`${summary}Sub-agent timed out (${turnInfo}).\n\n` +
								`This task was too broad for one sub-agent. Split into smaller pieces:\n` +
								`1. Divide task into 2-3 independent subtasks\n` +
								`2. Run each as separate subagent with smaller maxTurns\n` +
								`3. Compile results after all subtasks complete\n` +
								`\nExample:\n` +
								`subagent({ name: "part1", task: "do X only", maxTurns: 10, timeout: 120 })\n` +
								`subagent({ name: "part2", task: "do Y only", maxTurns: 10, timeout: 120 })\n` +
								`\nSee /skill:subagent → Timeout recovery for full pattern.`,
						},
					],
					details: { results: [result] },
					isError: true,
				};
			}

			if (result.stopReason === "max_turns") {
				// Max turns reached — return partial output with actionable guidance
				const partialText = getAllAssistantText(result.messages);
				const turnInfo = result.usage.turns > 0
					? `${result.usage.turns} turns completed`
					: "no turns completed";

				if (partialText) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Partial result (max turns — ${turnInfo}):\n${partialText}\n\n` +
									`Sub-agent reached max turns (${result.maxTurns}) before completing. ` +
									`Split remaining work into smaller subtasks:\n` +
									`1. Divide incomplete task into 2-3 independent subtasks\n` +
									`2. Run each as separate subagent with smaller maxTurns\n` +
									`3. Compile results after all subtasks complete\n` +
									`\nSee /skill:subagent → Timeout recovery for full pattern.`,
							},
						],
						details: { results: [result] },
						isError: true,
					};
				}
				// No partial text — just guidance
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Sub-agent reached max turns (${result.maxTurns}, ${turnInfo}) with no output. ` +
								`Task too broad. Split into smaller pieces with fewer maxTurns each.\n` +
								`\nExample:\n` +
								`subagent({ name: \"part1\", task: \"do X only\", maxTurns: 10, timeout: 120 })\n` +
								`subagent({ name: \"part2\", task: \"do Y only\", maxTurns: 10, timeout: 120 })\n` +
								`\nSee /skill:subagent → Timeout recovery for full pattern.`,
						},
					],
					details: { results: [result] },
					isError: true,
				};
			}

			if (isResultError(result)) {
				const partialText = getAllAssistantText(result.messages);
				const displayText = partialText || getResultSummaryText(result);
				return {
					content: [
						{
							type: "text" as const,
							text: displayText,
						},
					],
					details: { results: [result] },
					isError: true,
				};
			}
			// Use full output (all assistant text, not just last message)
			const fullOutput = getAllAssistantText(result.messages);
			const displayText = fullOutput || getResultSummaryText(result);
			return {
				content: [
					{
						type: "text" as const,
						text: displayText,
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
