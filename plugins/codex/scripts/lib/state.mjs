import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
const INSTALLED_PLUGINS_FILE = "installed_plugins.json";
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

// Resolve this plugin's own data dir instead of falling back to os.tmpdir(),
// which split state between the Stop hook and the commands depending on who saw
// CLAUDE_PLUGIN_DATA. Fails loudly rather than writing where the hooks will
// never read.
let stateDirOverride = null;
let ownDataDirCache;

export function setStateDirOverride(dir) {
  stateDirOverride = dir ? path.resolve(dir) : null;
  ownDataDirCache = undefined;
}

export function getStateDirOverride() {
  return stateDirOverride;
}

function resolveConfigDir() {
  const configured = process.env[CONFIG_DIR_ENV];
  if (configured && configured.trim()) {
    return path.resolve(configured.trim());
  }
  return path.join(os.homedir(), ".claude");
}

// Derive this plugin's data dir the same way Claude Code does, without
// hardcoding a plugin name (forks rename it): find the installed_plugins.json
// entry whose installPath contains this very file, then map its
// "<plugin>@<marketplace>" key to the "<plugin>-<marketplace>" data dir.
function resolveOwnDataDir() {
  if (ownDataDirCache !== undefined) {
    return ownDataDirCache;
  }

  ownDataDirCache = null;
  const configDir = resolveConfigDir();
  const registryFile = path.join(configDir, "plugins", INSTALLED_PLUGINS_FILE);

  try {
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    const plugins = registry?.plugins;
    if (!plugins || typeof plugins !== "object") {
      return ownDataDirCache;
    }

    let selfPath = fileURLToPath(import.meta.url);
    try {
      selfPath = fs.realpathSync.native(selfPath);
    } catch {
      // keep the non-canonical path
    }

    for (const [key, entries] of Object.entries(plugins)) {
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        const installPath = entry?.installPath;
        if (typeof installPath !== "string" || !installPath) {
          continue;
        }

        let canonicalInstallPath = installPath;
        try {
          canonicalInstallPath = fs.realpathSync.native(installPath);
        } catch {
          canonicalInstallPath = installPath;
        }

        if (selfPath.startsWith(canonicalInstallPath + path.sep)) {
          ownDataDirCache = path.join(configDir, "plugins", "data", key.replace("@", "-"));
          return ownDataDirCache;
        }
      }
    }
  } catch {
    // unreadable or malformed registry -- fall through to the loud failure
  }

  return ownDataDirCache;
}

function resolveStateRoot() {
  if (stateDirOverride) {
    return stateDirOverride;
  }

  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  if (pluginDataDir && pluginDataDir.trim()) {
    return path.join(pluginDataDir.trim(), "state");
  }

  const ownDataDir = resolveOwnDataDir();
  if (ownDataDir) {
    return path.join(ownDataDir, "state");
  }

  throw new Error(
    `Unable to resolve the Codex plugin state directory: ${PLUGIN_DATA_ENV} is unset and this plugin ` +
      `could not find its own entry in ${path.join(resolveConfigDir(), "plugins", INSTALLED_PLUGINS_FILE)}. ` +
      `Pass --state-dir <path> or set ${PLUGIN_DATA_ENV} explicitly. ` +
      `(Refusing to fall back to a temp directory, which would hide job and review-gate state from the hooks.)`
  );
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      // `bedrockOnly` is deliberately absent: an unset key means "not opted in",
      // which keeps the policy out of every workspace's state.json until someone
      // actually toggles it.
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return path.join(resolveStateRoot(), `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
