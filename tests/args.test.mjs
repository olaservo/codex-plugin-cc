import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";

// Options after a positional are load-bearing for status/result/cancel:
// `status job-1 --all --json` must keep parsing. Pin it.
test("parseArgs keeps parsing options after a positional by default", () => {
  const { options, positionals } = parseArgs(["job-1", "--all", "--json"], {
    booleanOptions: ["all", "json"]
  });

  assert.deepEqual(options, { all: true, json: true });
  assert.deepEqual(positionals, ["job-1"]);
});

test("stopAtFirstPositional leaves flag-shaped prompt text in the prompt", () => {
  const { options, positionals } = parseArgs(["explain", "--write", "handling"], {
    booleanOptions: ["write"],
    stopAtFirstPositional: true
  });

  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["explain", "--write", "handling"]);
});

test("stopAtFirstPositional does not eat value options out of prompt text", () => {
  const { options, positionals } = parseArgs(["review", "the", "--cwd", "flag"], {
    valueOptions: ["cwd"],
    stopAtFirstPositional: true
  });

  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["review", "the", "--cwd", "flag"]);
});

test("stopAtFirstPositional still honors leading options", () => {
  const { options, positionals } = parseArgs(
    ["--write", "--model", "spark", "fix", "the", "--json", "bug"],
    {
      valueOptions: ["model"],
      booleanOptions: ["write", "json"],
      stopAtFirstPositional: true
    }
  );

  assert.deepEqual(options, { write: true, model: "spark" });
  assert.deepEqual(positionals, ["fix", "the", "--json", "bug"]);
});

test("stopAtFirstPositional stops at an unknown flag-shaped token", () => {
  const { options, positionals } = parseArgs(["--verbose", "is", "broken", "--write"], {
    booleanOptions: ["write"],
    stopAtFirstPositional: true
  });

  assert.deepEqual(options, {});
  assert.deepEqual(positionals, ["--verbose", "is", "broken", "--write"]);
});
