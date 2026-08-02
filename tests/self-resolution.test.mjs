// Covers resolving the plugin's own data dir when CLAUDE_PLUGIN_DATA is unset,
// instead of falling back to os.tmpdir(). state.mjs resolves relative to its own
// file location, so these run a child process from a simulated install tree.

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

// Build a fake ~/.claude tree with this plugin "installed" under the given key,
// and return the config dir plus the path to the installed state.mjs.
function stageInstalledPlugin({ pluginKey, includeSelf = true }) {
  const configDir = makeTempDir("codex-plugin-config-");
  const installPath = path.join(configDir, "plugins", "cache", "marketplace", "plugin", "1.0.6");
  fs.mkdirSync(installPath, { recursive: true });
  fs.cpSync(path.join(PLUGIN_ROOT, "scripts"), path.join(installPath, "scripts"), { recursive: true });

  const plugins = {
    "unrelated@other-marketplace": [
      { installPath: path.join(configDir, "plugins", "cache", "other-marketplace", "unrelated", "2.0.0") }
    ]
  };
  if (includeSelf) {
    plugins[pluginKey] = [{ installPath, version: "1.0.6" }];
  }

  fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 1, plugins }, null, 2),
    "utf8"
  );

  return { configDir, installPath };
}

// Resolve a state dir in a child process with a controlled environment.
function resolveInChild({ configDir, installPath, workspace }) {
  const script = `
    import { resolveStateDir } from ${JSON.stringify(
      pathToFileURL(path.join(installPath, "scripts", "lib", "state.mjs")).href
    )};
    try {
      process.stdout.write(JSON.stringify({ ok: true, dir: resolveStateDir(${JSON.stringify(workspace)}) }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, message: error.message }));
    }
  `;

  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.CLAUDE_PLUGIN_DATA;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env,
    windowsHide: true
  });

  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("resolves its own data dir from installed_plugins.json when CLAUDE_PLUGIN_DATA is unset", () => {
  const pluginKey = "codex@openai-marketplace";
  const { configDir, installPath } = stageInstalledPlugin({ pluginKey });
  const workspace = makeTempDir();

  const outcome = resolveInChild({ configDir, installPath, workspace });

  assert.equal(outcome.ok, true, `expected resolution to succeed: ${outcome.message}`);
  // "<plugin>@<marketplace>" maps to the "<plugin>-<marketplace>" data dir.
  const expected = path.join(configDir, "plugins", "data", "codex-openai-marketplace", "state");
  assert.equal(outcome.dir.startsWith(expected), true, `expected ${outcome.dir} to start with ${expected}`);
});

test("resolution is independent of the plugin's own name", () => {
  // Forks rename the plugin, so resolution must not hardcode a name. Staging
  // under a different key must still resolve to that key's data dir.
  const { configDir, installPath } = stageInstalledPlugin({ pluginKey: "renamed-later@some-marketplace" });
  const workspace = makeTempDir();

  const outcome = resolveInChild({ configDir, installPath, workspace });

  assert.equal(outcome.ok, true, `expected resolution to succeed: ${outcome.message}`);
  const expected = path.join(configDir, "plugins", "data", "renamed-later-some-marketplace", "state");
  assert.equal(outcome.dir.startsWith(expected), true, `expected ${outcome.dir} to start with ${expected}`);
});

test("fails loudly instead of using the temp dir when the plugin is not in the registry", () => {
  const { configDir, installPath } = stageInstalledPlugin({
    pluginKey: "unused@unused",
    includeSelf: false
  });
  const workspace = makeTempDir();

  const outcome = resolveInChild({ configDir, installPath, workspace });

  assert.equal(outcome.ok, false, `expected a hard failure, got ${outcome.dir}`);
  assert.match(outcome.message, /Unable to resolve the Codex plugin state directory/);
  assert.match(outcome.message, /--state-dir/);
});

test("CLAUDE_CONFIG_DIR is honoured rather than assuming ~/.claude", () => {
  const pluginKey = "codex@openai-marketplace";
  const { configDir, installPath } = stageInstalledPlugin({ pluginKey });
  const workspace = makeTempDir();

  const outcome = resolveInChild({ configDir, installPath, workspace });

  assert.equal(outcome.ok, true, `expected resolution to succeed: ${outcome.message}`);
  assert.equal(
    outcome.dir.startsWith(configDir),
    true,
    `expected resolution under CLAUDE_CONFIG_DIR (${configDir}), got ${outcome.dir}`
  );
});
