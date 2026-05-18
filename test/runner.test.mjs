import test from "node:test";
import assert from "node:assert/strict";
import { isResultError, isResultSuccess, normalizeCompletedResult } from "../types.ts";

function makeResult(overrides = {}) {
  return {
    agent: "oracle",
    agentSource: "user",
    task: "repro",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    ...overrides,
  };
}

test("normalizeCompletedResult keeps intermediate assistant output as a failure without agent_end", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Let me check that for you." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult treats agent_end with final assistant output as semantic success", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "No matches found; exit code 1 was expected." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult preserves semantic completion when the process is aborted after agent_end", () => {
  const result = makeResult({
    exitCode: 130,
    stopReason: "aborted",
    errorMessage: "Subagent was aborted.",
    stderr: "Subagent was aborted.",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult keeps aborts as errors without semantic completion", () => {
  const result = makeResult({
    exitCode: 130,
    stderr: "",
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 130);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "Subagent was aborted.");
  assert.equal(result.stderr, "Subagent was aborted.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("running results are neither success nor error", () => {
  const result = makeResult({ exitCode: -1 });

  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult handles timeout", () => {
  const result = makeResult({
    exitCode: 124,
    timeout: true,
    stopReason: "timeout",
    errorMessage: "Sub-agent timed out after 120s",
    stderr: "Sub-agent timed out after 120s",
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 124);
  assert.equal(result.stopReason, "timeout");
  assert.equal(result.errorMessage, "Sub-agent timed out after 120s");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("normalizeCompletedResult handles max turns exceeded", () => {
  const result = makeResult({
    exitCode: 1,
    maxTurns: 50,
    stopReason: "max_turns",
    errorMessage: "Sub-agent exceeded maximum turns (50)",
    stderr: "Sub-agent exceeded maximum turns (50)",
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "max_turns");
  assert.equal(result.errorMessage, "Sub-agent exceeded maximum turns (50)");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("isResultSuccess returns false for timeout even with semantic completion", () => {
  const result = makeResult({
    exitCode: 124,
    timeout: true,
    stopReason: "timeout",
    sawAgentEnd: true,
    messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
  });

  assert.equal(isResultSuccess(result), false);
});

test("isResultSuccess returns false for max_turns even with semantic completion", () => {
  const result = makeResult({
    exitCode: 1,
    maxTurns: 50,
    stopReason: "max_turns",
    sawAgentEnd: true,
    messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
  });

  assert.equal(isResultSuccess(result), false);
});
