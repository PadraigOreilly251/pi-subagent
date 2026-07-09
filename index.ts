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
	isResultRecoverable,
	getLastToolCall,
} from "./types.js";

// ---------------------------------------------------------------------------
// Task size analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a task description and warn if it looks too broad for the given params.
 * Returns an optional warning string to prepend to results, or null if task looks fine.
 */
function analyzeTaskSize(
	task: string,
	maxTurns: number,
): { severity: "warn" | "error"; text: string } | null {
	const lower = task.toLowerCase();

	// Count indicators of a large/complex task
	const breadthSignals =
		(lower.includes("research") || lower.includes("investigate") ? 1 : 0) +
		(lower.includes("comprehensive") || lower.includes("thorough") || lower.includes("deep dive") ? 2 : 0) +
		(lower.includes("across multiple") || lower.includes("from multiple sources") ? 2 : 0) +
		(lower.includes("all of") || lower.includes("everything about") ? 3 : 0) +
		// Counting commas or "and" separated items as a rough task-count proxy
		((task.match(/,\s*(?:then|also|and)\s/gi) || []).length > 2 ? 2 : 0);

	const depthSignals =
		(lower.includes("implement") && (lower.includes("full") || lower.includes("complete")) ? 3 : 0) +
		(lower.includes("write report") || lower.includes("compile") ? 2 : 0) +
		((task.match(/\bweb_fetch|scrape|parse|document/gi) || []).length >= 2 ? 2 : 0);

	const taskComplexity = breadthSignals + depthSignals;
	const estimatedTurnsNeeded =
		Math.max(5, (breadthSignals * 6) + (depthSignals * 4));

	// Too many subtasks for the given maxTurns budget
	if (estimatedTurnsNeeded > maxTurns * 1.5) {
		return {
			severity: "error",
			text:
				`⚠️ Task complexity warning: this task looks broad (~${estimatedTurnsNeeded} turns estimated, maxTurns=${maxTurns}). ` +
				`Consider splitting before running to avoid timeout.

`,
		};
	}

	// Mild warning — task might be large but within budget
	if (taskComplexity >= 5 && estimatedTurnsNeeded > maxTurns * 0.8) {
		return {
			severity: "warn",
			text:
				`⚠️ Task complexity warning: this task is moderately complex (~${estimatedTurnsNeeded} turns). ` +
				`You may want to split it or increase maxTurns.

`,
		};
	}

	return null;
}

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

Once you see that then you will be operating in sub-agent mode, where you have an assigned task and should work to complete it.
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

These rules apply ONLY while you are in sub-agent mode, not when you are the main agent.

1. **Do NOT spawn sub-agents.** The \`subagent\` tool is blocked and will error. All research, file operations, and analysis must be done directly by you using available tools (web_search, read, bash, etc.).

2. **Do NOT use the quest tool.** Quest IDs are meaningless in subagent context. Your quests don't affect the parent. Skip quest management entirely.

3. **Do NOT call tools in parallel.** MCP transport can't handle concurrent requests. Call web_search, web_fetch, and other tools one at a time, sequentially. Parallel calls fail with transport errors.

4. **Your final message = your full output.** The main agent only sees your final text. Put ALL findings in your last message. Don't say "Done." without including the actual data.

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
			const timeoutMs = (params.timeout ?? 600) * 1000;
			const maxTurns = params.maxTurns ?? 50;

			// Pre-flight task size check — warn if task looks too broad
			const taskWarning = analyzeTaskSize(params.task, maxTurns);
			let warningPrefix = "";
			if (taskWarning) {
				warningPrefix =
					taskWarning.severity === "error"
						? `\n${taskWarning.text}`
						: `\n${taskWarning.text}`;
			}

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

			// Shared diagnostic helpers
			const partialText = getAllAssistantText(result.messages);
			const lastTool = getLastToolCall(result.messages);
			const turnInfo = result.usage.turns > 0
				? `${result.usage.turns} turn${result.usage.turns !== 1 ? "s" : ""} completed`
				: "no turns completed";

			const makeDiagnosticFooter = () => {
				const parts: string[] = [];
				if (result.exitCode !== undefined && result.exitCode > 0) {
					parts.push(`exit code: ${result.exitCode}`);
				}
				parts.push(turnInfo);
				if (lastTool) {
					parts.push(`last tool: ${lastTool.name}`);
				}
				return parts.join(" · ");
			};

			const makeSplitGuidance = () =>
				`\n\nSplit into smaller pieces:\n` +
				`1. Divide task into 2-3 independent subtasks\n` +
				`2. Run each as separate subagent with fewer maxTurns\n` +
				`3. Compile results after all complete\n` +
				`\nExample:\n` +
				`subagent({ name: "part1", task: "do X only", maxTurns: 10, timeout: 120 })\n` +
				`subagent({ name: "part2", task: "do Y only", maxTurns: 10, timeout: 120 })\n` +
				`\nSee /skill:subagent → Timeout recovery for full pattern.`;

			// ── SIGTERM (exit 143): auto-retried by runner.ts ──────────────────────
			if (result.stopReason === "sigterm") {
				const summary = partialText
					? `Partial result:\n${partialText}\n\n`
					: "";
				return {
					content: [
						{
							type: "text" as const,
							text:
								warningPrefix +
								`⚡ Sub-agent killed by SIGTERM (exit 143) after ${makeDiagnosticFooter()}.\n` +
								`This means the subagent process received a termination signal — usually ` +
								`a wall-clock timeout from an external watcher. The runner retried automatically.\n\n` +
								`${summary}` +
								makeSplitGuidance(),
						},
					],
					details: { results: [result] },
					isError: true,
				};
			}

			// ── Timeout ───────────────────────────────────────────────────────────
			if (result.stopReason === "timeout") {
				const summary = partialText
					? `Partial result before timeout:\n${partialText}\n\n`
					: "";
				return {
					content: [
						{
							type: "text" as const,
							text:
								warningPrefix +
								`⏰ Sub-agent timed out — ${makeDiagnosticFooter()}.\n` +
								`${summary}` +
								`Task too broad for one sub-agent.` +
								makeSplitGuidance(),
						},
					],
					details: { results: [result] },
					isError: true,
				};
			}

			if (result.stopReason === "max_turns") {
				const summary = partialText
					? `Partial result:\n${partialText}\n\n`
					: "";
				return {
					content: [
						{
							type: "text" as const,
							text:
								warningPrefix +
								`🔄 Sub-agent hit max turns (${result.maxTurns}) — ${makeDiagnosticFooter()}.\n` +
								`${summary}` +
								`Task too broad. Reduce maxTurns and split into focused subtasks.` +
								makeSplitGuidance(),
						},
					],
					details: { results: [result] },
					isError: true,
				};
			}

			if (isResultError(result)) {
				const displayText = partialText || getResultSummaryText(result);
				return {
					content: [
						{
							type: "text" as const,
							text:
								warningPrefix +
								`✗ Sub-agent failed — ${makeDiagnosticFooter()}.\n` +
								`${result.errorMessage ? result.errorMessage + "\n\n" : ""}` +
								(displayText && displayText !== getResultSummaryText(result) ? displayText + "\n\n" : "") +
								(isResultRecoverable(result)
									? "This is a recoverable failure. Try splitting the task and retrying.\n" + makeSplitGuidance()
									: "Non-recoverable error. Check input validity.\n"),
						},
					],
					details: { results: [result] },
					isError: true,
				};
			}

			// Success path
			return {
				content: [
					{
						type: "text" as const,
						text: partialText || getResultSummaryText(result) || "Sub-agent completed successfully.",
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
