import type { ReviewResult, ValidationResult } from "./types.js";

/**
 * Chooses a fence longer than any backtick run inside the content.
 *
 * Command output is untrusted: a test that prints a triple backtick would
 * otherwise close the fence early and let arbitrary Markdown — or, since this
 * report is fed to AI agents, arbitrary instructions — escape into the
 * document body.
 */
function fenceFor(content: string): string {
  const longestRun = [...content.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

function fenced(content: string): string[] {
  const fence = fenceFor(content);
  return [fence, content, fence];
}

const STATUS_LABEL: Record<ValidationResult["status"], string> = {
  passed: "PASSED",
  failed: "FAILED",
  timed_out: "TIMED OUT",
};

function describeOutcome(result: ValidationResult): string {
  const parts = [STATUS_LABEL[result.status]];
  if (result.exitCode !== null && result.status !== "passed") {
    parts.push(`exit ${result.exitCode}`);
  }
  parts.push(`${result.durationMs} ms`);
  return parts.join(" · ");
}

export function renderMarkdown(result: ReviewResult): string {
  const lines: string[] = [`# Review Report: ${result.repositoryPath}`, ""];

  lines.push(
    `Comparing \`${result.baseRef}\` (\`${result.baseCommit.slice(0, 8)}\`) ` +
      `to \`HEAD\` (\`${result.headCommit.slice(0, 8)}\`).`,
    "",
  );

  for (const note of result.notes) {
    lines.push(`> ${note}`);
  }
  if (result.notes.length > 0) lines.push("");

  lines.push(`## Changed files (${result.changedFiles.length})`, "");
  if (result.changedFiles.length === 0) {
    lines.push("No changes between the base ref and HEAD.");
  } else {
    for (const file of result.changedFiles) {
      const rename = file.previousPath ? ` (from ${file.previousPath})` : "";
      lines.push(`- ${file.path} (${file.status})${rename}`);
    }
  }
  lines.push("");

  lines.push("## Validation", "");
  if (result.validationResults.length === 0) {
    lines.push("No validation commands were run.");
    return `${lines.join("\n")}\n`;
  }

  const failures = result.validationResults.filter(
    (entry) => entry.status !== "passed",
  ).length;
  lines.push(
    failures === 0
      ? `All ${result.validationResults.length} command(s) passed.`
      : `${failures} of ${result.validationResults.length} command(s) did not pass.`,
    "",
  );

  for (const entry of result.validationResults) {
    lines.push(`### \`${entry.command}\` — ${describeOutcome(entry)}`, "");
    lines.push(...fenced(entry.output));
    if (entry.outputTruncated) {
      lines.push("", "_Output truncated._");
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJson(result: ReviewResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
