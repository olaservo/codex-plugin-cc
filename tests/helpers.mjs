import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

// state.mjs no longer falls back to os.tmpdir(), so a test file that touches
// state must say where state lives. Call this once at the top of such a file:
// it pins CLAUDE_PLUGIN_DATA for this process and, because `run()` passes
// `{ ...process.env }` through, for every child it spawns. Pinning it also makes
// the suite hermetic -- otherwise it inherits whatever the ambient Claude Code
// session exported.
export function useTempPluginData() {
  const pluginDataDir = makeTempDir("codex-plugin-data-");
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  return pluginDataDir;
}

// Run `body` with an explicit --state-dir override in place, with
// CLAUDE_PLUGIN_DATA out of the way so the override is what is under test.
export function withStateDir(stateModule, body) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  const stateDir = makeTempDir("codex-plugin-state-");
  stateModule.setStateDirOverride(stateDir);

  try {
    return body(stateDir);
  } finally {
    stateModule.setStateDirOverride(null);
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}
