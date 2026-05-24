/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` subprocesses with full context inheritance.
 * Sub-agents inherit the exact same system prompt as the main agent
 * (no --append-system-prompt). Task is delivered as a user message.
 *
 * Simplified model:
 * - No named agents or config files
 * - Sub-agents inherit parent's model/tools/thinking
 * - Sub-agents cannot spawn further sub-agents (enforced in runner-events.js)
 */

import { spawn } from "node:child_process";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { processPiJsonLine } from "./runner-events.js";
import {
  type SingleResult,
  emptyUsage,
  getFinalOutput,
  normalizeCompletedResult,
} from "./types.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
const PI_OFFLINE_ENV = "PI_OFFLINE";

/**
 * Silence timeout: kill subagent if no JSON output for this long.
 * Reset on each received event line.
 */
const SILENCE_TIMEOUT_MS = 120_000;

/**
 * Absolute max execution time safety net.
 * Prevents runaway processes even if subagent keeps producing output.
 */
const MAX_EXECUTION_MS = 3_600_000;

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

  // Always inherit the parent's tools by default.
  // Sub-agents must have the same tool set as the parent to preserve KV cache.
  if (inheritedCliArgs.fallbackTools !== undefined) {
    args.push("--tools", inheritedCliArgs.fallbackTools);
  }

  // NO --append-system-prompt! The sub-agent inherits the main agent's
  // system prompt (Pi default + APPEND_SYSTEM.md) automatically.

  // Task message with sub-agent marker
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
   * Deprecated: no longer used as wall-clock timeout.
   * Runner uses heartbeat-based silence detection (120s) + max execution safety net (1hr).
   */
  timeout?: number;
  /** Maximum number of assistant turns (LLM calls). Default: 50. */
  maxTurns?: number;
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agentName,
    task,
    taskCwd,
    signal,
    onUpdate,
    makeDetails,
    maxTurns = 50,
  } = opts;

  const result: SingleResult = {
    agent: agentName,
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    maxTurns: maxTurns,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getFinalOutput(result.messages) || "(running...)",
        },
      ],
      details: makeDetails([result]),
    });
  };

  {
    const piArgs = buildPiArgs(task, taskCwd);
    let wasAborted = false;
    let timedOut = false;

    const exitCode = await new Promise<number>((resolve) => {
      const { command, prefixArgs } = resolvePiSpawn();
      const proc = spawn(command, [...prefixArgs, ...piArgs], {
        cwd: taskCwd ?? cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          [PI_OFFLINE_ENV]: "1",
        },
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
            result.stderr = result.errorMessage;
          }
          terminateChild();
          setTimeout(() => {
            if (!settled) finish(124);
          }, SIGKILL_TIMEOUT_MS + 500);
        }, SILENCE_TIMEOUT_MS);
        silenceTimer.unref();
      };

      const flushLine = (line: string) => {
        if (timedOut) return;
        if (processPiJsonLine(line, result)) emitUpdate();
        // Reset silence timer on any JSON event — subagent is alive
        resetSilenceTimer();
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
        // pi --mode json -p outputs \u0007 (bell) to stderr on completion
        const cleaned = chunk.toString().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
        result.stderr += cleaned;
      };

      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);

      // Silence timer — starts when process spawns, resets on each event
      resetSilenceTimer();

      // Max execution safety net — fires once, never resets
      maxExecutionTimer = setTimeout(() => {
        if (didClose || settled) return;
        timedOut = true;
        result.timeout = true;
        result.stopReason = "timeout";
        result.exitCode = 124;
        // Flush buffered data before killing (preserve partial output)
        if (buffer.trim()) flushBufferedLines(buffer);
        result.errorMessage = `Sub-agent exceeded max execution time (${MAX_EXECUTION_MS / 1000 / 60}min, ${result.usage.turns} turns).`;
        if (!result.stderr.trim()) {
          result.stderr = result.errorMessage;
        }
        terminateChild();
        setTimeout(() => {
          if (!settled) finish(124);
        }, SIGKILL_TIMEOUT_MS + 500);
      }, MAX_EXECUTION_MS);
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
          terminateChild();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    return normalizeCompletedResult(result, wasAborted);
  }
}
