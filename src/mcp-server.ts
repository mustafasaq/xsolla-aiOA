#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  MCP_VALIDATION_ENV,
  ReviewRequestShape,
  mcpCapabilities,
} from "./contract.js";
import { renderReview, reviewRepository } from "./core.js";

const capabilities = mcpCapabilities();

const server = new McpServer({
  name: "repository-inspector",
  version: "2.0.0",
});

/**
 * The advertised schema is derived from the shared contract rather than
 * hand-written. The starter declared `repo_path` but read `input.repoPath`, so
 * the path was always undefined and git ran in the server's own directory —
 * every call returned a confident review of the wrong repository. Deriving the
 * shape here means the field the tool advertises is the field the handler
 * receives, by construction, and that both interfaces accept the same request.
 *
 * `validationCommands` stays in the schema even when execution is disabled, so
 * that asking for it earns an explicit refusal explaining how to enable it. The
 * alternative — hiding the field — makes the server quietly discard the request
 * and return a report claiming no commands were requested.
 */
const inputShape = ReviewRequestShape;

const description = [
  "Inspects a Git repository and returns a review of the files changed",
  "between a base ref and HEAD.",
  capabilities.allowValidationCommands
    ? "Validation commands are enabled on this server."
    : `Validation commands are disabled; set ${MCP_VALIDATION_ENV}=1 to enable.`,
].join(" ");

server.registerTool(
  "review_repository",
  {
    title: "Review repository",
    description,
    inputSchema: inputShape,
    annotations: {
      // The tool only reads the repository unless validation is switched on.
      readOnlyHint: !capabilities.allowValidationCommands,
      openWorldHint: false,
    },
  },
  async (input) => {
    try {
      const result = await reviewRepository(input, capabilities);
      const format = input.format ?? "markdown";
      return {
        content: [{ type: "text" as const, text: renderReview(result, format) }],
      };
    } catch (error) {
      // A bad path or a denied capability is a normal tool outcome. Throwing
      // would surface as a protocol-level error and tell the model nothing
      // actionable about how to retry.
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `review_repository failed: ${message}` },
        ],
      };
    }
  },
);

await server.connect(new StdioServerTransport());
