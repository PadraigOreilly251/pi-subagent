/**
 * Pi Subagent Extension (Simplified)
 *
 * Delegates tasks to sub-agents running in isolated `pi` processes.
 *
 * Simplified design:
 * - Sub-agents identified by a freeform name (no config files)
 * - Sub-agents inherit the system prompt and the provider+model, but NOT the parent
 *   conversation: they run an empty ephemeral session and receive only the task string
 * - Sub-agents cannot spawn further sub-agents (child marker env + runner kill)
 * - No named agents, no tool sets, no model overrides
 *
 * This preserves KV cache stability: the main agent's KV cache prefix
 * remains valid because the system prompt is never modified (auto-injected constant text only).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { renderCall, renderResult } from "./render.js";
import { getFinalAssistantText, getResultSummaryText } from "./runner-events.js";
import { runAgent, SUBAGENT_CHILD_ENV } from "./runner.js";
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
// Concurrency gate
// ---------------------------------------------------------------------------

/**
 * Everything here is self-hosted: one llama.cpp server, 4 slots sharing a single KV
 * context (150k on one host, 110k on another). Concurrent sub-agents
 * contend for that compute and evict each other's cached prefix — measured 17s/turn
 * solo vs ~60s/turn each with 3 in flight — so locally the safe default is serial:
 * exactly ONE child at a time, extra calls queue. Raise the limit only if you point
 * children at a separate inference box. PI_SUBAGENT_MAX_PARALLEL seeds the default;
 * the /subconcurrency command changes it live (0 = serial/blocking, N = concurrent).
 */
// How many sub-agent children may run at once — live, settable via /subconcurrency.
// 0 = serial/blocking: one child at a time, the main workflow is on hold until it
// finishes. N = up to N children concurrent. PI_SUBAGENT_MAX_PARALLEL seeds the
// default; /subconcurrency overrides it for the process lifetime.
function concurrencyFromEnv(): number {
	const raw = Number(process.env.PI_SUBAGENT_MAX_PARALLEL ?? 1);
	return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 1;
}
let subagentConcurrency = concurrencyFromEnv();
let activeChildren = 0;
const slotWaiters: Array<() => void> = [];

/** Effective gate: never below 1, so 0 = serial/blocking (the single child still runs). */
function effectiveParallel(): number {
	return Math.max(1, subagentConcurrency);
}

async function acquireSlot(): Promise<void> {
	if (activeChildren >= effectiveParallel()) {
		await new Promise<void>((resolve) => slotWaiters.push(resolve));
	}
	activeChildren++;
}

/**
 * Turn a raw provider/stream error into something actionable. These three showed up over and
 * over in real session logs with no explanation attached: "404 status code (no body)",
 * "422", "Connection error.".
 */
function explainChildFailure(signal: string): string {
	const s = signal.toLowerCase();
	if (s.includes("404")) {
		return (
			"Hint: HTTP 404 — the provider+model the child used is not served by that inference server. " +
			"Children inherit this session's provider+model; verify it exists there, or point children " +
			"somewhere valid with PI_SUBAGENT_PROVIDER / PI_SUBAGENT_MODEL."
		);
	}
	if (s.includes("422")) {
		return (
			"Hint: HTTP 422 — the server rejected the request body. On llama.cpp that is almost always " +
			"context overflow (prompt + reserved response > n_ctx), frequently because a high thinking " +
			"level reserves most of the context. Lower the thinking level, shorten the task, or raise n_ctx."
		);
	}
	if (
		s.includes("connection error") ||
		s.includes("econnrefused") ||
		s.includes("fetch failed") ||
		s.includes("socket hang up")
	) {
		return (
			"Hint: the child could not reach the inference server (wrong host/port, server restarting, or an " +
			"endpoint missing OpenAI-compatible routes). Check that it answers /v1/models."
		);
	}
	if (s.includes("context length") || s.includes("too many tokens") || s.includes("exceeds the")) {
		return "Hint: context overflow — give the child a shorter task or a server with a larger context.";
	}
	return "";
}

function releaseSlot(): void {
	activeChildren = Math.max(0, activeChildren - 1);
	slotWaiters.shift()?.();
}

// ---------------------------------------------------------------------------
// Model override (per session)
// ---------------------------------------------------------------------------
//
// Default: children inherit the parent session's LIVE provider+model (ctx.model
// at call time — so switching the parent mid-session is followed automatically).
//
// The user can pin a different pi model for children with /submodel (interactive
// menu, no typing). The pin lives for the current session only: every
// session_start resets it back to inherit.

type ModelChoice = { provider: string; id: string };
const INHERIT_SENTINEL = "↺ inherit parent model (default)";
let modelOverride: ModelChoice | null = null;

function describeChoice(): string {
	return modelOverride ? `${modelOverride.provider}/${modelOverride.id} (pinned)` : "inherit parent";
}

/**
 * Menu label for a model from the live registry: provider/id + host + context
 * window + display name, so the user never has to type or memorise an id.
 */
function modelLabel(m: { provider?: string; id?: string; name?: string; baseUrl?: string; contextWindow?: number }): string {
	const host = String(m.baseUrl ?? "").replace(/^https?:\/\//, "").replace(/\/.*/, "") || "?";
	const ctxK = m.contextWindow ? `, ${Math.round(m.contextWindow / 1000)}k` : "";
	const name = m.name && m.name !== m.id ? ` — ${m.name}` : "";
	return `${m.provider}/${m.id} (${host}${ctxK})${name}`;
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

	const texts: string[] = [];
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

### Hard facts about this implementation (READ BEFORE DELEGATING)

1. **A sub-agent does NOT see this conversation.** It starts an empty ephemeral pi process and receives only your \`task\` string. Anything phrased as "as discussed above" is meaningless to it. Write self-contained tasks: goal, exact paths/URLs, constraints, output format.
2. **Sub-agent concurrency is serial by default.** One child at a time; parallel \`subagent\` calls in a single turn queue behind each other. The models are self-hosted (one llama.cpp server, few slots on one shared KV cache), so concurrency is unaffordable unless children point at a separate box — raise it only then (settable with /subconcurrency: 0 = serial/blocking, N = concurrent). Fan out sequentially — delegate one task, read the result, then delegate the next.
3. \`timeout\` is a real wall-clock kill and \`maxTurns\` really kills the child. Partial output is returned either way.
4. A child inherits the current provider+model (or the session's /submodel pin, if the user set one) and all parent tools except \`subagent\` (nested delegation is refused, and a child that tries it is killed). Success results carry a \`⚙ subagent model:\` note when a pin is active. 

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
			"Task description. MUST be self-contained: the sub-agent does NOT see the parent conversation, only this string. Include goal, exact paths/URLs, constraints, expected output format.",
	}),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Wall-clock seconds for the whole run. The child is KILLED at the deadline (partial output returned). Default: 600, hard ceiling 3600.",
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

	// The model pin is per-session: a fresh session (or resume of another one)
	// goes back to inheriting the parent's live model.
	pi.on("session_start", () => {
		modelOverride = null;
	});

	// Register the subagent tool
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to a sub-agent running in an isolated pi process.",
			"",
			"It starts an EMPTY ephemeral session: it does NOT see this conversation — only your `task` string,",
			"so the task must be fully self-contained (goal, exact paths/URLs, constraints, output format).",
			"It runs in the current provider+model and inherits all tools except `subagent`.",
			"Sub-agent concurrency is serial by default (settable via /subconcurrency — 0 = serial/blocking, N = concurrent). Self-hosted model, shared KV cache — extra calls queue, so delegate sequentially unless children point at a separate box.",
			"",
			"Optional parameters:",
			"  timeout: Wall-clock seconds before the child is killed (default: 600, ceiling 3600)",
			"  maxTurns: Max LLM turns/calls; the child is killed when exceeded (default: 50)",
			"",
			"Example: { name: \"researcher\", task: \"Research the latest about quantum computing\", timeout: 600 }",
		].join("\n"),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Nested delegation guard: children are spawned with PI_SUBAGENT_CHILD=1.
			// Refusing here is the only reliable guard — the event-stream check in
			// runner-events.js merely records the violation after the fact.
			if (process.env[SUBAGENT_CHILD_ENV] === "1") {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"✗ Refused: you are already a sub-agent. Nested sub-agents are not allowed. " +
								"Do this work yourself with your own tools (read/bash/web_search/...).",
						},
					],
					details: { results: [] },
					isError: true,
				};
			}

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

			// Serialise children on the shared inference slot unless overridden.
			if (activeChildren >= effectiveParallel()) {
				onUpdate?.({
					content: [
						{
							type: "text" as const,
							text: `queued: waiting for a free sub-agent slot (max ${effectiveParallel()} concurrent)`,
						},
					],
					details: { results: [] },
				});
			}
			await acquireSlot();
			let result;
			try {
				result = await runAgent({
					cwd: ctx.cwd,
					agentName: params.name,
					task: params.task,
					taskCwd: params.cwd,
					signal,
					onUpdate,
					makeDetails: (results) => ({ results }),
					timeout: timeoutMs,
					maxTurns,
					// Model pin (/submodel) wins; otherwise the live session's provider+model —
					// NOT the settings.json default. The pi process does NOT carry PI_MODEL/
					// PI_PROVIDER in its own process.env (those are injected into bash-tool
					// children by bash.ts), so reading process.env.PI_MODEL silently fell
					// through to settings.json's defaultModel — every child 404'd.
					modelProvider: (modelOverride ?? ctx.model)?.provider,
					modelId: (modelOverride ?? ctx.model)?.id,
				});
			} finally {
				releaseSlot();
			}

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
			// ── Recursion attempt (child killed) ──────────────────────────────
			if (result.stopReason === "subagent_recursion_blocked") {
				const recSummary = partialText ? `Partial result:\n${partialText}\n\n` : "";
				return {
					content: [
						{
							type: "text" as const,
							text:
								warningPrefix +
								`🚫 Sub-agent attempted nested delegation — ${makeDiagnosticFooter()}. Process killed.\n` +
								`${recSummary}` +
								`Re-issue the task with an explicit instruction not to delegate.`,
						},
					],
					details: { results: [result] },
					isError: true,
				};
			}

			// ── Timeout ──────────────────────────────────────────────────────
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
								`Hit the ${Math.round(timeoutMs / 1000)}s wall-clock timeout. Task too broad for one sub-agent.` +
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
				const hint = explainChildFailure(`${result.stderr} ${result.errorMessage ?? ""}`);
				return {
					content: [
						{
							type: "text" as const,
							text:
								warningPrefix +
								`✗ Sub-agent failed — ${makeDiagnosticFooter()}.\n` +
								`${result.errorMessage ? result.errorMessage + "\n\n" : ""}` +
								(hint ? hint + "\n\n" : "") +
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
			const overrideNote = modelOverride
				? `\n\n⚙ subagent model: ${modelOverride.provider}/${modelOverride.id} (pinned via /submodel)`
				: "";
			return {
				content: [
					{
						type: "text" as const,
						text: (partialText || getResultSummaryText(result) || "Sub-agent completed successfully.") + overrideNote,
					},
				],
				details: { results: [result] },
			};
		},

	renderCall: (args, theme) => renderCall(args, theme),
	renderResult: (result, { expanded }, theme) =>
		renderResult(result, expanded, theme),
	});

	// -----------------------------------------------------------------------
	// /submodel — interactive menu to pick which model sub-agent children run on.
	// No arg: open the picker. "reset" (alias "clear"): back to inheriting the
	// parent's live model. "show": print current choice.
	// -----------------------------------------------------------------------
	pi.registerCommand("submodel", {
		description:
			"Pick the model sub-agent children run on (menu; no typing). Default: inherit the parent's current model. Args: 'reset' = inherit, 'show' = current.",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "reset" || arg === "clear" || arg === "inherit") {
				modelOverride = null;
				ctx.ui.setStatus("subagent", undefined);
				ctx.ui.notify("subagent model: inherit parent's current model (default)", "info");
				return;
			}
			if (arg === "show") {
				ctx.ui.notify(`subagent model: ${describeChoice()}`, "info");
				return;
			}
			if (arg) {
				ctx.ui.notify(`unknown /submodel arg '${args.trim()}' — menu (no arg), 'show', or 'reset'`, "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("/submodel menu needs the interactive TUI (not available in print mode). Use '/submodel reset'.", "error");
				return;
			}

			// Live model catalogue from the session's registry (same data /model shows).
			let models: Array<ModelChoice & { label: string }> = [];
			try {
				const all = ctx.modelRegistry?.getAvailable?.() ?? ctx.modelRegistry?.getAll?.() ?? [];
				models = all
					.filter((m) => typeof m?.id === "string" && typeof m?.provider === "string")
					.map((m) => ({ provider: m.provider, id: m.id, label: modelLabel(m) }));
			} catch {
				models = [];
			}
			if (models.length === 0) {
				ctx.ui.notify("no models in the session model registry — check your provider config", "error");
				return;
			}
			const options = [INHERIT_SENTINEL, ...models.map((m) => m.label)];
			const choice = await ctx.ui.select(`Subagent model (current: ${describeChoice()})`, options);
			if (choice === undefined) return; // user cancelled

			if (choice === INHERIT_SENTINEL) {
				modelOverride = null;
				ctx.ui.setStatus("subagent", undefined);
				ctx.ui.notify("subagent model: inherit parent's current model (default)", "info");
				return;
			}
			const hit = models.find((m) => m.label === choice);
			if (!hit) return;
			modelOverride = { provider: hit.provider, id: hit.id };
			ctx.ui.setStatus("subagent", `subagent: ${hit.provider}/${hit.id}`);
			ctx.ui.notify(`subagent model: ${hit.provider}/${hit.id}`, "info");
		},
	});

	// -----------------------------------------------------------------------
	// /subconcurrency (alias /submodelnumber) — how many sub-agent children may
	// run at once. 0 = serial/blocking (main workflow on hold until the child
	// finishes). N = up to N concurrent. No arg: show current.
	// -----------------------------------------------------------------------
	const subconcurrencyHandler = async (args: string, ctx) => {
		const arg = args.trim();
		if (!arg) {
			const desc =
				subagentConcurrency === 0
					? "0 (serial — main workflow on hold until the child finishes)"
					: `${subagentConcurrency} (up to ${subagentConcurrency} concurrent)`;
			ctx.ui.notify(`subagent concurrency: ${desc}`, "info");
			return;
		}
		const n = Number(arg);
		if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
			ctx.ui.notify(`invalid /subconcurrency '${arg}' — use an integer 0..N (0 = serial/blocking)`, "error");
			return;
		}
		subagentConcurrency = n;
		if (n === 1) ctx.ui.setStatus("subagent-conc", undefined);
		else if (n === 0) ctx.ui.setStatus("subagent-conc", "subagent: serial");
		else ctx.ui.setStatus("subagent-conc", `subagent: ${n} concurrent`);
		const desc =
			n === 0
				? "0 (serial — main workflow on hold until the child finishes)"
				: `${n} (up to ${n} concurrent)`;
		ctx.ui.notify(`subagent concurrency: ${desc}`, "info");
	};

	pi.registerCommand("subconcurrency", {
		description:
			"Set how many sub-agent children run at once. 0 = serial/blocking (main workflow on hold until the child finishes), N = up to N concurrent. No arg: show current.",
		handler: subconcurrencyHandler,
	});
	pi.registerCommand("submodelnumber", {
		description:
			"Alias for /subconcurrency — set how many sub-agent children run at once (0 = serial/blocking, N = concurrent).",
		handler: subconcurrencyHandler,
	});
}
