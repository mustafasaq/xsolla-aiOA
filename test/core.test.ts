import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";
import { CLI_CAPABILITIES, mcpCapabilities } from "../src/contract.js";
import { hasFailures, renderReview, reviewRepository } from "../src/core.js";
import { RepoFixture } from "./fixture.js";

describe("CLI argument parsing", () => {
  it("keeps a repository path containing spaces intact", () => {
    // Regression: the starter ran `.split(" ")[0]` on the value, silently
    // turning "/Users/me/My Project" into "/Users/me/My".
    const args = parseArgs(["review", "--repo", "/Users/me/My Project"]);

    expect(args.repositoryPath).toBe("/Users/me/My Project");
  });

  it("collects repeated --validate flags", () => {
    const args = parseArgs([
      "review",
      "--repo",
      "/tmp/r",
      "--validate",
      "npm test",
      "--validate",
      "npm run lint",
    ]);

    expect(args.validations).toEqual(["npm test", "npm run lint"]);
  });

  it("accepts a json format", () => {
    expect(parseArgs(["review", "--repo", "/tmp/r", "--format", "json"]).format).toBe(
      "json",
    );
  });

  it("rejects an unsupported format rather than silently writing markdown", () => {
    expect(() => parseArgs(["review", "--repo", "/tmp/r", "--format", "yaml"])).toThrow(
      /Unsupported --format/,
    );
  });

  it("rejects an unknown flag rather than ignoring a typo", () => {
    expect(() => parseArgs(["review", "--repo", "/tmp/r", "--base_ref", "main"])).toThrow(
      /Unknown option/,
    );
  });

  it("rejects a flag with no value", () => {
    expect(() => parseArgs(["review", "--repo"])).toThrow(/--repo requires a value/);
  });
});

describe("reviewRepository", () => {
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

  it("inspects the repository it was given, not the process working directory", async () => {
    // Regression: the MCP adapter read `input.repoPath` while advertising
    // `repo_path`, so the path was always undefined, `cwd` fell back to the
    // server's own directory, and the report was headed "undefined".
    const result = await reviewRepository(
      { repositoryPath: repo.path, baseRef: "main" },
      mcpCapabilities({}),
    );

    expect(result.repositoryPath).toBe(repo.path);
    expect(result.changedFiles.map((file) => file.path)).toEqual(["feature.txt"]);
    expect(renderReview(result, "markdown")).not.toContain("undefined");
  });

  it("refuses validation commands from an MCP caller by default", async () => {
    await expect(
      reviewRepository(
        { repositoryPath: repo.path, validationCommands: ["echo pwned"] },
        mcpCapabilities({}),
      ),
    ).rejects.toThrow(/does not run validation commands/);
  });

  it("still reports changed files when a validation fails", async () => {
    // The whole review used to be lost the moment one command exited non-zero.
    const result = await reviewRepository(
      {
        repositoryPath: repo.path,
        baseRef: "main",
        validationCommands: ["exit 1"],
      },
      CLI_CAPABILITIES,
    );

    expect(result.changedFiles.map((file) => file.path)).toEqual(["feature.txt"]);
    expect(result.validationResults[0].status).toBe("failed");
    expect(hasFailures(result)).toBe(true);
  });

  it("describes the same run in both formats", async () => {
    const result = await reviewRepository(
      { repositoryPath: repo.path, baseRef: "main" },
      CLI_CAPABILITIES,
    );

    const json = JSON.parse(renderReview(result, "json"));
    const markdown = renderReview(result, "markdown");

    expect(json.changedFiles[0].path).toBe("feature.txt");
    expect(markdown).toContain("feature.txt");
  });

  it("rejects an option-shaped base ref before it reaches git", async () => {
    await expect(
      reviewRepository(
        { repositoryPath: repo.path, baseRef: "--output=/tmp/pwned" },
        CLI_CAPABILITIES,
      ),
    ).rejects.toThrow(/baseRef/);
  });

  it("reports a non-repository path clearly", async () => {
    await expect(
      reviewRepository({ repositoryPath: "/tmp" }, CLI_CAPABILITIES),
    ).rejects.toThrow(/Not a Git repository/);
  });
});
