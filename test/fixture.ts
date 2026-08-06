import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway Git repository for tests to run real git against. */
export class RepoFixture {
  readonly path: string;

  private constructor(path: string) {
    this.path = path;
  }

  static create(options: { defaultBranch?: string } = {}): RepoFixture {
    // The directory name contains a space on purpose: it is the regression
    // guard for the CLI truncating --repo at the first space.
    const root = mkdtempSync(join(tmpdir(), "inspector-"));
    const path = join(root, "my repo");
    execFileSync("mkdir", [path]);

    const fixture = new RepoFixture(path);
    fixture.git(["init", "--quiet", "-b", options.defaultBranch ?? "main"]);
    fixture.git(["config", "user.email", "fixture@example.com"]);
    fixture.git(["config", "user.name", "Fixture"]);
    return fixture;
  }

  git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  write(relativePath: string, content: string): void {
    writeFileSync(join(this.path, relativePath), content, "utf8");
  }

  commit(message: string): void {
    this.git(["add", "-A"]);
    this.git(["commit", "--quiet", "-m", message]);
  }

  cleanup(): void {
    rmSync(join(this.path, ".."), { recursive: true, force: true });
  }
}
