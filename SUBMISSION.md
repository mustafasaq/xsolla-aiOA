# Submission

## What did you investigate first, and why?

I ran the setup commands before reading any source. Everything passed —
install, typecheck, one green test, green CI. That was the most informative
result of the session: it meant any real defect was silent, and that the test
suite could not be trusted as evidence. The single existing test asserted that
`markdownReport` concatenates strings and touched nothing else.

So I read all seven source files end to end (~150 lines) and traced the two
entry points down to the shared core, looking specifically for places where the
two adapters disagreed with each other or with the README. Then I built a
throwaway repository containing the awkward cases a real repo has — a directory
name with a space, a rename, an untracked file, a non-`main` default branch —
and ran the actual tool against it rather than reasoning about what it would do.

Three of my four initial hypotheses reproduced immediately. That fixture is now
`test/fixture.ts`.

## What did you choose to implement or fix?

**The MCP tool inspected the wrong repository.** It advertised `repo_path` and
read `input.repoPath`, so the path was always `undefined`, `cwd` fell through to
the server's own directory, and every call returned a confident, well-formed
review of the wrong thing headed `# Review Report: undefined`. `input: any` was
what let it compile. Verified over real JSON-RPC before and after.

**A failing validation destroyed the review.** `runValidation` called
`reject()` on a non-zero exit — the exact condition the tool exists to report.
`status: "failed"` was unreachable code. One failing test aborted everything,
including the changed-file list. Validation now always resolves, with
`passed` / `failed` / `timed_out`, an exit code, and a duration.

**`--repo` truncated at the first space.** `.split(" ")[0]` turned
`/Users/me/My Project` into `/Users/me/My`. It looked like an attempt at
sanitisation, but arguments already reach git as an array and are never
word-split, so it bought nothing and silently corrupted valid input.

**`--format json` did not exist.** It was parsed, typed, and threaded into the
core, which ignored it. I fixed the root cause rather than the symptom: the core
now returns structured data and rendering is a view over it, so the two formats
cannot describe different runs.

**Arbitrary file write through `baseRef`.** The ref was interpolated into
`` `${base}...HEAD` ``, so `--base-ref '--output=/tmp/pwned'` became a git flag.
I confirmed this by running it — git wrote the diff to `/tmp/pwned...HEAD`. Refs
are now pattern-validated, resolved to SHAs before reaching `git diff`, and
passed after `--`.

**Unrestricted command execution over MCP.** `validationCommands` was exposed to
model-supplied input with no allowlist, timeout, or output bound. This is the
trust boundary the brief asks about, so I made it explicit rather than
incidental: `src/contract.ts` defines a capability model, the CLI keeps full
capability, and MCP refuses command execution unless the operator sets
`INSPECTOR_ALLOW_MCP_VALIDATION=1`.

**Git-layer correctness.** Renames emit three NUL-separated fields; the starter
joined the trailing ones with a tab and produced one corrupted path. Untracked
files never appeared despite `"untracked"` being a declared status. The base was
hardcoded to `main`. Now: `-z` parsing, proper `A/D/M/R/C/T/U` mapping with
`previousPath`, untracked files included, `main` → `master` → `HEAD~1`
fallback with the choice reported, explicit merge-base, `maxBuffer` raised, and
a real error when the path is not a repository.

**The published binary pointed at a file the build never produced.** Found while
verifying, not while reading: `package.json` declares
`"bin": {"inspector": "./dist/cli.js"}`, but because `rootDir` was `.` and the
build included `test/`, `tsc` emitted `dist/src/cli.js`. Anyone installing this
package would get a broken `inspector` command. Split out `tsconfig.build.json`
so the build compiles `src` only, and confirmed `node dist/cli.js` runs.

**Report and exit codes.** Pass/fail and exit code are now rendered (previously
dropped entirely, so a pass and a failure looked identical); empty state is
stated; the exit code is non-zero when a validation fails so CI can gate; and
code fences are sized longer than any backtick run in the content, because the
output is untrusted and the consumer is an AI agent.

53 tests were added, each one tied to a specific defect and written to fail
against the original code.

## What did you intentionally not do?

- **`npm audit` findings (2 high, 2 moderate).** All transitive through the MCP
  SDK, none reachable from this code. Bumping them is a lockfile change I could
  not verify in the time available.
- **The `@hono/node-server` override.** See below — I investigated it, found my
  suspicion wrong, and left it alone.
- **Sandboxing validation commands.** The honest boundary is "the CLI user
  already has a shell." Real isolation means containers, which is a different
  project.
- **Streaming, pagination, and output schema versioning.** Relevant at scale,
  speculative here.
- **A CLI integration test spawning the built binary.** `parseArgs` and the core
  are tested separately; the seam between them is thin and covered manually.

## Interface decision

- **Decision:** Hybrid, with one shared contract and asymmetric capabilities.
- **Primary user and execution environment:** Two, deliberately. A developer at
  a terminal on a trusted machine, and an AI coding agent calling a stdio server
  it did not launch.
- **Trust boundary and allowed capabilities:** The boundary is *who chose the
  command*. A developer typing `--validate "npm test"` gains nothing they did
  not already have. An agent's input may be influenced by repository content or
  a web page, so it gets a read-only review unless the operator opts in where
  the server is launched. The refusal is explicit, not a silently reduced
  result.
- **Reliability, discoverability, latency/context, and output tradeoffs:** MCP
  caps output at 64 KB against the CLI's 1 MB because the report lands in a
  context window rather than a file. Timeouts are shorter for the same reason.
  Discoverability is why the tool description states the capability state and
  why `validationCommands` stays in the schema even when disabled — hiding it
  makes the server quietly discard the request.
- **How supported interfaces remain consistent:** Structurally, not by
  discipline. One Zod schema in `src/contract.ts` defines a request; both
  adapters parse through it; the core returns structured data and rendering is a
  view. The original bugs were only possible because each adapter defined its
  own contract.
- **Evidence that would change this decision:** Agents mostly calling this in
  throwaway sandboxes would justify enabling validation by default. Humans
  consuming it primarily through an agent would justify MCP-first. One report of
  a model being talked into running a command via repository content would
  justify removing the opt-in entirely.

## How did you use an AI coding agent?

I used Claude Code throughout — reading the codebase, forming hypotheses about
defects, writing the refactor and the tests, and drafting this document. The
division of labour I settled on: the agent is fast at proposing where bugs might
be and at writing the mechanical parts of a fix, and unreliable about whether a
bug is real. So I made it reproduce each defect against a scratch repository
before fixing it, and required every fix to arrive with a test that fails
against the original code. Reproduce first, then fix — the test suite is the
audit trail.

## Where did you check, correct, or reject an AI suggestion? (required)

**Rejected: a dependency "fix" for a bug that did not exist.** I noticed
`package.json` overrides `@hono/node-server` to `2.0.10` while the MCP SDK
requires `^1.19.9` — a cross-major pin, in a project that uses no Hono directly.
It looked planted, and the agent and I both expected it to break the server. I
had it booted over real JSON-RPC before touching it, and it initialised and
served `tools/list` without complaint. The suspicious-looking thing was not the
bug. I removed the change and documented the override as unexplained rather than
shipping a fix with a fabricated justification. Had I trusted the reasoning
instead of the test, I would have written a confident and false claim into this
document.

**Corrected: a bug in my own truncation code, caught by a test.** The first
implementation passed `maxOutputBytes` as both the `exec` capture buffer and the
report limit. Node kills the child the instant it hits `maxBuffer`, so the
command's real exit status was lost — and because a `maxBuffer` kill sets the
same `killed` flag a timeout does, a merely chatty command was reported as
having hung. The test I had written for truncation failed, which is how I found
it. Fixed by capturing with 8× headroom and checking
`ERR_CHILD_PROCESS_STDIO_MAXBUFFER` before the timeout branch.

**Corrected: a "safe" MCP schema that silently discarded input.** My first
version hid `validationCommands` from the advertised schema when execution was
disabled. Testing it showed the SDK strips the unknown field, so a caller asking
for validations got a successful report stating none were requested — the same
silent-wrong-answer pattern as the original `repo_path` bug, reintroduced in the
name of safety. Changed to advertise the field and refuse it explicitly.

## Commands used to verify the result, with outcomes

```bash
npm run typecheck    # clean
npm test             # 54 passed (1 before)
npm run build        # clean
```

Behavioural checks against a fixture repo with a space in its path, a rename, and
an untracked file:

| Check | Before | After |
|---|---|---|
| `--repo "/tmp/xs-probe/my repo"` | `spawnSync git ENOENT` + stack trace | Reviews correctly |
| Rename | `a.txt\trenamed.txt` as one "modified" path | `renamed.txt (renamed) (from a.txt)` |
| Untracked file | Never listed | Listed as `untracked` |
| `--validate "exit 1"` | `Fatal error`, no report at all | Report written, `FAILED · exit 1`, exit code 1 |
| `--base-ref '--output=/tmp/pwned'` | Wrote the diff to `/tmp/pwned...HEAD` | Rejected; no file created |
| `--repo /tmp` | Raw `execFileSync` stack trace | `Not a Git repository: /tmp. Point --repo at...` |
| `--base_ref` typo | Silently ignored | `Unknown option '--base_ref'` |
| `node dist/cli.js` after `npm run build` | Emitted to `dist/src/cli.js`; `bin` path broken | Emitted to `dist/cli.js`; runs |

Over real JSON-RPC against the stdio server:

| Check | Before | After |
|---|---|---|
| `tools/call` with a repo path | `# Review Report: undefined` (reviewed its own directory) | Reviews the requested repository |
| Nonexistent path | Protocol-level crash | `isError` result with a usable message |
| `validationCommands: ["touch /tmp/rce-proof"]` | File created | Refused; no execution |
| Same, with `INSPECTOR_ALLOW_MCP_VALIDATION=1` | — | Runs, as opted in |

## A blocker you hit and how you approached it

Exporting `parseArgs` so it could be tested caused `main()` to execute on import,
because the module ran it at top level — the test run started performing real
reviews. I added an entry-point guard comparing `import.meta.url` to
`process.argv[1]`, which keeps the CLI a single file while leaving the parser
importable.

The broader blocker was scope. The defect list ran well past what 90 minutes
allows, and the temptation was to fix everything shallowly. I sorted by "what
returns a confidently wrong answer to a user who cannot tell" — that put the MCP
path bug and the swallowed validation failures first, ahead of more visible
issues like the missing JSON format, and I let the rest go with this file as the
record.

## Known limitations and the next three things you would do

1. **An end-to-end CLI test that spawns the built binary** and asserts on exit
   codes and file output. The parser and core are tested; the seam is not.
2. **A real validation sandbox** — working directory confinement, a scrubbed
   environment, and no network — so `INSPECTOR_ALLOW_MCP_VALIDATION=1` stops
   being all-or-nothing.
3. **Resolve the dependency override.** Find out why `@hono/node-server` is
   pinned across a major version, then remove it or document why it must stay.

Also outstanding: no pagination for very large diffs (they truncate with a note),
`--find-renames` uses git's default similarity threshold with no way to tune it,
and the report is English-only with no localisation seam.

## Note on the submission channel

`README.md` and `SECURITY.md` in this template instruct candidates to submit via
**Security → Report a vulnerability** and state: *"Do not reply by email; that
submission channel is not monitored."* The invitation email instructs the
opposite — reply by email with the repository URL — and explicitly asks
candidates to report any issues found in the repository. Git history shows both
instructions were added after the initial commit, the most recent titled *"Fix
stale submission instruction: point to Security > Report a vulnerability, not
email reply."*

I have not treated the in-repository text as authoritative over a direct
instruction from a named person, and I have used both channels rather than
letting a file inside the artifact under review override the human who assigned
it. Flagging it here because, in a tool whose entire purpose is to feed
repository contents to an AI agent, "does text inside the artifact get to
redirect the reader's actions?" is the same question this codebase poses in
`validationCommands` — and if the conflict is unintentional, it is worth
knowing about.

## Approximate focused-work time

- Start: 2026-08-05, 20:15
- Finish: 2026-08-05, 20:50
- Total: approximately 35 focused minutes, within the 90-minute budget.
