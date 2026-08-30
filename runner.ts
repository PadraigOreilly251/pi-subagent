/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` subprocesses with full context inheritance.
 * Sub-agents inherit the exact same system prompt as the main agent
 * (no --append-system-prompt). Task is delivered as a user message.
 *
 * Features:
 * - Wall-clock timeout: `timeout` is honoured again (kills the child when the deadline passes)
 * - Turn budget enforcement: child is KILLED when it exceeds maxTurns (was flag-only)
 * - Recursion enforcement: child is KILLED if it tries to spawn a nested sub-agent
 * - Model/thinking inheritance: child is pinned to the parent's provider+model
 * - Child marker env (PI_SUBAGENT_CHILD=1) so nested sub-agent tools can disable themselves
 * - SIGTERM auto-retry: killed subagents retry up to 2x with exponential backoff
 * - Silence detection: kills stuck processes after 120s of no stdout at all
 * - Heartbeat updates: UI refreshes every 10s so a slow turn does not look frozen
 */

import { spawn } from "node:child_process";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { processPiJsonLine } from "./runner-events.js";
import {
  type SingleResult,
  emptyUsage,
  getFinalOutput,
  getLastToolCall,
  normalizeCompletedResult,
} from "./types.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
const PI_OFFLINE_ENV = "PI_OFFLINE";

/**
 * Marker env var set on every child pi process.
 * index.ts uses it to disable the subagent tool inside children (real recursion guard).
 */
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

/** How often to push a "still running" update to the UI while the child is alive. */
const HEARTBEAT_MS = 10_000;

/**
 * SIGTERM auto-retry settings.
 * Sub-agents killed by SIGTERM (exit 143) are often victims of timing,
 * not logic errors. Retry with backoff before surfacing failure.
 */
const SIGTERM_MAX_RETRIES = 2; // total attempts: initial + 2 retries
const SIGTERM_BASE_DELAY_MS = 5000;

/**
 * Silence timeout: kill subagent if no JSON output for this long.
 * Reset on each received event line.
 */
const SILENCE_TIMEOUT_MS = 120_000;

/** Upper bound on collected stderr (a looping child must not grow memory without limit). */
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Absolute max execution time safety net per attempt.
 * Prevents runaway processes even if subagent keeps producing output.
 */
const MAX_EXECUTION_MS = 3_600_000;

/** Budget per turn used when the caller omits `timeout` (the documented maxTurns × 10s rule). */
const DEFAULT_TURN_ALLOWANCE_MS = 10_000;

type OnUpdateCallback = (partial: AgentToolResult) => void;

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

function buildPiArgs(
  task: string,
  taskCwd: string | undefined,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ...inheritedCliArgs.extensionArgs,
    ...inheritedCliArgs.alwaysProxy,
    "-p",
    "--no-session",
  ];

  // Pin the child to the parent's model. pi does NOT read PI_MODEL/PI_PROVIDER
  // (those are exported *to* child commands, not consumed), so without this every
  // sub-agent silently ran on settings.json's default model instead of the session's
  // (observed live: parent on mac/104, child on Linux/109).
  //
  // PI_SUBAGENT_MODEL / PI_SUBAGENT_PROVIDER override that — useful on self-hosted rigs:
  // one llama.cpp box has few slots on one shared KV context, so pointing children at a
  // second box stops them from evicting the parent's cached prompt.
  const model =
    process.env.PI_SUBAGENT_MODEL ?? inheritedCliArgs.fallbackModel ?? process.env.PI_MODEL;
  const provider = process.env.PI_SUBAGENT_PROVIDER ?? process.env.PI_PROVIDER;
  if (model && !inheritedCliArgs.alwaysProxy.includes("--model")) {
    if (provider) args.push("--provider", provider);
    args.push("--model", model);
  }
  const thinking =
    process.env.PI_SUBAGENT_THINKING ??
    inheritedCliArgs.fallbackThinking ??
    process.env.PI_REASONING_LEVEL;
  if (thinking && !inheritedCliArgs.alwaysProxy.includes("--thinking")) {
    args.push("--thinking", thinking);
  }

  // Always inherit the parent's tools by default.
  if (inheritedCliArgs.fallbackTools !== undefined) {
    args.push("--tools", inheritedCliArgs.fallbackTools);
  }

  const taskMessage = `[sub-agent-task] Complete this task:\n${task}`;
  args.push(taskMessage);
  return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Working directory. */
  cwd: string;
  /** Freeform name for the sub-agent. */
  agentName: string;
  /** Task description. */
  task: string;
  /** Optional override working directory. */
  taskCwd?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming update callback. */
  onUpdate?: OnUpdateCallback;
  /** Factory to wrap results into SubagentDetails. */
  makeDetails: (results: SingleResult[]) => { results: SingleResult[] };
  /**
   * Wall-clock timeout for one attempt, in milliseconds.
   * The child is killed when the deadline passes; partial output is preserved.
   * When omitted: 10s × maxTurns, capped at MAX_EXECUTION_MS. A 120s raw-silence watchdog runs
   * alongside it (streaming `message_update` lines keep the silence timer reset, so
   * it only catches a truly wedged process — the wall clock does the real work).
   */
  timeout?: number;
  /** Maximum number of assistant turns (LLM calls). Default: 50. */
  maxTurns?: number;
}

/**
 * Run a single subagent spawn attempt.
 * Returns the exit code; mutates `result` in place with all collected state.
 */
function runSingleAttempt(
  result: SingleResult,
  piArgs: string[],
  workDir: string,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  hardCapMs: number,
): Promise<number> {
  let wasAborted = false;
  let timedOut = false;
  const startedAt = Date.now();

  return new Promise<number>((resolve) => {
    const { command, prefixArgs } = resolvePiSpawn();

    // A sub-agent is a DIFFERENT session, so it must not be told it is the parent one.
    // These are exactly the vars pi itself strips for tool-spawned commands
    // (coding-agent src/core/tools/bash.ts → resolveSpawnContext); leaking them made the child
    // inherit the parent's session identity. Model/provider/thinking reach the child as
    // explicit CLI flags instead (see buildPiArgs).
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      [PI_OFFLINE_ENV]: "1",
      [SUBAGENT_CHILD_ENV]: "1",
    };
    for (const leaked of [
      "PI_SESSION_ID",
      "PI_SESSION_FILE",
      "PI_PROVIDER",
      "PI_MODEL",
      "PI_REASONING_LEVEL",
    ]) {
      delete childEnv[leaked];
    }

    const proc = spawn(command, [...prefixArgs, ...piArgs], {
      cwd: workDir,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });

    proc.stdin.on("error", () => {
      /* ignore broken pipe on fast exits */
    });
    proc.stdin.end();

    let buffer = "";
    let didClose = false;
    let settled = false;
    let abortHandler: (() => void) | undefined;
    let semanticCompletionTimer: NodeJS.Timeout | undefined;
    let silenceTimer: NodeJS.Timeout | undefined;
    let maxExecutionTimer: NodeJS.Timeout | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    // Post-kill safety net. Deliberately NOT unref'd (it is what guarantees the promise
    // settles) but always cleared in clearTimers() so it cannot outlive the call.
    let finishGraceTimer: NodeJS.Timeout | undefined;
    let stderrBytes = 0;

    const emitUpdate = () => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const last = getLastToolCall(result.messages);
      const status =
        `running ${elapsed}s · ${result.usage.turns} turn${result.usage.turns === 1 ? "" : "s"}` +
        (last ? ` · last tool: ${last.name}` : "");
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `${status}\n\n${getFinalOutput(result.messages) || "(no assistant output yet)"}`,
          },
        ],
        details: { results: [result] },
      });
    };

    const clearTimers = () => {
      if (semanticCompletionTimer) {
        clearTimeout(semanticCompletionTimer);
        semanticCompletionTimer = undefined;
      }
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = undefined;
      }
      if (maxExecutionTimer) {
        clearTimeout(maxExecutionTimer);
        maxExecutionTimer = undefined;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (finishGraceTimer) {
        clearTimeout(finishGraceTimer);
        finishGraceTimer = undefined;
      }
    };

    /** Resolve with `fallbackCode` unless close/error beat us to it. Never leaves us waiting. */
    const scheduleFinish = (fallbackCode: number) => {
      if (finishGraceTimer) clearTimeout(finishGraceTimer);
      finishGraceTimer = setTimeout(() => {
        finishGraceTimer = undefined;
        if (!settled) finish(fallbackCode);
      }, SIGKILL_TIMEOUT_MS + 500);
    };


    const terminateChild = () => {
      if (isWindows) {
        if (proc.pid !== undefined) {
          const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
            stdio: "ignore",
          });
          killer.unref();
        }
        return;
      }

      proc.kill("SIGTERM");
      const sigkillTimer = setTimeout(() => {
        if (!didClose) proc.kill("SIGKILL");
      }, SIGKILL_TIMEOUT_MS);
      sigkillTimer.unref();
    };

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      // Never report -1: when we kill the child ourselves, close arrives after we resolved.
      if (result.exitCode === -1) result.exitCode = code;
      clearTimers();
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      resolve(code);
    };

    const resetSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      if (didClose || settled || timedOut) return;
      silenceTimer = setTimeout(() => {
        if (didClose || settled) return;
        // No output for SILENCE_TIMEOUT_MS — assume stuck/crashed
        timedOut = true;
        result.timeout = true;
        result.stopReason = "timeout";
        result.exitCode = 124;
        // Flush any buffered data before killing (preserve partial output)
        if (buffer.trim()) flushBufferedLines(buffer);
        result.errorMessage = `Sub-agent silent for ${SILENCE_TIMEOUT_MS / 1000}s (${result.usage.turns} turns completed). Assuming stuck.`;
        if (!result.stderr.trim()) {
          result.stderr = result.errorMessage ?? "";
        }
        terminateChild();
        scheduleFinish(124);
      }, SILENCE_TIMEOUT_MS);
      silenceTimer.unref();
    };

    /**
     * Stop waiting on a child that already blew a budget (turn limit / recursion guard)
     * and kill it. Previously the runner only recorded the reason and then sat there
     * until the child finished on its own — up to the 1h ceiling — which is what looked
     * like a hang.
     */
    const bailOut = (reason: string) => {
      if (settled || didClose) return;
      timedOut = true; // suppress further line handling
      if (!result.errorMessage) result.errorMessage = reason;
      if (!result.stderr.trim()) result.stderr = reason;
      if (result.exitCode === -1 || result.exitCode === 0) result.exitCode = 1;
      terminateChild();
      scheduleFinish(1);
    };

    const flushLine = (line: string) => {
      if (timedOut) return;
      if (processPiJsonLine(line, result)) emitUpdate();
      // Reset silence timer on any JSON event — subagent is alive
      resetSilenceTimer();
      if (result.stopReason === "max_turns") {
        bailOut(
          `Sub-agent reached its ${result.maxTurns}-turn budget; process killed. ` +
            `Partial output preserved.`,
        );
        return;
      }
      if (result.stopReason === "subagent_recursion_blocked") {
        bailOut(
          "Sub-agent tried to spawn a nested sub-agent; process killed. " +
            "Nested delegation is not allowed.",
        );
        return;
      }
      maybeFinishFromAgentEnd();
    };

    const flushBufferedLines = (text: string) => {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) flushLine(line);
      }
    };

    const maybeFinishFromAgentEnd = () => {
      if (!result.sawAgentEnd || didClose || settled) return;
      clearTimers();
      semanticCompletionTimer = setTimeout(() => {
        if (didClose || settled || !result.sawAgentEnd) return;
        if (buffer.trim()) {
          flushBufferedLines(buffer);
          buffer = "";
        }
        proc.stdout.removeListener("data", onStdoutData);
        proc.stderr.removeListener("data", onStderrData);
        finish(0);
        terminateChild();
      }, AGENT_END_GRACE_MS);
      semanticCompletionTimer.unref();
    };

    const onStdoutData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) flushLine(line);
    };

    const onStderrData = (chunk: Buffer) => {
      // Strip control characters (bell, escape sequences, etc.) from stderr
      const cleaned = chunk.toString().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
      // Bound the buffer: a chatty/looping child must not grow it without limit.
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const kept = cleaned.slice(0, MAX_STDERR_BYTES - stderrBytes);
      stderrBytes += kept.length;
      result.stderr += kept;
      if (kept.length < cleaned.length) {
        result.stderr += "\n... (stderr truncated)\n";
        stderrBytes = MAX_STDERR_BYTES;
      }
    };

    proc.stdout.on("data", onStdoutData);
    proc.stderr.on("data", onStderrData);

    // Silence timer — starts when process spawns, resets on each event
    resetSilenceTimer();

    // Heartbeat — keeps the TUI alive during long single turns (local LLMs are slow,
    // and the previous "(running...)"-forever render read as a frozen agent).
    heartbeatTimer = setInterval(() => {
      if (didClose || settled) return;
      emitUpdate();
    }, HEARTBEAT_MS);
    heartbeatTimer.unref();

    // Wall-clock deadline (the `timeout` tool param) — fires once, never resets.
    maxExecutionTimer = setTimeout(() => {
      if (didClose || settled) return;
      timedOut = true;
      result.timeout = true;
      result.stopReason = "timeout";
      result.exitCode = 124;
      // Flush buffered data before killing (preserve partial output)
      if (buffer.trim()) flushBufferedLines(buffer);
      result.errorMessage = `Sub-agent hit its ${Math.round(hardCapMs / 1000)}s wall-clock timeout (${result.usage.turns} turns completed).`;
      if (!result.stderr.trim()) {
        result.stderr = result.errorMessage ?? "";
      }
      terminateChild();
      scheduleFinish(124);
    }, hardCapMs);
    maxExecutionTimer.unref();

    proc.on("close", (code) => {
      didClose = true;
      clearTimers();
      if (buffer.trim()) flushBufferedLines(buffer);
      finish(code ?? 0);
    });

    proc.on("error", (err) => {
      if (!result.stderr.trim()) result.stderr = err.message;
      clearTimers();
      finish(1);
    });

    // Abort handling
    if (signal) {
      abortHandler = () => {
        if (didClose || settled) return;
        wasAborted = true;
        clearTimers();
        // Flush whatever the child managed to stream, then report it instead of `(no output)`.
        if (buffer.trim()) flushBufferedLines(buffer);
        buffer = "";
        result.exitCode = 130;
        if (!result.errorMessage) {
          result.errorMessage = `Sub-agent aborted by parent (${result.usage.turns} turns completed). Partial output preserved.`;
        }
        if (!result.stderr.trim()) result.stderr = result.errorMessage;
        terminateChild();
        scheduleFinish(130);
      };
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

/**
 * Spawn a single subagent process with SIGTERM auto-retry.
 *
 * On SIGTERM (exit 143), retries up to SIGTERM_MAX_RETRIES times with
 * exponential backoff. This handles timing-related kills without surfacing
 * a confusing failure to the user.
 *
 * Returns a SingleResult even on failure.
 */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agentName,
    task,
    taskCwd,
    signal,
    onUpdate,
    maxTurns = 50,
  } = opts;

  const workDir = taskCwd ?? cwd;
  const piArgs = buildPiArgs(task, taskCwd);
  // Honour the requested wall-clock timeout; MAX_EXECUTION_MS stays as an absolute net.
  // When no timeout is given, derive one from the turn budget (the documented
  // maxTurns × 10s formula) instead of falling through to a flat hour — an hour of a
  // local model politely streaming is exactly the "hang" this whole pass is about.
  const hardCapMs =
    opts.timeout && opts.timeout > 0
      ? Math.min(opts.timeout, MAX_EXECUTION_MS)
      : Math.min(DEFAULT_TURN_ALLOWANCE_MS * maxTurns, MAX_EXECUTION_MS);

  let finalResult: SingleResult = {
    agent: agentName,
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    maxTurns,
  };

  let attempt = 0;
  // `timeout` is the budget for the WHOLE tool call, retries included. Without this the
  // SIGTERM retry loop handed every attempt a fresh deadline, so one sub-agent call could
  // silently consume 3 × timeout (3 × 1h with the old defaults) — the classic "hang".
  const deadlineAt = Date.now() + hardCapMs;
  const MIN_RETRY_WINDOW_MS = 15_000;

  while (attempt <= SIGTERM_MAX_RETRIES) {
    const result: SingleResult = {
      agent: agentName,
      task,
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      maxTurns,
    };

    const remainingMs = deadlineAt - Date.now();
    if (attempt > 0 && remainingMs < MIN_RETRY_WINDOW_MS) {
      finalResult.errorMessage =
        (finalResult.errorMessage ?? "") +
        ` Not retried: only ${Math.round(remainingMs / 1000)}s left of the ${Math.round(hardCapMs / 1000)}s budget.`;
      break;
    }

    if (attempt > 0) {
      // Exponential backoff: 5s, 15s, 45s… never past the overall deadline
      const delay = Math.min(
        SIGTERM_BASE_DELAY_MS * Math.pow(3, attempt - 1),
        Math.max(0, remainingMs - MIN_RETRY_WINDOW_MS),
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    const exitCode = await runSingleAttempt(
      result,
      piArgs,
      workDir,
      signal,
      onUpdate,
      // Every attempt shares the one deadline.
      Math.max(1_000, Math.min(hardCapMs, deadlineAt - Date.now())),
    );

    // Propagate the real process exit code. It used to be dropped here, so
    // result.exitCode stayed -1 and isResultError() returned false for every
    // crashed / provider-errored child — failures were reported as success.
    if (!result.timeout && (result.exitCode === -1 || result.exitCode === 0)) {
      result.exitCode = exitCode;
    }

    const wasAborted = signal?.aborted ?? false;
    const normalized = normalizeCompletedResult(result, wasAborted);

    // Merge partial output from previous attempts so nothing is lost
    if (attempt > 0 && finalResult.messages.length > 0) {
      normalized.messages = [...finalResult.messages, ...result.messages];
      normalized.stderr = [finalResult.stderr, result.stderr].filter(Boolean).join("\n");
    }

    finalResult = normalized;

    // Success or non-recoverable error — stop retrying
    if (normalized.stopReason !== "sigterm" || wasAborted) {
      break;
    }

    attempt++;
  }

  return finalResult;
}
