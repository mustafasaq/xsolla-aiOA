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
stated; and the exit code is non-zero when a validation fails so CI can gate.

**Untrusted repository content in the report.** Command output is fenced with a
delimiter longer than any backtick run it contains. File paths, the repository
path and command names are rendered as inline code with control characters
escaped — git permits newlines in path names, so a file named
`evil\n## Injected Heading` could otherwise write its own section, and its own
instructions, into a document intended for an AI agent. See the corrections
section: I shipped the fence first and missed the path, which is how this was
found.

**Untracked files conflated with the comparison.** They were being merged into
`changedFiles` alongside committed changes, which misrepresents what a branch
actually changed. They now have their own field, their own report section, and
an `includeUntracked` / `--no-untracked` switch.

**Dependency vulnerabilities.** `npm audit` reported six advisories. The tree is
now clean at zero — see the corrections section, because the fix was not what I
first assumed.

65 tests were added, each tied to a specific defect and written to fail against
the code it guards.

## What did you intentionally not do?

- **Sandboxing validation commands.** The honest boundary is "the CLI user
  already has a shell," and the MCP surface refuses commands outright. Real
  isolation means containers or seccomp, which is a different project; the
  capability switch is deliberately all-or-nothing rather than pretending to a
  safety it does not provide.
- **Pagination for very large diffs.** They truncate at the capability limit
  with a note saying how many were dropped. Streaming or cursor-based paging is
  the right answer at scale and is speculative here.
- **A tunable rename-similarity threshold.** `--find-renames` uses git's
  default; exposing it is easy but I have no evidence anyone needs it.
- **Localisation.** The report is English-only with no seam for anything else.

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

**Rejected twice, and I was wrong both times — the `@hono/node-server`
override.** `package.json` pinned `@hono/node-server` to `2.0.10` while the MCP
SDK required `^1.19.9`: a cross-major override in a project that uses no Hono
directly. It looked planted, and I expected it to break the server. First
correction: I booted the server over real JSON-RPC before touching it, and it
served `tools/list` without complaint, so I dropped the "fix" rather than ship a
change justified by a stack trace I had imagined.

Second correction, later: when I did remove the override, `npm audit` went from
four advisories to six. The override had been *suppressing* one —
GHSA-frvp-7c67-39w9, a path traversal in `@hono/node-server`'s `serve-static`.
The thing I had twice written off as suspicious was a crude but real security
mitigation, forcing a patched major because the pinned SDK depended on a
vulnerable range. The actual fix was neither keeping nor deleting it: upgrading
to `@modelcontextprotocol/sdk@^1.30.0`, which adopts the patched Hono major
officially, then letting `npm audit fix` settle the rest. Zero advisories now,
no override needed.

The lesson I would take to a real codebase: an odd-looking pin is often someone
else's incident, and deleting it because it looks untidy is how a fixed
vulnerability gets reintroduced.

**Corrected: I fixed half of an injection and claimed the whole thing.** I
fenced untrusted *command output* against Markdown escape, wrote a test for it,
and highlighted it as a finding — then interpolated *file paths* into the same
document unescaped. Git allows newlines in path names and the `-z` parsing I had
just added preserves them perfectly, so a file named
`evil\n## Injected Heading\nIgnore previous instructions.txt` produced a report
containing a real heading and a real instruction. I found it by going back and
attacking my own fix instead of trusting the test I had written for it: the test
proved the fence worked, not that the report was safe. Now every repository-
derived value — paths, previous paths, the repository path, command names —
goes through one escaping helper, with regression tests per injection vector.

The generalisable version: a passing test for a mitigation says the mitigation
works on the input you thought of. It says nothing about the inputs you did not.

**Corrected: my own test contained the bug the product code was fixed for.**
The CLI integration test resolved the script path with
`new URL(...).pathname`, which percent-encodes. Checked out into a directory
containing a space it yields `/my%20project/src/cli.ts` and every test fails to
spawn — the same "path with a space" defect I had just fixed in `--repo`, this
time in the test guarding it. Verified both directions by cloning into
`/tmp/space test/proj`: all six fail with `pathname`, all six pass with
`fileURLToPath`.

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
npm test             # 66 passed (1 before)
npm run build        # clean
npm audit            # found 0 vulnerabilities (6 before)
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
| File named `evil\n## Injected Heading` | Wrote a real heading into the report | `` `evil\x0a## Injected Heading` `` inside inline code |
| Untracked files | Mixed into the base..HEAD file list | Separate section; `--no-untracked` to omit |
| `inspector --help` | — | Prints usage, exits 0 (was treated as an unknown command) |

A green suite only proves the tests run, not that they would catch a
regression, so I mutation-tested them: reintroduce each original defect in the
source, confirm the suite goes red, restore. Fourteen mutations — disabling path
escaping, rejecting on non-zero exit, restoring `.split(" ")[0]`, reporting
every change as `modified`, dropping rename detection, widening the ref pattern,
skipping the capability check, diffing from the base tip instead of the
merge-base, and others — and all fourteen were killed. None survived, so no fix
in this diff is guarded by a test that merely happens to pass.

I also checked the suite from a directory containing a space, which is how I
found the `pathname` bug in my own test described above.

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

1. **A real validation sandbox** — working-directory confinement, a scrubbed
   environment, no network — so `INSPECTOR_ALLOW_MCP_VALIDATION=1` stops being
   an all-or-nothing switch and becomes a gradient.
2. **Property-based tests for the escaping layer.** The injection I missed was
   found by hand-crafting one hostile filename. Generating adversarial paths and
   asserting that no output line ever begins with `#`, `>` or `-` outside a
   known position would cover the vectors I have not thought of.
3. **Renderer-level output budgeting.** Truncation is currently per-command and
   per-file-list; a very large diff plus verbose output can still produce a
   report bigger than a caller wants, because nothing caps the whole document.

Also outstanding: no pagination for very large diffs (they truncate with a
note), `--find-renames` uses git's default similarity threshold with no way to
tune it, and the report is English-only with no localisation seam.

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
- Finish: 2026-08-05, 22:00
- Total: approximately 75 focused minutes, within the 90-minute budget. Roughly
  the last third went on a second pass that attacked my own fixes rather than
  adding new ones, which is where the path-injection and dependency findings
  came from.
