import type { ChangedFile, ReviewResult, ValidationResult } from "./types.js";

/**
 * Longest run of consecutive backticks in the content, used to size a
 * delimiter that the content cannot terminate early.
 */
function longestBacktickRun(content: string): number {
  return [...content.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
}

/**
 * Chooses a fence longer than any backtick run inside the content.
 *
 * Command output is untrusted: a test that prints a triple backtick would
 * otherwise close the fence early and let arbitrary Markdown — or, since this
 * report is fed to AI agents, arbitrary instructions — escape into the
 * document body.
 */
function fenced(content: string): string[] {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return [fence, content, fence];
}

/** Control characters, which must never reach the rendered document. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/g;

/**
 * Renders an untrusted single-line value as inline code.
 *
 * Git permits newlines, backticks and control characters in path names, and
 * `-z` parsing preserves them faithfully. Interpolating a path straight into a
 * list item therefore lets a file named "evil\n## Injected Heading" write its
 * own section into the report — the same escape the fenced blocks above guard
 * against, reached through the file list instead of through command output.
 */
export function inlineCode(value: string): string {
  const escaped = value.replace(
    CONTROL_CHARACTERS,
    (character) =>
      `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
  const delimiter = "`".repeat(longestBacktickRun(escaped) + 1);
  // A value that begins or ends with a backtick needs padding to stay legal.
  const pad = escaped.startsWith("`") || escaped.endsWith("`") ? " " : "";
  return `${delimiter}${pad}${escaped}${pad}${delimiter}`;
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

function fileLine(file: ChangedFile): string {
  const from = file.previousPath
    ? ` (from ${inlineCode(file.previousPath)})`
    : "";
  return `- ${inlineCode(file.path)} (${file.status})${from}`;
}

export function renderMarkdown(result: ReviewResult): string {
  const lines: string[] = [
    `# Review Report: ${inlineCode(result.repositoryPath)}`,
    "",
  ];

  lines.push(
    `Comparing ${inlineCode(result.baseRef)} ` +
      `(${inlineCode(result.baseCommit.slice(0, 8))}) to \`HEAD\` ` +
      `(${inlineCode(result.headCommit.slice(0, 8))}).`,
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
      lines.push(fileLine(file));
    }
  }
  lines.push("");

  // Untracked files are working-tree state, not part of the base..HEAD
  // comparison, so they get their own section instead of being mixed in.
  if (result.untrackedFiles.length > 0) {
    lines.push(
      `## Untracked files (${result.untrackedFiles.length})`,
      "",
      "_In the working tree, not committed; not part of the comparison above._",
      "",
    );
    for (const file of result.untrackedFiles) {
      lines.push(fileLine(file));
    }
    lines.push("");
  }

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
    lines.push(
      `### ${inlineCode(entry.command)} — ${describeOutcome(entry)}`,
      "",
    );
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
