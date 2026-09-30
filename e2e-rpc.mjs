// E2E harness for the RPC-mode subagent runner.
// Run: PI_SUBAGENT_BIN=/home/erpod/pi-mono/node_modules/.bin/pi node e2e-rpc.mjs <happy|reject>
import { runAgent } from "./runner.ts";

const which = process.argv[2];

function makeDetails(results) {
  return { results };
}

async function go() {
  let opts;
  if (which === "happy") {
    opts = {
      cwd: "/tmp",
      agentName: "e2e-happy",
      task: "Reply with exactly the word OK and nothing else.",
      timeout: 120_000,
      maxTurns: 5,
      makeDetails,
    };
  } else {
    // Rejection path: a model id that does not exist → prompt rejected before
    // acceptance → runner must fail fast (prompt_rejected), NOT wait 120 s.
    opts = {
      cwd: "/tmp",
      agentName: "e2e-reject",
      task: "Reply OK",
      timeout: 60_000,
      maxTurns: 3,
      makeDetails,
      modelProvider: "openai",
      modelId: "gpt-5",
    };
  }

  const t0 = Date.now();
  const result = await runAgent(opts);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(JSON.stringify(
    {
      elapsed_s: dt,
      exitCode: result.exitCode,
      stopReason: result.stopReason,
      promptDisposition: result.promptDisposition,
      sawAgentEnd: result.sawAgentEnd,
      sawAgentSettled: result.sawAgentSettled,
      turns: result.usage.turns,
      errorMessage: result.errorMessage,
      stderr: result.stderr?.slice(0, 300),
      finalText: (result.messages ?? [])
        .filter((m) => m.role === "assistant")
        .map((m) => (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join(""))
        .filter(Boolean)
        .pop() ?? null,
    },
    null,
    2,
  ));
}

go().catch((err) => {
  console.error("HARNESS ERROR:", err);
  process.exit(3);
});
