export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "unmerged"
  | "untracked";

export type ChangedFile = {
  path: string;
  status: ChangeStatus;
  /** Set only for renames and copies. */
  previousPath?: string;
};

export type ValidationStatus = "passed" | "failed" | "timed_out";

export type ValidationResult = {
  command: string;
  status: ValidationStatus;
  /** Null when the process was killed by a signal or timed out. */
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  durationMs: number;
};

/**
 * The structured result of a review. Adapters render this; they never build
 * report text themselves, so `--format json` and Markdown always describe the
 * same run.
 */
export type ReviewResult = {
  repositoryPath: string;
  /** The ref actually compared against, which may differ from the request. */
  baseRef: string;
  baseCommit: string;
  headCommit: string;
  /** Files that differ between the base commit and HEAD. */
  changedFiles: ChangedFile[];
  changedFilesTruncated: boolean;
  /**
   * Working-tree files git is not tracking. Kept separate from `changedFiles`
   * because they are not part of the base..HEAD comparison, and conflating the
   * two misrepresents what a branch actually changed.
   */
  untrackedFiles: ChangedFile[];
  validationResults: ValidationResult[];
  /** Human-readable remarks about how the review was resolved. */
  notes: string[];
};
