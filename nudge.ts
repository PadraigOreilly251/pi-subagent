// Delegation nudge controller: watches live session signals and injects one-line,
// situationally-true nudges toward the subagent tool. Off by default
// (PI_SUBAGENT_NUDGE=1 or /subnudge on). Never touches the system prompt: nudges
// ride tool-result footers and custom transcript entries (append-only, KV-safe).
//
// Pure decision logic lives in nudge-rules.js (unit-tested); this file is wiring.

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolResultEventResult,
	BeforeAgentStartEventResult,
} from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_RULES,
	RESEARCH_TOOLS,
	makeState,
	nowSec,
	isOperatorVeto,
	countEnumeration,
	resultByteSize,
	extractSubject,
	canFire,
	decideRunReason,
	nudgeConverted,
	buildNudgeText,
} from "./nudge-rules.js";

export interface NudgeParams {
	/** Human-readable current model resolution, e.g. "inherit qwen3.8-27b" or "pinned qwen3.6-27b". */
	modelText: string;
	/** Current max concurrent subagents. */
	concurrency: number;
}

function userText(message: unknown): string {
	const m = message as { role?: string; content?: unknown };
	if (!m || m.role !== "user") return "";
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		return m.content
			.filter((c: any) => c?.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

export function attachNudgeController(
	pi: ExtensionAPI,
	getParams: (ctx: ExtensionContext) => NudgeParams,
): void {
	// Children must never nudge — they are the delegates, not the delegator.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	const state = makeState();
	const rules = { ...DEFAULT_RULES, enabled: process.env.PI_SUBAGENT_NUDGE === "1" };

	const log = (data: Record<string, unknown>): void => {
		try {
			pi.appendEntry("subagent_nudge", data);
		} catch {
			/* logging must never break the session */
		}
	};

	pi.on("session_start", () => {
		// fresh budget each session; rules.enabled persists within this process's session
		state.contextTokens = 0;
		state.contextWindow = 0;
		state.inlineResearchCalls = 0;
		state.nudgesSent = 0;
		state.lastNudgeAtSec = 0;
		state.lastNudgeKind = null;
		state.delegated = false;
		state.delegatedAtSec = 0;
		state.operatorDisabled = false;
	});

	// Operator suppression: a "don't use subagents" message silences nudges for the session.
	pi.on("message_start", (event, ctx) => {
		const text = userText(event.message);
		if (text && isOperatorVeto(text)) {
			const wasEnabled = rules.enabled;
			rules.enabled = false;
			state.operatorDisabled = true;
			if (wasEnabled) {
				log({ kind: "operator-veto", snippet: text.slice(0, 120) });
				ctx.ui.notify(
					"Subagent nudges disabled for this session (matched your message). /subnudge on to re-enable.",
					"info",
				);
			}
		}
	});

	// Counters: inline research vs delegation; conversion tracking.
	pi.on("tool_call", (event) => {
		if (event.toolName === "subagent") {
			const t = nowSec();
			// Record the delegation first: `nudgeConverted` requires
			// delegatedAtSec >= lastNudgeAtSec (same-second delegation must count).
			state.delegated = true;
			state.delegatedAtSec = t;
			if (nudgeConverted(state, rules, t)) {
				log({ kind: "converted", afterReason: state.lastNudgeKind });
			}
			state.inlineResearchCalls = 0;
			return;
		}
		if (RESEARCH_TOOLS.has(event.toolName)) {
			state.inlineResearchCalls += 1;
		}
	});

	// Channel 1: footer on oversized tool results.
	pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
		if (event.toolName === "subagent") return undefined;
		if (!rules.enabled) return undefined;
		const bytes = resultByteSize(event.content);
		if (bytes < rules.bigResultBytes) return undefined;
		const t = nowSec();
		if (!canFire(state, rules, t)) return undefined;

		const { modelText, concurrency } = getParams(ctx);
		const text = buildNudgeText({
			reason: "big-result",
			bytes,
			subject: extractSubject(event.toolName, event.input),
			modelText,
			concurrency,
			nudgeNo: state.nudgesSent + 1,
			max: rules.maxPerSession,
		});
		if (!text) return undefined;
		state.nudgesSent += 1;
		state.lastNudgeAtSec = t;
		state.lastNudgeKind = "big-result";
		log({ kind: "nudge", reason: "big-result", tool: event.toolName, bytes });
		const out: ToolResultEventResult = {
			content: [...event.content, { type: "text" as const, text: `\n\n${text}` }],
		};
		// Preserve structured content alongside the replaced content array.
		if (event.structuredContent !== undefined) out.structuredContent = event.structuredContent;
		return out;
	});

	// Context token tracking from assistant usage.
	pi.on("message_end", (event) => {
		const m = event.message as { role?: string; usage?: Record<string, number> };
		if (m?.role === "assistant" && m.usage) {
			state.contextTokens = (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
		}
	});

	// Channel 2: run-start nudge (context pressure / research streak / batch shape).
	pi.on("before_agent_start", async (event, ctx): Promise<BeforeAgentStartEventResult | undefined> => {
		state.contextWindow = ctx.model?.contextWindow ?? state.contextWindow;
		if (!rules.enabled) return undefined;
		const t = nowSec();
		if (!canFire(state, rules, t)) return undefined;
		// Runtime v1.4.0: event carries .prompt directly, no `messageType` field
		// (newer pi-mono source added the user/custom union; stay shape-safe).
		const promptText = typeof (event as { prompt?: unknown }).prompt === "string" ? (event as { prompt: string }).prompt : "";
		const reason = decideRunReason(state, rules, promptText);
		if (!reason) return undefined;

		const { modelText, concurrency } = getParams(ctx);
		const text = buildNudgeText({
			reason,
			contextTokens: state.contextTokens,
			contextWindow: state.contextWindow,
			researchCalls: state.inlineResearchCalls,
			batchCount: countEnumeration(promptText),
			modelText,
			concurrency,
			nudgeNo: state.nudgesSent + 1,
			max: rules.maxPerSession,
		});
		if (!text) return undefined;
		state.nudgesSent += 1;
		state.lastNudgeAtSec = t;
		state.lastNudgeKind = reason;
		log({ kind: "nudge", reason });
		return {
			message: {
				customType: "subagent_nudge",
				content: text,
				display: true,
				details: { reason },
			},
		};
	});

	pi.registerCommand("subnudge", {
		description: "Delegation nudges: /subnudge on | off | status",
		handler: async (args: string, ctx: ExtensionContext) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "on" || sub === "off") {
				rules.enabled = sub === "on";
				if (sub === "on") state.operatorDisabled = false; // explicit re-enable clears a veto
				log({ kind: "toggle", enabled: rules.enabled });
				ctx.ui.notify(
					rules.enabled
						? `Delegation nudges ON — cooldown ${rules.cooldownSec}s, cap ${rules.maxPerSession}/session. Triggers: big result ≥${Math.round(rules.bigResultBytes / 1024)}KB · context ≥${Math.round(rules.contextPct * 100)}% · research streak ≥${rules.researchStreak} · batch ≥${rules.batchItems} items.`
						: "Delegation nudges OFF.",
					"info",
				);
				return;
			}
			const pct = state.contextWindow
				? `${Math.round((state.contextTokens / state.contextWindow) * 100)}%`
				: "?";
			const { modelText, concurrency } = getParams(ctx);
			ctx.ui.notify(
				[
					`Nudges: ${rules.enabled ? "ON" : "OFF"} (seed PI_SUBAGENT_NUDGE=${process.env.PI_SUBAGENT_NUDGE ?? "unset"})`,
					`Sent: ${state.nudgesSent}/${rules.maxPerSession} · last: ${state.lastNudgeKind ?? "none"} · cooldown ${rules.cooldownSec}s`,
					`Now: context ${pct} (${state.contextTokens}/${state.contextWindow ?? "?"} tokens) · inline research ${state.inlineResearchCalls}/${rules.researchStreak} · delegated: ${state.delegated ? "yes" : "no"}`,
					`Params: model=${modelText} · concurrency=${concurrency}`,
					"Audit: appendEntry type 'subagent_nudge' (nudges, conversions, vetoes, toggles).",
				].join("\n"),
				"info",
			);
		},
	});
}
