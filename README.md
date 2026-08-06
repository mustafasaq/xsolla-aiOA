# Repository Inspector

A small TypeScript developer tool that inspects changes in a Git repository,
runs optional validation commands, and produces a report. It is usable from the
command line and from AI clients over MCP.

## Interface decision: hybrid, with one shared contract

Both interfaces are supported, but they are not equals — they differ in
**capability**, never in **behaviour**.

Every adapter parses its input through the same Zod schema in
[`src/contract.ts`](src/contract.ts) and calls the same core, which returns
structured data rather than a formatted string. Rendering is a view over that
data. This is a direct response to how the two adapters had drifted: the MCP
tool advertised `repo_path` but read `repoPath`, so it silently reviewed the
server's own directory, and `--format json` was parsed and threaded all the way
into the core without ever being read. Neither is expressible now — the schema
is the single definition of a request, and JSON and Markdown are two renderings
of one result.

| | CLI | MCP |
|---|---|---|
| Primary user | A developer at a terminal | An AI coding agent |
| Validation commands | Allowed | **Denied by default** |
| Command timeout | 10 min | 2 min |
| Max output | 1 MB | 64 KB |
| Max files listed | 5000 | 500 |

### Trust boundary

The asymmetry is the whole point. Typing `--validate "npm test"` into your own
shell grants you nothing you did not already have, so the CLI runs commands
freely. An MCP call arrives from a language model whose input may be influenced
by repository contents, an issue tracker, or a web page it just read; handing
that a shell is a remote code execution primitive. So MCP callers get a
read-only review unless the operator sets `INSPECTOR_ALLOW_MCP_VALIDATION=1` on
the server process — a decision made where the server is launched, not by the
caller. Asking for commands without that opt-in returns an explicit refusal
rather than a quietly reduced review.

MCP's tighter output caps exist because its report is returned into a context
window, not written to a file the reader can page through.

### What would change this decision

Evidence that agents mostly call this in throwaway sandboxes where RCE is
uninteresting would justify enabling validation by default. Evidence that
humans consume it mainly through an agent rather than a terminal would justify
going MCP-first and demoting the CLI to a debug harness. Conversely, a single
report of a model being talked into running a command via repository content
would justify removing `INSPECTOR_ALLOW_MCP_VALIDATION` altogether and making
the MCP surface permanently read-only.

## Setup

```bash
npm install
npm run typecheck
npm test
```

## CLI

```bash
npm run inspector -- review --repo ./path/to/repo
npm run inspector -- review --repo ./path/to/repo --validate "npm test"
npm run inspector -- review --repo ./path/to/repo --format json --stdout
```

| Option | Meaning |
|---|---|
| `--repo <path>` | Repository to inspect (required). |
| `--base-ref <ref>` | Ref to compare against. Defaults to `main`, then `master`, then `HEAD~1`. |
| `--validate <cmd>` | Command to run in the repository. Repeatable. |
| `--format <fmt>` | `markdown` (default) or `json`. |
| `--out <file>` | Output path. Defaults to `review-report.md`. |
| `--stdout` | Write to stdout instead of a file. |
| `--no-untracked` | Omit working-tree files git is not tracking. |

Exit code is `0` when every validation passed and `1` when any failed or timed
out, so CI can gate on a review. A failing validation is reported in full — it
no longer aborts the run and discards the changed-file list with it.

## MCP

```bash
npm run mcp-server                                    # read-only
INSPECTOR_ALLOW_MCP_VALIDATION=1 npm run mcp-server   # commands enabled
```

Exposes one tool, `review_repository`:

| Field | Type | Notes |
|---|---|---|
| `repositoryPath` | string, required | The repository to inspect. |
| `baseRef` | string, optional | Must match `^[A-Za-z0-9._/][A-Za-z0-9._/-]*$`. |
| `validationCommands` | string[], optional | Refused unless the server opted in. |
| `includeUntracked` | boolean | Defaults to true. |
| `format` | `"markdown" \| "json"` | Defaults to Markdown. |

Failures (missing path, unknown ref, denied capability) come back as
`isError` tool results with an actionable message, not as protocol errors.

### Untrusted content in the report

The report is designed to be read by an AI agent, so every value that comes
from the repository is treated as hostile. Command output is wrapped in a fence
sized longer than any backtick run it contains, and file paths, the repository
path and command names are rendered as inline code with control characters
escaped. Git permits newlines in path names, so a file called
`evil\n## Injected Heading` would otherwise write its own section — and its own
instructions — into the document.

Untracked files are listed in a separate section, because they are working-tree
state rather than part of the base..HEAD comparison, and merging the two
misrepresents what a branch actually changed.

### A note on `baseRef` validation

The ref pattern is not cosmetic. The base ref used to be interpolated into
`` `${base}...HEAD` ``, so a ref of `--output=/tmp/x` became the git flag
`--output=/tmp/x...HEAD` and wrote the diff to a caller-chosen path. Refs are
now pattern-checked, resolved to commit SHAs before reaching `git diff`, and
passed after a `--` separator.

## Project layout

```text
src/contract.ts     shared request schema and capability model
src/core.ts         review orchestration, returns structured data
src/cli.ts          command-line adapter
src/mcp-server.ts   MCP adapter
src/git.ts          Git inspection
src/validation.ts   validation execution
src/report.ts       Markdown and JSON rendering
test/               tests, one per fixed defect
tsconfig.build.json build config that emits src only, so bin resolves
```

## Submission

See `SUBMISSION.md`. Note that this file previously carried a submission
instruction that conflicted with the one candidates receive by email; that
discrepancy is documented in `SUBMISSION.md` rather than acted on unilaterally.
