import { z } from "zod";

/**
 * The single request contract shared by every adapter.
 *
 * Both the CLI and the MCP server parse their input through this schema before
 * calling the core. That is deliberate: the starter's two adapters had drifted
 * (the MCP tool advertised `repo_path` but read `repoPath`, so it silently
 * reviewed the wrong directory), and a shared schema is what stops that class
 * of bug from recurring.
 */

/**
 * Git refs are restricted to characters that cannot be mistaken for an option.
 * The leading character excludes `-` on purpose: the starter interpolated the
 * base ref into `${base}...HEAD`, so a ref of `--output=/tmp/x` became the git
 * flag `--output=/tmp/x...HEAD` and gave the caller an arbitrary file write.
 * Refs are also resolved to commit SHAs before reaching `git diff`; this is the
 * outer layer of that defence.
 */
const GIT_REF_PATTERN = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

export const ReviewRequestShape = {
  repositoryPath: z
    .string()
    .min(1, "repositoryPath must be a non-empty path to a Git repository.")
    .describe("Absolute or relative path to the Git repository to inspect."),
  baseRef: z
    .string()
    .regex(
      GIT_REF_PATTERN,
      "baseRef must be a plain Git ref (letters, digits, '.', '_', '/', '-') and may not start with '-'.",
    )
    .optional()
    .describe("Ref to compare HEAD against. Defaults to main, then master."),
  validationCommands: z
    .array(z.string().min(1))
    .default([])
    .describe("Shell commands to run inside the repository, e.g. 'npm test'."),
  includeUntracked: z
    .boolean()
    .default(true)
    .describe(
      "Report working-tree files git is not tracking, in their own section.",
    ),
  format: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("Report format."),
};

export const ReviewRequestSchema = z.object(ReviewRequestShape);

export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

/**
 * What a given adapter is permitted to do.
 *
 * This is the trust boundary. Running `npm test` on your own machine from your
 * own terminal grants you nothing you did not already have, so the CLI gets
 * full capability. An MCP tool call originates from a language model whose
 * input may be influenced by repository content or a web page it just read, so
 * it does not get to execute arbitrary commands by default.
 */
export type Capabilities = {
  /** Adapter name, used in error messages. */
  readonly source: string;
  /** Whether `validationCommands` may execute at all. Implies a shell. */
  readonly allowValidationCommands: boolean;
  /** Per-command wall-clock limit. */
  readonly commandTimeoutMs: number;
  /** Cap on any single captured output stream, and on the rendered report. */
  readonly maxOutputBytes: number;
  /** Cap on how many changed files are listed. */
  readonly maxChangedFiles: number;
};

export const CLI_CAPABILITIES: Capabilities = {
  source: "cli",
  allowValidationCommands: true,
  commandTimeoutMs: 10 * 60_000,
  maxOutputBytes: 1024 * 1024,
  maxChangedFiles: 5_000,
};

/** Set to "1" to let MCP callers run validation commands. Off by default. */
export const MCP_VALIDATION_ENV = "INSPECTOR_ALLOW_MCP_VALIDATION";

/**
 * MCP limits are tighter than the CLI's because the report is returned into a
 * model's context window rather than written to a file the caller can page
 * through at their leisure.
 */
export function mcpCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): Capabilities {
  return {
    source: "mcp",
    allowValidationCommands: env[MCP_VALIDATION_ENV] === "1",
    commandTimeoutMs: 2 * 60_000,
    maxOutputBytes: 64 * 1024,
    maxChangedFiles: 500,
  };
}

/** Thrown when a request is well-formed but the adapter may not perform it. */
export class CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityError";
  }
}

/** Thrown when a request fails schema validation. */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

/** Parses unknown adapter input into a request, with readable error text. */
export function parseReviewRequest(input: unknown): ReviewRequest {
  const parsed = ReviewRequestSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    throw new RequestError(`Invalid review request. ${detail}`);
  }
  return parsed.data;
}

/** Enforces the adapter's capabilities against an already-parsed request. */
export function assertWithinCapabilities(
  request: ReviewRequest,
  capabilities: Capabilities,
): void {
  if (
    request.validationCommands.length > 0 &&
    !capabilities.allowValidationCommands
  ) {
    throw new CapabilityError(
      `The ${capabilities.source} interface does not run validation commands. ` +
        `Executing caller-supplied commands is a remote code execution primitive, ` +
        `so it is disabled here by default. Set ${MCP_VALIDATION_ENV}=1 on the ` +
        `server process to opt in, or run the CLI directly.`,
    );
  }
}
