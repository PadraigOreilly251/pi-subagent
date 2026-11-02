export interface NudgeRules {
	enabled: boolean;
	cooldownSec: number;
	maxPerSession: number;
	contextPct: number;
	researchStreak: number;
	bigResultBytes: number;
	convertWindowSec: number;
	batchItems: number;
}

export interface NudgeState {
	contextTokens: number;
	contextWindow: number;
	inlineResearchCalls: number;
	nudgesSent: number;
	lastNudgeAtSec: number;
	lastNudgeKind: string | null;
	delegated: boolean;
	delegatedAtSec: number;
	operatorDisabled: boolean;
}

export interface NudgeTextOpts {
	reason: string;
	bytes?: number;
	subject?: string | null;
	contextTokens?: number;
	contextWindow?: number;
	researchCalls?: number;
	batchCount?: number;
	modelText: string;
	concurrency: number;
	nudgeNo: number;
	max: number;
}

export declare const DEFAULT_RULES: NudgeRules;
export declare const RESEARCH_TOOLS: Set<string>;
export declare function makeState(): NudgeState;
export declare function nowSec(): number;
export declare function isOperatorVeto(text: string | null | undefined): boolean;
export declare function countEnumeration(text: string): number;
export declare function resultByteSize(content: unknown): number;
export declare function extractSubject(toolName: string, input: unknown): string | null;
export declare function canFire(state: NudgeState, rules: NudgeRules, atSec: number): boolean;
export declare function decideRunReason(
	state: NudgeState,
	rules: NudgeRules,
	promptText: string,
): "context" | "streak" | "batch" | null;
export declare function nudgeConverted(state: NudgeState, rules: NudgeRules, atSec: number): boolean;
export declare function buildNudgeText(opts: NudgeTextOpts): string | null;
