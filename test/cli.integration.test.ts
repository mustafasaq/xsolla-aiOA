import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoFixture } from "./fixture.js";

const run = promisify(execFile);

// fileURLToPath, not URL.pathname: pathname percent-encodes, so a checkout in
// a directory containing a space would yield "/my%20project/src/cli.ts" and
// fail to spawn. That is the same defect this suite tests the CLI for.
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

type CliRun = { stdout: string; stderr: string; code: number };

/** Spawns the CLI the way a user does, so exit codes and file output are
 *  covered rather than just the parser. */
async function inspector(args: string[], cwd: string): Promise<CliRun> {
  try {
    const { stdout, stderr } = await run("npx", ["tsx", CLI, ...args], { cwd });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: failure.code ?? 1,
    };
  }
}

describe("inspector CLI end to end", () => {
  let repo: RepoFixture;

  beforeEach(() => {
    repo = RepoFixture.create();
    repo.write("a.txt", "original\n");
    repo.commit("init");
    repo.git(["checkout", "--quiet", "-b", "feature"]);
    repo.write("feature.txt", "work\n");
    repo.commit("feature work");
  });

  afterEach(() => repo.cleanup());

  it("exits 0 and writes a report file on success", async () => {
    const result = await inspector(
      ["review", "--repo", repo.path, "--base-ref", "main"],
      repo.path,
    );

    expect(result.code).toBe(0);
    expect(readFileSync(join(repo.path, "review-report.md"), "utf8")).toContain(
      "feature.txt",
    );
  });

  it("exits 1 when a validation fails but still writes the report", async () => {
    const result = await inspector(
      [
        "review",
        "--repo",
        repo.path,
        "--base-ref",
        "main",
        "--validate",
        "exit 1",
        "--out",
        "custom.md",
      ],
      repo.path,
    );

    expect(result.code).toBe(1);
    const report = readFileSync(join(repo.path, "custom.md"), "utf8");
    expect(report).toContain("FAILED");
    expect(report).toContain("feature.txt");
  });

  it("emits parseable JSON to stdout", async () => {
    const result = await inspector(
      ["review", "--repo", repo.path, "--base-ref", "main", "--format", "json", "--stdout"],
      repo.path,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).changedFiles[0].path).toBe("feature.txt");
  });

  it("honours --no-untracked", async () => {
    repo.write("scratch.txt", "x\n");

    const withUntracked = await inspector(
      ["review", "--repo", repo.path, "--base-ref", "main", "--format", "json", "--stdout"],
      repo.path,
    );
    const without = await inspector(
      [
        "review",
        "--repo",
        repo.path,
        "--base-ref",
        "main",
        "--no-untracked",
        "--format",
        "json",
        "--stdout",
      ],
      repo.path,
    );

    expect(JSON.parse(withUntracked.stdout).untrackedFiles).toHaveLength(1);
    expect(JSON.parse(without.stdout).untrackedFiles).toHaveLength(0);
  });

  it("exits 1 with a readable message when the path is not a repository", async () => {
    const result = await inspector(["review", "--repo", "/tmp"], repo.path);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Not a Git repository");
    expect(result.stderr).not.toContain("at Object.spawnSync");
  });

  it("prints usage for --help and exits 0", async () => {
    const result = await inspector(["--help"], repo.path);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: inspector review");
  });
});
