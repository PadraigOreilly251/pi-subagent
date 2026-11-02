import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_RULES,
	RESEARCH_TOOLS,
	makeState,
	isOperatorVeto,
	countEnumeration,
	resultByteSize,
	extractSubject,
	canFire,
	decideRunReason,
	nudgeConverted,
	buildNudgeText,
} from "../../nudge-rules.js";

const rules = { ...DEFAULT_RULES };

test("veto: explicit suppressions match", () => {
	assert.ok(isOperatorVeto("don't use subagents here"));
	assert.ok(isOperatorVeto("Please do not use sub-agents for this"));
	assert.ok(isOperatorVeto("stop delegating to subagents"));
	assert.ok(isOperatorVeto("never delegate this"));
	assert.ok(isOperatorVeto("avoid subagents, thermal throttling"));
});

test("veto: positive/neutral mentions do not match", () => {
	assert.ok(!isOperatorVeto("use subagents for the digests"));
	assert.ok(!isOperatorVeto("the report has no subagent output — check the log"));
	assert.ok(!isOperatorVeto("how many subagents ran?"));
	assert.ok(!isOperatorVeto(""));
	assert.ok(!isOperatorVeto(null));
});

test("enumeration counts bullets and numbered items", () => {
	assert.equal(countEnumeration("- a\n- b\n- c"), 3);
	assert.equal(countEnumeration("1. one\n2. two\n3. three\n4. four"), 4);
	assert.equal(countEnumeration("* x\n• y\n1) z"), 3);
	assert.equal(countEnumeration("prose only, no items"), 0);
	assert.equal(countEnumeration(""), 0);
});

test("resultByteSize measures UTF-8 bytes of text parts only", () => {
	assert.equal(resultByteSize([{ type: "text", text: "hello" }]), 5);
	assert.equal(resultByteSize([{ type: "text", text: "ä€" }]), new TextEncoder().encode("ä€").length);
	assert.equal(resultByteSize([{ type: "image" }, { type: "text", text: "x" }]), 1);
	assert.equal(resultByteSize("nope"), 0);
});

test("extractSubject finds path/url/command subjects", () => {
	assert.equal(extractSubject("read", { path: "/tmp/big.txt" }), "/tmp/big.txt");
	assert.equal(extractSubject("document_parse", { path: "/x/y.pdf" }), "/x/y.pdf");
	assert.equal(extractSubject("web_fetch", { url: "https://a.b/c" }), "https://a.b/c");
	assert.equal(extractSubject("reddit", { action: "thread", url: "https://r/1" }), "reddit thread https://r/1");
	assert.equal(extractSubject("bash", { command: "cat /etc/passwd" }), "cat /etc/passwd");
	const long = extractSubject("bash", { command: "x".repeat(200) });
	assert.ok(long.length <= 72 && long.endsWith("..."));
	assert.equal(extractSubject("read", {}), null);
});

test("canFire: respects enabled, operatorDisabled, cap, cooldown", () => {
	const st = makeState();
	assert.ok(!canFire(st, { ...rules, enabled: false }, 1000), "disabled never fires");
	const en = { ...rules, enabled: true };
	assert.ok(canFire(st, en, 1000));
	const st2 = makeState();
	st2.operatorDisabled = true;
	assert.ok(!canFire(st2, en, 1000));
	st2.operatorDisabled = false;
	st2.nudgesSent = rules.maxPerSession;
	assert.ok(!canFire(st2, en, 1000), "cap");
	st2.nudgesSent = 1;
	st2.lastNudgeAtSec = 950;
	assert.ok(!canFire(st2, en, 951), "cooldown");
	assert.ok(canFire(st2, en, 950 + rules.cooldownSec), "cooldown expired");
});

test("decideRunReason: priority context > streak > batch", () => {
	const st = makeState();
	assert.equal(decideRunReason(st, rules, "hi"), null);

	st.inlineResearchCalls = rules.researchStreak;
	assert.equal(decideRunReason(st, rules, "anything"), "streak");

	st.contextWindow = 100_000;
	st.contextTokens = 61_000;
	assert.equal(decideRunReason(st, rules, "anything"), "context", "context beats streak");

	const st2 = makeState();
	assert.equal(decideRunReason(st2, rules, "- a\n- b\n- c"), "batch");
	assert.equal(decideRunReason(st2, rules, "- a\n- b"), null, "below batch threshold");
});

test("nudgeConverted: delegation inside window after a nudge", () => {
	const st = makeState();
	assert.ok(!nudgeConverted(st, rules, 100), "no nudge yet");
	st.lastNudgeAtSec = 100;
	assert.ok(!nudgeConverted(st, rules, 200), "no delegation yet");
	st.delegatedAtSec = 150;
	assert.ok(nudgeConverted(st, rules, 160));
	assert.ok(!nudgeConverted(st, rules, 100 + rules.convertWindowSec + 1), "outside window");
	st.delegatedAtSec = 50;
	assert.ok(!nudgeConverted(st, { ...rules }, 60), "delegation before nudge doesn't count");
});

test("buildNudgeText: includes live params + template for each reason", () => {
	const common = { modelText: "inherit qwen3.8-27b", concurrency: 1, nudgeNo: 2, max: 5 };
	const big = buildNudgeText({ ...common, reason: "big-result", bytes: 40_000, subject: "/tmp/big.txt" });
	assert.match(big, /\[delegation nudge\]/);
	assert.match(big, /39KB/);
	assert.match(big, /subagent\(\{ name: "digest", task: "From \/tmp\/big\.txt/);
	assert.match(big, /model=inherit qwen3\.8\-27b/);
	assert.match(big, /nudge 2\/5/);
	assert.match(big, /\/subnudge off/);

	const ctx = buildNudgeText({
		...common,
		reason: "context",
		contextTokens: 70_000,
		contextWindow: 100_000,
	});
	assert.match(ctx, /~70%/);

	const streak = buildNudgeText({ ...common, reason: "streak", researchCalls: 6 });
	assert.match(streak, /6 web\/doc calls/);

	const batch = buildNudgeText({ ...common, reason: "batch", batchCount: 4 });
	assert.match(batch, /4 enumerated items/);
	assert.match(batch, /item-N/);

	assert.equal(buildNudgeText({ ...common, reason: "bogus" }), null);
});

test("RESEARCH_TOOLS covers the heavy inline readers", () => {
	for (const t of ["web_search", "web_fetch", "search_wikipedia", "document_parse"]) {
		assert.ok(RESEARCH_TOOLS.has(t), t);
	}
	assert.ok(!RESEARCH_TOOLS.has("read"), "plain read counts as big-result trigger, not streak");
});
