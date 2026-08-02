// Regression tests for the global --state-dir parser. A whole-argv scan would
// break free-text prompts: one that merely mentions "--state-dir" would lose its
// next word to the option value, or throw "Missing value" when the mention came
// last.
//
// End-to-end behaviour needs the child-process case at the bottom, since
// codex-companion.mjs runs main() at import time.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import { splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";
import { extractStateDir } from "../plugins/codex/scripts/lib/state-dir-args.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const COMPANION = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

// Mirrors main(): a single quoted argument string is tokenized only when it
// mentions the option at all.
function parse(argv) {
  const tokens = argv.length === 1 && argv[0]?.includes("--state-dir") ? splitRawArgumentString(argv[0]) : argv;
  return extractStateDir(tokens);
}

test("prompt text that mentions --state-dir is left completely intact", () => {
  for (const prompt of [
    "does --state-dir work here",
    "explain --state-dir",
    "review the --state-dir flag please",
    "why did --state-dir break"
  ]) {
    const result = parse([prompt]);
    assert.equal(result.stateDir, null, `${prompt}: must not consume an option value`);
    assert.equal(result.rest.join(" "), prompt, `${prompt}: prompt text must survive verbatim`);
  }
});

test("a real leading --state-dir is still parsed, in both forms", () => {
  const spaced = parse(["--state-dir", "/tmp/a", "status"]);
  assert.equal(spaced.stateDir, "/tmp/a");
  assert.deepEqual(spaced.rest, ["status"]);

  const equals = parse(["--state-dir=/tmp/b", "status"]);
  assert.equal(equals.stateDir, "/tmp/b");
  assert.deepEqual(equals.rest, ["status"]);
});

test("--state-dir is parsed when it follows other options, and prompt text after it survives", () => {
  const withFlags = parse(["--json", "--state-dir", "/tmp/c"]);
  assert.equal(withFlags.stateDir, "/tmp/c");

  // The option is consumed; a later mention inside prompt text is not.
  const withPrompt = parse(["--state-dir", "/tmp/d", "task", "fix --state-dir docs"]);
  assert.equal(withPrompt.stateDir, "/tmp/d");
  assert.deepEqual(withPrompt.rest, ["task", "fix --state-dir docs"]);
});

test("other leading options are passed through, not swallowed", () => {
  // Dropping the leading options it skips would make `setup --enable-review-gate`
  // silently do nothing and `--json` return prose.
  const gate = parse(["--enable-review-gate"]);
  assert.equal(gate.stateDir, null);
  assert.deepEqual(gate.rest, ["--enable-review-gate"]);

  const both = parse(["--enable-bedrock-only", "--json"]);
  assert.deepEqual(both.rest, ["--enable-bedrock-only", "--json"]);

  // ...and they survive alongside a real --state-dir, which is still consumed.
  const mixed = parse(["--json", "--state-dir", "/tmp/c"]);
  assert.equal(mixed.stateDir, "/tmp/c");
  assert.deepEqual(mixed.rest, ["--json"]);

  const trailing = parse(["--json", "status"]);
  assert.deepEqual(trailing.rest, ["--json", "status"]);
});

test("--state-dir must lead a subcommand that takes value options", () => {
  // The scan stops at the first non-option token, and `--cwd <path>` supplies
  // one -- so the detached task worker has to receive --state-dir first.
  const leading = parse(["--state-dir", "/tmp/w", "--cwd", "/repo", "--job-id", "task-1"]);
  assert.equal(leading.stateDir, "/tmp/w");
  assert.deepEqual(leading.rest, ["--cwd", "/repo", "--job-id", "task-1"]);

  const trailing = parse(["--cwd", "/repo", "--job-id", "task-1", "--state-dir", "/tmp/w"]);
  assert.equal(trailing.stateDir, null, "a trailing --state-dir is not picked up");
});

test("-- ends option parsing", () => {
  const result = parse(["--", "--state-dir", "/tmp/nope"]);
  assert.equal(result.stateDir, null);
  assert.deepEqual(result.rest, ["--", "--state-dir", "/tmp/nope"]);
});

test("a genuinely missing value is still an error", () => {
  assert.throws(() => extractStateDir(["--state-dir"]), /Missing value for --state-dir/);
  assert.throws(() => extractStateDir(["--state-dir="]), /Missing value for --state-dir/);
});

test("end to end: a prompt mentioning --state-dir does not fail the command", () => {
  // task-resume-candidate is read-only and needs no Codex runtime, so it is a
  // safe way to drive the real argv path.
  const result = spawnSync(process.execPath, [COMPANION, "task-resume-candidate", "explain --state-dir"], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir("codex-plugin-data-") }
  });

  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Missing value for --state-dir/);
});

// --state-dir is documented as global, so it must work on either side of the
// subcommand. Placed before it, main() has to re-derive the subcommand from
// what is left -- otherwise the option itself is read as the subcommand.
for (const [label, argv] of [
  ["before the subcommand", (stateDir) => ["--state-dir", stateDir, "status", "--json"]],
  ["after the subcommand", (stateDir) => ["status", "--state-dir", stateDir, "--json"]],
  ["in --state-dir=<path> form", (stateDir) => [`--state-dir=${stateDir}`, "status", "--json"]]
]) {
  test(`end to end: --state-dir is honoured ${label}`, () => {
    const stateDir = makeTempDir("codex-plugin-state-");
    const env = { ...process.env };
    delete env.CLAUDE_PLUGIN_DATA;

    const result = spawnSync(process.execPath, [COMPANION, ...argv(stateDir)], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      env
    });

    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(output, /Unknown subcommand/, output);
    assert.doesNotMatch(output, /Unable to resolve the Codex plugin state directory/, output);
    assert.equal(result.status, 0, output);
    // `status --json` is valid JSON only if the override actually resolved.
    // (`status` only reads, so it does not create the directory -- the write
    // path is covered separately below.)
    assert.doesNotThrow(() => JSON.parse(result.stdout), output);
  });
}

test("end to end: state written under --state-dir really lands there", () => {
  const stateDir = makeTempDir("codex-plugin-state-");
  const binDir = makeTempDir("codex-plugin-bin-");
  installFakeCodex(binDir);

  const env = { ...buildEnv(binDir) };
  delete env.CLAUDE_PLUGIN_DATA;

  const result = spawnSync(
    process.execPath,
    [COMPANION, "--state-dir", stateDir, "setup", "--enable-review-gate", "--json"],
    { cwd: makeTempDir("codex-plugin-repo-"), encoding: "utf8", windowsHide: true, env }
  );

  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.equal(JSON.parse(result.stdout).reviewGateEnabled, true, output);

  const workspaces = fs.readdirSync(stateDir);
  assert.equal(workspaces.length, 1, `expected one workspace dir under ${stateDir}, got ${workspaces}`);
  assert.equal(fs.existsSync(path.join(stateDir, workspaces[0], "state.json")), true);
});
