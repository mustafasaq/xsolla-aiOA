import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ChangeStatus, ChangedFile } from "./types.js";

/** Diffs of large repositories exceed Node's 1 MB default and throw ENOBUFS. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Git's own name for "the empty tree", used when a repo has no base to compare. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

type GitOutcome =
  | { ok: true; stdout: string }
  | { ok: false; stderr: string };

/**
 * Runs git without a shell. Arguments are passed as an array, so repository
 * paths and refs are never word-split or glob-expanded.
 */
function tryGit(repositoryPath: string, args: string[]): GitOutcome {
  try {
    const stdout = execFileSync("git", args, {
      cwd: repositoryPath,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? ((error as { stderr: string }).stderr satisfies string)
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, stderr: stderr.trim() };
  }
}

function git(repositoryPath: string, args: string[]): string {
  const outcome = tryGit(repositoryPath, args);
  if (!outcome.ok) {
    throw new GitError(`git ${args.join(" ")} failed: ${outcome.stderr}`);
  }
  return outcome.stdout;
}

/**
 * Validates that the path is a usable Git repository before any git command
 * runs, so callers get an actionable message instead of `spawnSync git ENOENT`.
 */
export function assertGitRepository(repositoryPath: string): string {
  const absolute = resolve(repositoryPath);

  if (!existsSync(absolute)) {
    throw new GitError(`Repository path does not exist: ${absolute}`);
  }
  if (!statSync(absolute).isDirectory()) {
    throw new GitError(`Repository path is not a directory: ${absolute}`);
  }

  const outcome = tryGit(absolute, ["rev-parse", "--git-dir"]);
  if (!outcome.ok) {
    throw new GitError(
      `Not a Git repository: ${absolute}. ` +
        `Point --repo at a directory containing a .git folder.`,
    );
  }
  return absolute;
}

function revParse(repositoryPath: string, ref: string): string | null {
  const outcome = tryGit(repositoryPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return outcome.ok && outcome.stdout.trim() ? outcome.stdout.trim() : null;
}

export type Comparison = {
  baseRef: string;
  baseCommit: string;
  headCommit: string;
  notes: string[];
};

/**
 * Works out what to compare against.
 *
 * The starter hardcoded `main`, which fails on `master` repositories and on
 * shallow CI clones. Refs are resolved to commit SHAs here so that the SHAs,
 * not caller-controlled strings, are what reach `git diff`.
 */
export function resolveComparison(
  repositoryPath: string,
  requestedBase?: string,
): Comparison {
  const notes: string[] = [];

  const headCommit = revParse(repositoryPath, "HEAD");
  if (!headCommit) {
    throw new GitError(
      `Repository has no commits at HEAD: ${repositoryPath}. ` +
        `Commit something before requesting a review.`,
    );
  }

  if (requestedBase) {
    const requestedCommit = revParse(repositoryPath, requestedBase);
    if (!requestedCommit) {
      throw new GitError(
        `Base ref '${requestedBase}' does not exist in ${repositoryPath}. ` +
          `On a shallow clone, fetch it first (git fetch origin ${requestedBase}).`,
      );
    }
    return {
      baseRef: requestedBase,
      ...mergeBase(repositoryPath, requestedBase, requestedCommit, headCommit, notes),
      headCommit,
      notes,
    };
  }

  for (const candidate of ["main", "master"]) {
    const candidateCommit = revParse(repositoryPath, candidate);
    if (candidateCommit) {
      notes.push(`No --base-ref given; defaulted to '${candidate}'.`);
      return {
        baseRef: candidate,
        ...mergeBase(repositoryPath, candidate, candidateCommit, headCommit, notes),
        headCommit,
        notes,
      };
    }
  }

  const parent = revParse(repositoryPath, "HEAD~1");
  if (parent) {
    notes.push(
      "Neither 'main' nor 'master' exists here; compared against HEAD~1. " +
        "Pass --base-ref to choose a different base.",
    );
    return { baseRef: "HEAD~1", baseCommit: parent, headCommit, notes };
  }

  notes.push(
    "Repository has a single commit and no main/master; every file is reported as added.",
  );
  return { baseRef: "(empty tree)", baseCommit: EMPTY_TREE, headCommit, notes };
}

/**
 * Reproduces `base...HEAD` semantics explicitly: the diff runs from the merge
 * base, so changes made on the base branch since the fork point are excluded.
 */
function mergeBase(
  repositoryPath: string,
  baseRef: string,
  baseCommit: string,
  headCommit: string,
  notes: string[],
): { baseCommit: string } {
  const outcome = tryGit(repositoryPath, ["merge-base", baseCommit, headCommit]);
  if (outcome.ok && outcome.stdout.trim()) {
    return { baseCommit: outcome.stdout.trim() };
  }
  notes.push(
    `'${baseRef}' and HEAD have no common ancestor; compared against '${baseRef}' directly.`,
  );
  return { baseCommit };
}

const STATUS_BY_CODE: Record<string, ChangeStatus> = {
  A: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "unmerged",
};

/**
 * Parses `--name-status -z` output.
 *
 * NUL-delimited output is used because git otherwise quotes and escapes paths
 * containing spaces, quotes or non-ASCII characters. Renames and copies emit
 * three fields (`R100`, old path, new path) rather than two; the starter joined
 * them with a tab and produced a single corrupted path string.
 */
function parseNameStatus(raw: string): ChangedFile[] {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  const files: ChangedFile[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const code = tokens[index];
    const letter = code[0]?.toUpperCase() ?? "";
    const status = STATUS_BY_CODE[letter] ?? "modified";

    if (letter === "R" || letter === "C") {
      const previousPath = tokens[++index];
      const path = tokens[++index];
      if (path === undefined) break;
      files.push({ path, status, previousPath });
      continue;
    }

    const path = tokens[++index];
    if (path === undefined) break;
    files.push({ path, status });
  }

  return files;
}

export function changedFiles(
  repositoryPath: string,
  baseCommit: string,
  headCommit: string,
): ChangedFile[] {
  const raw = git(repositoryPath, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    baseCommit,
    headCommit,
    "--",
  ]);
  return parseNameStatus(raw);
}

/**
 * Untracked files never appear in `git diff`, so the starter could never
 * produce the `untracked` status its own type declared. A reviewer looking at
 * a working tree usually wants to know about brand-new files.
 */
export function untrackedFiles(repositoryPath: string): ChangedFile[] {
  const raw = git(repositoryPath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
  ]);
  return raw
    .split("\0")
    .filter((path) => path.length > 0)
    .map((path) => ({ path, status: "untracked" as const }));
}
