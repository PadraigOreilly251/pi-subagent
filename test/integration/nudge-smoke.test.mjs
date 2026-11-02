// Live-load smoke test for the delegation nudge: loads the REAL extension via jiti
// with a mock ExtensionAPI and exercises each trigger channel.
// Machine-dependent (expects a local pi-mono checkout); skips gracefully elsewhere.
import { existsSync } from "node:fs";
const PI_MONO = process.env.PI_MONO_PATH || "/home/erpod/pi-mono";
if (!existsSync(`${PI_MONO}/node_modules/jiti/lib/jiti.mjs`) || !existsSync(`${PI_MONO}/packages/coding-agent/dist/index.js`)) {
	console.log("SKIP nudge-smoke: local pi-mono checkout not found (set PI_MONO_PATH)");
	process.exit(0);
}
const EXT = "/home/erpod/.pi/agent/extensions/pi-subagent/index.ts";
const { createJiti } = await import("/home/erpod/pi-mono/node_modules/jiti/lib/jiti.mjs").catch(async () => {
	const m = await import("/home/erpod/pi-mono/node_modules/jiti/lib/jiti.mjs");
	return m;
});

const alias = {
	"@mariozechner/pi-coding-agent": `${PI_MONO}/packages/coding-agent/dist/index.js`,
	"@mariozechner/pi-tui": `${PI_MONO}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	"@sinclair/typebox": `${PI_MONO}/node_modules/typebox/build/index.mjs`,
};

function makePi() {
	const handlers = {};
	const commands = {};
	const tools = {};
	const entries = [];
	const notifications = [];
	return {
		handlers, commands, tools, entries, notifications,
		on(event, fn) { (handlers[event] ||= []).push(fn); return () => {}; },
		registerTool(def) { tools[def.name] = def; },
		registerCommand(name, def) { commands[name] = def; },
		appendEntry(type, data) { entries.push({ type, data }); },
		ui: {
			notify(msg) { notifications.push(msg); },
			setStatus() {},
		},
	};
}

const ctx = {
	mode: "rpc", hasUI: false, cwd: "/tmp",
	model: { id: "qwen3.8-27b", provider: "local", contextWindow: 150000 },
	modelRegistry: {}, scopedModels: [], isIdle: true,
};

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
	if (cond) { pass++; console.log("PASS", name); }
	else { fail++; console.log("FAIL", name, extra); }
}

async function freshLoad(tag) {
	const jiti = createJiti(EXT, { alias, cache: false });
	const mod = await jiti.import(`${EXT}?fresh=${tag}-${Date.now()}`);
	const pi = makePi();
	await mod.default(pi);
	return { pi };
}

async function runAll(pi, event, extraCtx) {
	const hs = pi.handlers[event] || [];
	let last;
	const merged = { ...extraCtx };
	for (const h of hs) {
		const r = await h(merged, { ...ctx, ui: pi.ui });
		if (r) Object.assign(merged, r);
		last = r;
	}
	return merged;
}

// --- Parent scenario: nudge enabled ---
process.env.PI_SUBAGENT_NUDGE = "1";
process.env.PI_SUBAGENT_CHILD = "0";
{
	const { pi } = await freshLoad("p1");

	check("registers subagent tool", !!pi.tools.subagent);
	check("registers /subnudge", !!pi.commands.subnudge);

	// Trigger 1: big result footer
	const big = { type: "tool_result", toolCallId: "t1", toolName: "read",
		input: { path: "/tmp/big.txt" }, isError: false,
		content: [{ type: "text", text: "x".repeat(30000) }] };
	const r1 = await (pi.handlers.tool_result[0])(big, { ...ctx, ui: pi.ui });
	check("big-result returns modified content", Array.isArray(r1?.content) && r1.content.length === 2,
		JSON.stringify(r1?.content?.length));
	check("footer contains marker + subject", r1?.content?.[1]?.text?.includes("[delegation nudge]")
		&& r1.content[1].text.includes("/tmp/big.txt"));
	check("footer carries live params", r1.content[1].text.includes("inherit qwen3.8-27b")
		&& r1.content[1].text.includes("nudge 1/5"));
	check("audit entry logged", pi.entries.some(e => e.type === "subagent_nudge" && e.data.kind === "nudge"
		&& e.data.reason === "big-result"));

	// Trigger 2: batch shape on before_agent_start (cooldown blocks now — expected undefined message)
	const merged = await runAll(pi, "before_agent_start", { type: "before_agent_start", prompt: "- one\n- two\n- three" });
	check("system prompt kept by index handler (nudge never breaks it)", typeof merged.systemPrompt === "string" && merged.systemPrompt.length > 100);
	check("cooldown blocks the immediate second nudge", merged.message === undefined);

	// Conversion: subagent call right after nudge window
	await (pi.handlers.tool_call[0])({ type: "tool_call", toolCallId: "t2", toolName: "subagent", input: {} });
	check("conversion logged", pi.entries.some(e => e.type === "subagent_nudge" && e.data.kind === "converted"));

	// Veto silences further nudges
	await runAll(pi, "message_start", { type: "message_start", message: { role: "user", content: "don't use subagents anymore" } });
	check("veto logged", pi.entries.some(e => e.type === "subagent_nudge" && e.data.kind === "operator-veto"));
	const r2 = await (pi.handlers.tool_result[0])({ ...big, toolCallId: "t3" }, { ...ctx, ui: pi.ui });
	check("no footer after veto", r2 === undefined);

	// status command works
	pi.notifications.length = 0;
	await pi.commands.subnudge.handler("status", { ...ctx, ui: pi.ui });
	check("status output", pi.notifications.some(n => n.includes("Nudges: OFF")));
}

// --- Veto BEFORE any nudge: /subnudge on re-enables immediately ---
{
	const { pi } = await freshLoad("p3");
	await runAll(pi, "message_start", { type: "message_start", message: { role: "user", content: "don't use subagents" } });
	const blocked = await (pi.handlers.tool_result[0])({
		type: "tool_result", toolCallId: "v1", toolName: "read",
		input: { path: "/tmp/big.txt" }, isError: false,
		content: [{ type: "text", text: "x".repeat(30000) }],
	}, { ...ctx, ui: pi.ui });
	check("veto-before-nudge blocks", blocked === undefined);
	await pi.commands.subnudge.handler("on", { ...ctx, ui: pi.ui });
	const revived = await (pi.handlers.tool_result[0])({
		type: "tool_result", toolCallId: "v2", toolName: "read",
		input: { path: "/tmp/big.txt" }, isError: false,
		content: [{ type: "text", text: "x".repeat(30000) }],
	}, { ...ctx, ui: pi.ui });
	check("/subnudge on clears veto and fires again", Array.isArray(revived?.content) && revived.content.length === 2);
}

// --- Fresh load: run-start triggers (no prior nudge → no cooldown) ---
{
	const { pi } = await freshLoad("p2");
	// context pressure
	// simulate assistant usage 90k/150k
	await (pi.handlers.message_end.find(h => true))({ type: "message_end", message: { role: "assistant", usage: { input: 20000, output: 1000, cacheRead: 55000, cacheWrite: 15000 } } }, { ...ctx, ui: pi.ui });
	const merged = await runAll(pi, "before_agent_start", { type: "before_agent_start", prompt: "continue" });
	check("context-pressure nudge fires", merged.message?.customType === "subagent_nudge" && merged.message.details.reason === "context",
		JSON.stringify(merged.message?.details ?? null));
}

// --- Child scenario: controller not attached ---
{
	process.env.PI_SUBAGENT_CHILD = "1";
	const { pi } = await freshLoad("c1");
	check("child has NO /subnudge", !pi.commands.subnudge);
	check("child has no tool_result nudge handler", (pi.handlers.tool_result || []).length === 0);
	process.env.PI_SUBAGENT_CHILD = "0";
}

// --- Disabled scenario ---
{
	delete process.env.PI_SUBAGENT_NUDGE;
	const { pi } = await freshLoad("d1");
	const r = await (pi.handlers.tool_result[0])({ type: "tool_result", toolCallId: "z", toolName: "read",
		input: { path: "/tmp/big.txt" }, isError: false, content: [{ type: "text", text: "y".repeat(40000) }] },
		{ ...ctx, ui: pi.ui });
	check("default OFF: no footer", r === undefined);
	check("but /subnudge command still present", !!pi.commands.subnudge);
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
