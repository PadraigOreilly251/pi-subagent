// Pure decision rules for the delegation nudge. No pi imports: unit-testable in isolation.
// See README.md "Delegation nudges".

export const DEFAULT_RULES = {
	/** Master switch. Off unless PI_SUBAGENT_NUDGE=1 or /subnudge on. */
	enabled: false,
	/** Minimum seconds between any two nudges. */
	cooldownSec: 600,
	/** Hard cap of nudges per session. */
	maxPerSession: 5,
	/** Fire 'context' reason when used context >= this fraction of the window. */
	contextPct: 0.6,
	/** Fire 'streak' reason after this many inline web/doc research calls since last delegation. */
	researchStreak: 5,
	/** Fire 'big-result' when a single tool result is at least this many bytes of text. */
	bigResultBytes: 25000,
	/** A subagent call this soon after a nudge counts as a conversion. */
	convertWindowSec: 1800,
	/** Enumerated items in one user prompt that qualify as 'batch' shape. */
	batchItems: 3,
};

/** Tools whose inline use counts toward the research streak. */
export const RESEARCH_TOOLS = new Set([
	"web_search",
	"web_fetch",
	"search_wikipedia",
	"scrape_dynamic",
	"document_parse",
	"document_search",
]);

export function makeState() {
	return {
		contextTokens: 0,
		contextWindow: 0,
		inlineResearchCalls: 0,
		nudgesSent: 0,
		lastNudgeAtSec: 0,
		lastNudgeKind: null,
		delegated: false,
		delegatedAtSec: 0,
		operatorDisabled: false,
	};
}

/** Now-in-seconds helper (integer, matches log comparisons). */
export function nowSec() {
	return Math.floor(Date.now() / 1000);
}

/** Operator suppression: "don't use subagents", "stop delegating", "never use sub-agents"... */
export function isOperatorVeto(text) {
	if (!text) return false;
	return /\b(don'?t|dont|do not|stop\s+(using|delegating)|avoid|never)\b[^.!?\n]{0,24}\b(sub-?agents?|delegat\w+)\b/i.test(
		text,
	);
}

/** Count enumerated items in a prompt: markdown bullets, numbered items, "1)"... */
export function countEnumeration(text) {
	if (!text) return 0;
	let n = 0;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*([-*•]|\d+[.)])\s+\S/.test(line)) n++;
	}
	return n;
}

/** Total text size of a tool result content array, in UTF-8 bytes. */
export function resultByteSize(content) {
	if (!Array.isArray(content)) return 0;
	let bytes = 0;
	for (const c of content) {
		if (c && c.type === "text" && typeof c.text === "string") {
			bytes += new TextEncoder().encode(c.text).length;
		}
	}
	return bytes;
}

/** Best-effort "what was this result about" subject for the nudge template. */
export function extractSubject(toolName, input) {
	if (!input || typeof input !== "object") return null;
	const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
	if (toolName === "read" || toolName === "document_parse" || toolName === "document_search") {
		return str(input.path);
	}
	if (toolName === "web_fetch") {
		return str(input.url);
	}
	if (toolName === "reddit") {
		const kind = str(input.action);
		const where = str(input.sub) || str(input.q) || str(input.url);
		return kind ? `reddit ${kind}${where ? " " + where : ""}` : where;
	}
	if (toolName === "bash") {
		const cmd = str(input.command);
		if (!cmd) return null;
		return cmd.length > 72 ? `${cmd.slice(0, 69)}...` : cmd;
	}
	return null;
}

/** Global spam gates shared by every trigger. */
export function canFire(state, rules, atSec) {
	if (!rules.enabled || state.operatorDisabled) return false;
	if (state.nudgesSent >= rules.maxPerSession) return false;
	if (atSec - state.lastNudgeAtSec < rules.cooldownSec) return false;
	return true;
}

/**
 * Reason for a run-start nudge, in priority order.
 * context pressure > research streak > batch shape. Returns null when nothing applies.
 */
export function decideRunReason(state, rules, promptText) {
	if (state.contextWindow > 0 && state.contextTokens / state.contextWindow >= rules.contextPct) {
		return "context";
	}
	if (state.inlineResearchCalls >= rules.researchStreak) {
		return "streak";
	}
	if (countEnumeration(promptText || "") >= rules.batchItems) {
		return "batch";
	}
	return null;
}

/** Did the model delegate soon enough after the last nudge to count it as converted? */
export function nudgeConverted(state, rules, atSec) {
	return (
		state.lastNudgeAtSec > 0 &&
		state.delegatedAtSec >= state.lastNudgeAtSec &&
		atSec - state.lastNudgeAtSec <= rules.convertWindowSec
	);
}

/**
 * Compose the nudge text. One compact block: what happened, the ready template,
 * current extension params, escape hatch.
 *
 * opts: { reason, bytes?, subject?, modelText, concurrency, nudgeNo, max }
 */
export function buildNudgeText(opts) {
	const { reason, bytes, subject, modelText, concurrency, nudgeNo, max } = opts;
	const serialOrPool = concurrency <= 1 ? "serial (1 at a time)" : `pool (${concurrency} concurrent)`;
	const tail = `Params now: model=${modelText} · ${serialOrPool} · nudge ${nudgeNo}/${max} this session · /subnudge off to silence`;

	let head;
	let task;
	switch (reason) {
		case "big-result":
			head = `You just pulled ${Math.round(bytes / 1024)}KB into your context via this result. If you only need specific facts from it, delegate: the raw bytes stay in the child, you get the digest.`;
			task = subject
				? `subagent({ name: "digest", task: "From ${subject}: extract <exactly what you need>. Return compact bullets, under 2000 words, no process narration. Do not read unrelated files.", maxTurns: 10, timeout: 240 })`
				: `subagent({ name: "digest", task: "From <path/url>: extract <exactly what you need>. Return compact bullets, under 2000 words, no process narration.", maxTurns: 10, timeout: 240 })`;
			break;
		case "context": {
			const pct = state_pct(opts);
			head = `Context is at ~${pct}% (${opts.contextTokens}/${opts.contextWindow} tokens). Long inline research from here risks compaction. A child has its own fresh window: offload the reading.`;
			task = `subagent({ name: "digest", task: "Investigate <topic>: read <sources> yourself; return only compact findings + citations under 2000 words.", maxTurns: 15, timeout: 300 })`;
			break;
		}
		case "streak":
			head = `${opts.researchCalls} web/doc calls inline so far with no delegation. Each result is permanent context. Consider one child that reads everything and returns only the digest.`;
			task = `subagent({ name: "research", task: "Investigate <topic> from these sources: <list>. Return compact bullets + citations, under 2000 words.", maxTurns: 15, timeout: 300 })`;
			break;
		case "batch":
			head = `That prompt has ${opts.batchCount} enumerated items — a batch shape. Independent items fan out well: one child per item, you merge the returns.`;
			task = `subagent({ name: "item-N", task: "<one enumerated item, restated fully self-contained>", maxTurns: 15, timeout: 300 })  // per item`;
			break;
		default:
			return null;
	}
	return [`[delegation nudge] ${head}`, task, tail].join("\n");
}

function state_pct(opts) {
	if (!opts.contextWindow) return "?";
	return Math.round((opts.contextTokens / opts.contextWindow) * 100);
}
