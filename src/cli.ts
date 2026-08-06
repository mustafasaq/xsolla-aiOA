#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CLI_CAPABILITIES } from "./contract.js";
import { hasFailures, renderReview, reviewRepository } from "./core.js";

const DEFAULT_OUTPUT = "review-report.md";

const USAGE = `Usage: inspector review --repo <path> [options]

Options:
  --repo <path>        Repository to inspect (required).
  --base-ref <ref>     Ref to compare HEAD against. Defaults to main, then master.
  --validate <command> Command to run in the repository. Repeatable.
  --format <fmt>       markdown (default) or json.
  --out <file>         Where to write the report. Defaults to ${DEFAULT_OUTPUT}.
  --stdout             Write the report to stdout instead of a file.
  -h, --help           Show this message.

Exit codes:
  0  review completed and every validation passed
  1  a validation failed, timed out, or the review could not run`;

type Args = {
  command: string;
  repositoryPath?: string;
  baseRef?: string;
  format: "markdown" | "json";
  validations: string[];
  outputPath: string;
  toStdout: boolean;
  help: boolean;
};

class UsageError extends Error {}

/** Reads the value after a flag, rejecting a missing or flag-shaped value. */
function valueFor(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) {
    throw new UsageError(`${flag} requires a value.`);
  }
  return value;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? "",
    format: "markdown",
    validations: [],
    outputPath: DEFAULT_OUTPUT,
    toStdout: false,
    help: false,
  };

  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    switch (token) {
      case "--repo":
        // Note: no .split(" ") here. The starter truncated the path at the
        // first space, so "/Users/me/My Project" silently became "/Users/me/My".
        args.repositoryPath = valueFor(argv, ++index, "--repo");
        break;
      case "--base-ref":
        args.baseRef = valueFor(argv, ++index, "--base-ref");
        break;
      case "--format": {
        const format = valueFor(argv, ++index, "--format");
        if (format !== "markdown" && format !== "json") {
          throw new UsageError(
            `Unsupported --format '${format}'. Use 'markdown' or 'json'.`,
          );
        }
        args.format = format;
        break;
      }
      case "--validate":
        args.validations.push(valueFor(argv, ++index, "--validate"));
        break;
      case "--out":
        args.outputPath = valueFor(argv, ++index, "--out");
        break;
      case "--stdout":
        args.toStdout = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        // Silently ignoring unknown flags hides typos like --base_ref.
        throw new UsageError(`Unknown option '${token}'.`);
    }
  }

  return args;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }

  if (args.help || args.command === "") {
    console.log(USAGE);
    return args.help ? 0 : 1;
  }
  if (args.command !== "review") {
    console.error(`Unknown command '${args.command}'.\n\n${USAGE}`);
    return 1;
  }
  if (!args.repositoryPath) {
    console.error(`--repo is required.\n\n${USAGE}`);
    return 1;
  }

  const result = await reviewRepository(
    {
      repositoryPath: args.repositoryPath,
      baseRef: args.baseRef,
      validationCommands: args.validations,
      format: args.format,
    },
    CLI_CAPABILITIES,
  );

  const report = renderReview(result, args.format);

  if (args.toStdout) {
    process.stdout.write(report);
  } else {
    writeFileSync(args.outputPath, report, "utf8");
    console.log(`Review report written to ${args.outputPath}`);
  }

  // A failing validation is a reportable result, not a crash — but the exit
  // code still has to reflect it so CI can gate on the review.
  return hasFailures(result) ? 1 : 0;
}

/** True only when this file is the process entry point, so importing
 *  `parseArgs` from a test does not execute a review. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  run();
}

function run(): void {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
    // Expected failures (bad path, unknown ref, capability denial) carry a
    // useful message; only genuinely unexpected ones deserve a stack trace.
      const named = error as { name?: string; message?: string };
      if (
        named?.name === "GitError" ||
        named?.name === "RequestError" ||
        named?.name === "CapabilityError"
      ) {
        console.error(`Error: ${named.message}`);
      } else {
        console.error("Fatal error:", error);
      }
      process.exitCode = 1;
    });
}
