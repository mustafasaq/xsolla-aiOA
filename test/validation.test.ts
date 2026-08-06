import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CLI_CAPABILITIES, type Capabilities } from "../src/contract.js";
import { runValidation, runValidations } from "../src/validation.js";

const caps: Capabilities = { ...CLI_CAPABILITIES, commandTimeoutMs: 2_000 };

describe("runValidation", () => {
  it("reports a failing command instead of throwing", async () => {
    // Regression: the starter called reject() on a non-zero exit, so a failing
    // test suite aborted the entire review and `status: "failed"` was
    // unreachable code.
    const result = await runValidation("exit 3", tmpdir(), caps);

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("marks a passing command as passed", async () => {
    const result = await runValidation("echo hello", tmpdir(), caps);

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello");
  });

  it("keeps stderr even when stdout is non-empty", async () => {
    // Regression: `stdout || stderr` dropped stderr exactly when a command
    // failed and its diagnostics mattered most.
    const result = await runValidation(
      "echo out; echo boom 1>&2; exit 1",
      tmpdir(),
      caps,
    );

    expect(result.output).toContain("out");
    expect(result.output).toContain("boom");
  });

  it("times out rather than hanging forever", async () => {
    const result = await runValidation("sleep 30", tmpdir(), {
      ...caps,
      commandTimeoutMs: 300,
    });

    expect(result.status).toBe("timed_out");
  });

  it("truncates output beyond the reporting limit", async () => {
    // 4 KB of output against a 1 KB report limit: well inside the capture
    // buffer, so the command still completes normally and we truncate for
    // presentation only.
    const result = await runValidation("yes abcdefgh | head -c 4000", tmpdir(), {
      ...caps,
      maxOutputBytes: 1_000,
    });

    expect(result.status).toBe("passed");
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(1_000);
  });

  it("distinguishes an over-budget command from a timeout", async () => {
    // Node reports a maxBuffer kill as `killed`, the same field a timeout
    // sets. Conflating them would mislabel a chatty command as hung.
    const result = await runValidation("yes abcdefgh | head -c 200000", tmpdir(), {
      ...caps,
      maxOutputBytes: 1_000,
    });

    expect(result.status).toBe("failed");
    expect(result.outputTruncated).toBe(true);
    expect(result.output).toContain("output exceeded the capture limit");
  });

  it("runs every command even after one fails", async () => {
    const results = await runValidations(
      ["exit 1", "echo second"],
      tmpdir(),
      caps,
    );

    expect(results.map((entry) => entry.status)).toEqual(["failed", "passed"]);
  });
});
