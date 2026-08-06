import { describe, expect, it } from "vitest";
import {
  CLI_CAPABILITIES,
  assertWithinCapabilities,
  mcpCapabilities,
  parseReviewRequest,
} from "../src/contract.js";

describe("review request contract", () => {
  it("applies defaults so adapters cannot drift on optional fields", () => {
    const request = parseReviewRequest({ repositoryPath: "/tmp/repo" });

    expect(request).toEqual({
      repositoryPath: "/tmp/repo",
      validationCommands: [],
      includeUntracked: true,
      format: "markdown",
    });
  });

  it("preserves a repository path containing spaces", () => {
    const request = parseReviewRequest({ repositoryPath: "/Users/me/My Project" });

    expect(request.repositoryPath).toBe("/Users/me/My Project");
  });

  it.each([
    "--output=/tmp/pwned",
    "-x",
    "main;rm -rf /",
    "$(whoami)",
    "main HEAD",
  ])("rejects option-shaped or injectable base ref %j", (baseRef) => {
    expect(() => parseReviewRequest({ repositoryPath: "/tmp/repo", baseRef })).toThrow(
      /baseRef/,
    );
  });

  it.each(["main", "master", "release/1.2", "v1.0.0", "feature/a-b_c"])(
    "accepts legitimate ref %j",
    (baseRef) => {
      expect(parseReviewRequest({ repositoryPath: "/tmp/repo", baseRef }).baseRef).toBe(
        baseRef,
      );
    },
  );

  it("rejects a missing repository path with a readable message", () => {
    expect(() => parseReviewRequest({})).toThrow(/repositoryPath/);
  });

  it("rejects an unsupported format", () => {
    expect(() =>
      parseReviewRequest({ repositoryPath: "/tmp/repo", format: "yaml" }),
    ).toThrow(/format/);
  });
});

describe("capabilities", () => {
  const request = parseReviewRequest({
    repositoryPath: "/tmp/repo",
    validationCommands: ["npm test"],
  });

  it("lets the CLI run validation commands", () => {
    expect(() => assertWithinCapabilities(request, CLI_CAPABILITIES)).not.toThrow();
  });

  it("refuses command execution over MCP by default", () => {
    expect(() => assertWithinCapabilities(request, mcpCapabilities({}))).toThrow(
      /does not run validation commands/,
    );
  });

  it("allows MCP command execution only when explicitly opted in", () => {
    const optedIn = mcpCapabilities({ INSPECTOR_ALLOW_MCP_VALIDATION: "1" });

    expect(() => assertWithinCapabilities(request, optedIn)).not.toThrow();
  });

  it("bounds MCP output more tightly than the CLI's", () => {
    expect(mcpCapabilities({}).maxOutputBytes).toBeLessThan(
      CLI_CAPABILITIES.maxOutputBytes,
    );
  });
});
