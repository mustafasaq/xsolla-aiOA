import {
  assertWithinCapabilities,
  parseReviewRequest,
  type Capabilities,
} from "./contract.js";
import {
  assertGitRepository,
  changedFiles,
  resolveComparison,
  untrackedFiles,
} from "./git.js";
import { renderJson, renderMarkdown } from "./report.js";
import type { ReviewResult } from "./types.js";
import { runValidations } from "./validation.js";

/**
 * Orchestrates a review and returns structured data.
 *
 * Rendering deliberately lives outside this function. The starter returned a
 * Markdown string, which is why `--format json` could be parsed, typed and
 * threaded all the way here and still do nothing. With a structured result,
 * every format is a view over the same run rather than a separate code path.
 */
export async function reviewRepository(
  input: unknown,
  capabilities: Capabilities,
): Promise<ReviewResult> {
  const request = parseReviewRequest(input);
  assertWithinCapabilities(request, capabilities);

  const repositoryPath = assertGitRepository(request.repositoryPath);
  const comparison = resolveComparison(repositoryPath, request.baseRef);
  const notes = [...comparison.notes];

  const tracked = changedFiles(
    repositoryPath,
    comparison.baseCommit,
    comparison.headCommit,
  );
  const files = [...tracked, ...untrackedFiles(repositoryPath)];

  const changedFilesTruncated = files.length > capabilities.maxChangedFiles;
  if (changedFilesTruncated) {
    notes.push(
      `Listing the first ${capabilities.maxChangedFiles} of ${files.length} changed files.`,
    );
  }

  const validationResults = await runValidations(
    request.validationCommands,
    repositoryPath,
    capabilities,
  );

  return {
    repositoryPath,
    baseRef: comparison.baseRef,
    baseCommit: comparison.baseCommit,
    headCommit: comparison.headCommit,
    changedFiles: files.slice(0, capabilities.maxChangedFiles),
    changedFilesTruncated,
    validationResults,
    notes,
  };
}

export function renderReview(
  result: ReviewResult,
  format: "markdown" | "json",
): string {
  return format === "json" ? renderJson(result) : renderMarkdown(result);
}

/** True when any validation did not pass, so adapters can set an exit code. */
export function hasFailures(result: ReviewResult): boolean {
  return result.validationResults.some((entry) => entry.status !== "passed");
}
