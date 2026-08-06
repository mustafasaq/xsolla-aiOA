import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertGitRepository,
  changedFiles,
  resolveComparison,
  untrackedFiles,
} from "../src/git.js";
import { RepoFixture } from "./fixture.js";

describe("git inspection", () => {
  let repo: RepoFixture;

  beforeEach(() => {
    repo = RepoFixture.create();
    repo.write("a.txt", "original\n");
    repo.commit("init");
    repo.git(["checkout", "--quiet", "-b", "feature"]);
  });

  afterEach(() => repo.cleanup());

  function diff() {
    const comparison = resolveComparison(repo.path, "main");
    return changedFiles(repo.path, comparison.baseCommit, comparison.headCommit);
  }

  it("reports a rename as a rename and keeps both paths distinct", () => {
    // Regression: `--name-status` emits `R100\told\tnew`. The starter joined
    // the trailing fields with a tab, producing one corrupted path string.
    repo.git(["mv", "a.txt", "renamed.txt"]);
    repo.commit("rename");

    const files = diff();

    expect(files).toEqual([
      { path: "renamed.txt", status: "renamed", previousPath: "a.txt" },
    ]);
  });

  it("handles paths containing spaces and non-ASCII characters", () => {
    repo.write("b file.txt", "b\n");
    repo.write("café ☕.txt", "c\n");
    repo.commit("awkward names");

    const paths = diff().map((file) => file.path).sort();

    expect(paths).toEqual(["b file.txt", "café ☕.txt"]);
  });

  it("classifies additions, modifications and deletions", () => {
    repo.write("added.txt", "new\n");
    repo.write("a.txt", "changed\n");
    repo.commit("mixed");
    repo.git(["rm", "--quiet", "a.txt"]);
    repo.commit("delete");

    const byPath = Object.fromEntries(
      diff().map((file) => [file.path, file.status]),
    );

    expect(byPath).toEqual({ "added.txt": "added", "a.txt": "deleted" });
  });

  it("surfaces untracked files, a status the starter could never produce", () => {
    repo.write("scratch.txt", "not staged\n");

    expect(untrackedFiles(repo.path)).toEqual([
      { path: "scratch.txt", status: "untracked" },
    ]);
  });

  it("excludes commits the base branch gained after the fork point", () => {
    // This is what `base...HEAD` means, reproduced via an explicit merge-base.
    repo.write("feature.txt", "f\n");
    repo.commit("feature work");
    repo.git(["checkout", "--quiet", "main"]);
    repo.write("mainline.txt", "m\n");
    repo.commit("unrelated mainline work");
    repo.git(["checkout", "--quiet", "feature"]);

    expect(diff().map((file) => file.path)).toEqual(["feature.txt"]);
  });

  describe("base ref resolution", () => {
    it("falls back to master when main does not exist", () => {
      const master = RepoFixture.create({ defaultBranch: "master" });
      try {
        master.write("a.txt", "a\n");
        master.commit("init");

        const comparison = resolveComparison(master.path);

        expect(comparison.baseRef).toBe("master");
        expect(comparison.notes.join(" ")).toContain("master");
      } finally {
        master.cleanup();
      }
    });

    it("rejects a base ref shaped like a git option", () => {
      // The starter interpolated the ref into `${base}...HEAD`, so this value
      // became `--output=/tmp/pwned...HEAD` and git wrote the diff to that path.
      expect(() => resolveComparison(repo.path, "--output=/tmp/pwned")).toThrow(
        /does not exist/,
      );
    });

    it("explains an unknown base ref instead of leaking a git stack trace", () => {
      expect(() => resolveComparison(repo.path, "release/9.9")).toThrow(
        /Base ref 'release\/9.9' does not exist/,
      );
    });
  });

  describe("repository validation", () => {
    it("rejects a path that is not a git repository", () => {
      expect(() => assertGitRepository("/tmp")).toThrow(/Not a Git repository/);
    });

    it("rejects a path that does not exist", () => {
      expect(() => assertGitRepository("/tmp/definitely-not-here-42")).toThrow(
        /does not exist/,
      );
    });
  });
});
