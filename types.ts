/**
 * Shared type definitions for the subagent extension.
 *
 * Phase 1: Single sub-agent only. Fork mode (full context inheritance).
 * No parallel execution. No spawn mode.
 */

import type { Message } from "@mariozechner/pi-ai";
import { getFinalAssistantText } from "./runner-events.js";

/** Aggregated token usage from a subagent run. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Result of a single subagent invocation. */
export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sawAgentEnd?: boolean;
	timeout?: boolean; // true if killed due to timeout
	maxTurns?: number; // max turns limit (set by runner for enforcement)
}

/** Metadata attached to every tool result for rendering. */
export interface SubagentDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** A display-friendly representation of a message part. */
export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

/** Create an empty UsageStats object. */
export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Sum usage across multiple results. */
export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

/** Whether the child emitted a final assistant text response. */
export function hasFinalAssistantOutput(r: Pick<SingleResult, "messages">): boolean {
	return getFinalAssistantText(r.messages).trim().length > 0;
}

/** Whether the child semantically completed the run. */
export function hasSemanticCompletion(r: Pick<SingleResult, "messages" | "sawAgentEnd">): boolean {
	return Boolean(r.sawAgentEnd) && hasFinalAssistantOutput(r);
}

/** Whether a result should be treated as successful by the wrapper/UI. */
export function isResultSuccess(r: SingleResult): boolean {
	const sc = hasSemanticCompletion(r);
	const exitNotMinus1 = r.exitCode !== -1;
	const notTimeoutOrMaxTurns = r.stopReason !== "timeout" && r.stopReason !== "max_turns";
	const exitCodeZero = r.exitCode === 0;
	const notErrorAborted = r.stopReason !== "error" && r.stopReason !== "aborted";
	console.error(`[DEBUG isResultSuccess] exitCode=${r.exitCode} stopReason=${r.stopReason} errorMessage=${r.errorMessage} sawAgentEnd=${r.sawAgentEnd} messages.length=${r.messages.length} sc=${sc} exitNotMinus1=${exitNotMinus1} notTimeoutOrMaxTurns=${notTimeoutOrMaxTurns} exitCodeZero=${exitCodeZero} notErrorAborted=${notErrorAborted}`);
	if (r.exitCode === -1) return false;
	// Explicitly reject timeout and max_turns even with semantic completion
	if (r.stopReason === "timeout" || r.stopReason === "max_turns") return false;
	if (sc) return true;
	return r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted";
}

/** Whether a result represents an error. */
export function isResultError(r: SingleResult): boolean {
	const exitNotMinus1 = r.exitCode !== -1;
	const success = isResultSuccess(r);
	console.error(`[DEBUG isResultError] exitNotMinus1=${exitNotMinus1} success=${success} => ${!success}`);
	if (r.exitCode === -1) return false;
	return !success;
}

//** Reconcile process exit status with semantic completion observed from Pi's event stream. */
export function normalizeCompletedResult(result: SingleResult, wasAborted: boolean): SingleResult {
	const hasSemanticSuccess = hasSemanticCompletion(result);
	console.error(`[DEBUG normalizeCompletedResult] BEFORE: exitCode=${result.exitCode} stopReason=${result.stopReason} sawAgentEnd=${result.sawAgentEnd} messages.length=${result.messages.length} hasSemanticSuccess=${hasSemanticSuccess} wasAborted=${wasAborted} timeout=${result.timeout} maxTurns=${result.maxTurns} stderr=${result.stderr.substring(0,100)}`);

	if (wasAborted) {
		if (hasSemanticSuccess) {
			result.exitCode = 0;
			if (result.stopReason === "aborted") result.stopReason = undefined;
			if (result.errorMessage === "Subagent was aborted.") {
				result.errorMessage = undefined;
			}
		} else {
			result.exitCode = 130;
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted.";
			if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
		}
		return result;
	}

	// Handle timeout (runner already set exitCode, stopReason, errorMessage)
	if (result.timeout) {
		result.exitCode = 124;
		result.stopReason = "timeout";
		if (!result.errorMessage && result.stderr.trim()) {
			result.errorMessage = result.stderr.trim();
		}
		if (!result.stderr.trim()) result.stderr = result.errorMessage || "Sub-agent timed out.";
		return result;
	}

	// Handle max turns exceeded (runner already set exitCode, stopReason, errorMessage)
	if (result.maxTurns) {
		result.exitCode = 1;
		result.stopReason = "max_turns";
		if (!result.errorMessage && result.stderr.trim()) {
			result.errorMessage = result.stderr.trim();
		}
		if (!result.stderr.trim()) result.stderr = result.errorMessage || "Sub-agent exceeded maximum turns.";
		return result;
	}

	if (result.exitCode > 0) {
		if (hasSemanticSuccess) {
			result.exitCode = 0;
			if (result.stopReason === "error") result.stopReason = undefined;
			if (result.errorMessage === result.stderr.trim()) {
				result.errorMessage = undefined;
			}
		} else {
			if (!result.stopReason) result.stopReason = "error";
			if (!result.errorMessage && result.stderr.trim()) {
				result.errorMessage = result.stderr.trim();
			}
		}
	}

	console.error(`[DEBUG normalizeCompletedResult] AFTER: exitCode=${result.exitCode} stopReason=${result.stopReason} errorMessage=${result.errorMessage}`);
	return result;
}

/** Extract the last assistant text from a message history. */
export function getFinalOutput(messages: Message[]): string {
	return getFinalAssistantText(messages);
}

/** Extract all display-worthy items from a message history. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					items.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
				}
			}
		}
	}
	return items;
}
