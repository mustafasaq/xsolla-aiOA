import { exec } from "node:child_process";
import type { Capabilities } from "./contract.js";
import type { ValidationResult } from "./types.js";

type ExecFailure = Error & {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

/**
 * The capture buffer is deliberately larger than the reported output limit.
 * Sizing them equally makes Node kill the child the moment it reaches the
 * limit, which loses the exit status and is indistinguishable from a timeout.
 * Capturing with headroom lets us truncate for presentation while still
 * learning how the command actually ended.
 */
const CAPTURE_HEADROOM = 8;
const CAPTURE_CEILING_BYTES = 64 * 1024 * 1024;

function captureBufferFor(maxOutputBytes: number): number {
  return Math.min(maxOutputBytes * CAPTURE_HEADROOM, CAPTURE_CEILING_BYTES);
}

function truncate(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const clipped = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return { text: clipped, truncated: true };
}

/** Keeps both streams, labelled. The starter's `stdout || stderr` discarded
 *  stderr whenever stdout was non-empty — exactly when a command fails. */
function combineStreams(stdout: string, stderr: string): string {
  const sections: string[] = [];
  if (stdout.trim()) sections.push(stdout.trimEnd());
  if (stderr.trim()) sections.push(`[stderr]\n${stderr.trimEnd()}`);
  return sections.join("\n") || "(no output)";
}

/**
 * Runs one validation command and always resolves.
 *
 * The starter rejected on a non-zero exit, which meant a failing test suite —
 * the exact condition this tool exists to report — aborted the whole review and
 * discarded the changed-file list too. A non-zero exit is a *result*, not an
 * error in the tool.
 */
export function runValidation(
  command: string,
  cwd: string,
  capabilities: Capabilities,
): Promise<ValidationResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();

    exec(
      command,
      {
        cwd,
        timeout: capabilities.commandTimeoutMs,
        maxBuffer: captureBufferFor(capabilities.maxOutputBytes),
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const failure = error as ExecFailure | null;
        const combined = combineStreams(stdout ?? "", stderr ?? "");
        const { text, truncated } = truncate(
          combined,
          capabilities.maxOutputBytes,
        );

        if (!failure) {
          resolvePromise({
            command,
            status: "passed",
            exitCode: 0,
            output: text,
            outputTruncated: truncated,
            durationMs,
          });
          return;
        }

        // Order matters: an over-budget command is also reported as `killed`,
        // so it has to be distinguished before the timeout check.
        const overflowed = failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const timedOut = !overflowed && failure.killed === true;
        const exitCode = typeof failure.code === "number" ? failure.code : null;

        const suffix = timedOut
          ? `\n[timed out after ${capabilities.commandTimeoutMs} ms]`
          : overflowed
            ? "\n[killed: output exceeded the capture limit]"
            : "";

        resolvePromise({
          command,
          status: timedOut ? "timed_out" : "failed",
          exitCode: timedOut || overflowed ? null : exitCode,
          output: `${text}${suffix}`.trim(),
          outputTruncated: truncated || overflowed,
          durationMs,
        });
      },
    );
  });
}

/** Runs commands in order. A failing command no longer stops the ones after it. */
export async function runValidations(
  commands: string[],
  cwd: string,
  capabilities: Capabilities,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of commands) {
    results.push(await runValidation(command, cwd, capabilities));
  }
  return results;
}
