import test from "node:test";
import assert from "node:assert/strict";

import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree falls back to a single-process kill when the group kill gets ESRCH", () => {
  const calls = [];
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl(pid, signal) {
      calls.push({ pid, signal });
      if (pid === -1234) {
        const error = new Error("kill ESRCH");
        /** @type {NodeJS.ErrnoException} */ (error).code = "ESRCH";
        throw error;
      }
    }
  });

  assert.deepEqual(calls, [
    { pid: -1234, signal: "SIGTERM" },
    { pid: 1234, signal: "SIGTERM" }
  ]);
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "process");
});

test("terminateProcessTree reports undelivered when both kills get ESRCH", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "linux",
    killImpl() {
      const error = new Error("kill ESRCH");
      /** @type {NodeJS.ErrnoException} */ (error).code = "ESRCH";
      throw error;
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "process");
});
