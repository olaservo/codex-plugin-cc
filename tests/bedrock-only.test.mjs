// End-to-end behaviour of the opt-in bedrock-only mode, driven through the real
// `setup` command. The two guarantees under test: the mode changes nothing until
// it is turned on, and once it is on the guidance never points at an
// OpenAI-hosted auth path.

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, run, useTempPluginData } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");

useTempPluginData();

const OPENAI_AUTH_PATHS = /codex login|OPENAI_API_KEY|with-api-key|device-auth/i;

function setup(args, { behavior = "review-ok", cwd = makeTempDir(), env = {} } = {}) {
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);

  const result = run("node", [SCRIPT, "setup", "--json", ...args], {
    cwd,
    env: { ...buildEnv(binDir), ...env }
  });

  assert.equal(result.status, 0, result.stderr);
  return { cwd, payload: JSON.parse(result.stdout) };
}

test("bedrock-only mode is off by default and does not affect readiness", () => {
  const { payload } = setup([]);

  assert.equal(payload.bedrockOnly.enabled, false);
  assert.equal(payload.bedrockOnly.source, "default");
  assert.equal(payload.ready, true, "an OpenAI-hosted provider stays ready while the mode is off");
  assert.equal(payload.provider.id, "openai");
  assert.equal(payload.provider.compliant, true);
});

test("the provider is reported even when the mode is off", () => {
  const { payload } = setup([], { behavior: "provider-no-auth" });

  assert.equal(payload.provider.id, "ollama");
  assert.equal(payload.provider.supported, false);
  assert.equal(payload.provider.compliant, true);
});

test("--enable-bedrock-only persists and blocks readiness for a non-Bedrock provider", () => {
  const workspace = makeTempDir();

  const enabled = setup(["--enable-bedrock-only"], { cwd: workspace });
  assert.equal(enabled.payload.bedrockOnly.enabled, true);
  assert.equal(enabled.payload.bedrockOnly.source, "config");
  assert.equal(enabled.payload.ready, false, "an OpenAI-hosted provider must not be ready");
  assert.equal(enabled.payload.provider.compliant, false);
  assert.match(enabled.payload.actionsTaken.join("\n"), /Enabled bedrock-only mode/);

  // The setting survives into the next invocation.
  const rechecked = setup([], { cwd: workspace });
  assert.equal(rechecked.payload.bedrockOnly.enabled, true);
  assert.equal(rechecked.payload.ready, false);
});

test("--disable-bedrock-only turns it back off", () => {
  const workspace = makeTempDir();

  setup(["--enable-bedrock-only"], { cwd: workspace });
  const disabled = setup(["--disable-bedrock-only"], { cwd: workspace });

  assert.equal(disabled.payload.bedrockOnly.enabled, false);
  assert.equal(disabled.payload.ready, true);
});

test("enabling both bedrock-only flags at once is rejected", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--enable-bedrock-only", "--disable-bedrock-only"], {
    cwd: makeTempDir(),
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Choose either --enable-bedrock-only or --disable-bedrock-only\./);
});

test("an amazon-bedrock provider is ready with the mode on", () => {
  const { payload } = setup(["--enable-bedrock-only"], { behavior: "bedrock-provider" });

  assert.equal(payload.provider.id, "amazon-bedrock");
  assert.equal(payload.provider.supported, true);
  assert.equal(payload.provider.compliant, true);
  assert.equal(payload.ready, true);
  assert.deepEqual(
    payload.nextSteps.filter((step) => /model_provider/.test(step)),
    []
  );
});

test("CODEX_PLUGIN_BEDROCK_ONLY overrides the per-workspace setting in both directions", () => {
  const workspace = makeTempDir();

  const forcedOn = setup([], { cwd: workspace, env: { CODEX_PLUGIN_BEDROCK_ONLY: "1" } });
  assert.equal(forcedOn.payload.bedrockOnly.enabled, true);
  assert.equal(forcedOn.payload.bedrockOnly.source, "env");
  assert.equal(forcedOn.payload.ready, false);

  setup(["--enable-bedrock-only"], { cwd: workspace });
  const forcedOff = setup([], { cwd: workspace, env: { CODEX_PLUGIN_BEDROCK_ONLY: "0" } });
  assert.equal(forcedOff.payload.bedrockOnly.enabled, false);
  assert.equal(forcedOff.payload.bedrockOnly.source, "env");
  assert.equal(forcedOff.payload.ready, true);
});

test("with the mode on, next steps point at Bedrock and never at an OpenAI auth path", () => {
  const { payload } = setup(["--enable-bedrock-only"], { behavior: "logged-out" });

  assert.equal(payload.ready, false);
  const steps = payload.nextSteps.join("\n");
  assert.match(steps, /model_provider = "amazon-bedrock"/);
  assert.doesNotMatch(steps, OPENAI_AUTH_PATHS);
  assert.doesNotMatch(payload.provider.detail, OPENAI_AUTH_PATHS);
});

test("with the mode off, the usual codex login guidance is preserved", () => {
  const { payload } = setup([], { behavior: "logged-out" });

  assert.equal(payload.ready, false);
  assert.match(payload.nextSteps.join("\n"), /Run `!codex login`\./);
});

test("the rendered setup report shows the provider and the bedrock-only mode", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "bedrock-provider");

  const result = run("node", [SCRIPT, "setup", "--enable-bedrock-only"], {
    cwd: makeTempDir(),
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /- model provider: amazon-bedrock \(traffic stays in your own AWS account\)/);
  assert.match(result.stdout, /- bedrock-only mode: enabled/);
});

test("the setup command doc explains the mode without suggesting an OpenAI auth path for it", () => {
  const body = fs.readFileSync(path.join(PLUGIN_ROOT, "commands", "setup.md"), "utf8");

  assert.match(body, /--enable-bedrock-only\|--disable-bedrock-only/);
  assert.match(body, /amazon-bedrock/);
  assert.match(body, /CODEX_PLUGIN_BEDROCK_ONLY/);
  // The doc names the forbidden commands to forbid them, so only the
  // instructional phrasing is checked here.
  assert.doesNotMatch(body, /Run `!?codex login/);
});
