/**
 * Live subprocess smoke test for the production `AgentDesktopCliRunner`.
 *
 * These tests talk to the installed `agent-desktop` binary, so they skip
 * cleanly when it is missing. They cover the three runner guarantees the tool
 * seam cannot: `0700` enforcement on the real state root, parsing a real
 * `status` envelope, and cancelling a real invocation through `AbortSignal`.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { AgentDesktopCliRunner } from "../src/agent-desktop/runner.js";

function tempRoot(t: TestContext): string {
  const root = mkdtempSync(path.join(tmpdir(), "cu-live-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function liveRunner(root: string): AgentDesktopCliRunner {
  return new AgentDesktopCliRunner({
    env: { PATH: process.env.PATH, AGENT_DESKTOP_HOME: path.join(root, "state") },
    homedir: root,
  });
}

test("live runner parses the status envelope and enforces a 0700 state root", async (t) => {
  const root = tempRoot(t);
  const stateRoot = path.join(root, "state");
  mkdirSync(stateRoot, { recursive: true });
  chmodSync(stateRoot, 0o755);

  const runner = liveRunner(root);
  if (!runner.resolve()) {
    t.skip("agent-desktop is not installed; live smoke test skipped");
    return;
  }

  const info = await runner.ensureStateRoot();
  assert.equal(info.mode, 0o700);
  assert.equal(statSync(stateRoot).mode & 0o777, 0o700);

  const result = await runner.run(["status"]);
  assert.equal(result.aborted, false);
  assert.equal(result.exitCode, 0, JSON.stringify(result.envelope));
  assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope));
  assert.equal(result.envelope.command, "status");
  assert.ok(result.binary.length > 0);

  const data = (result.envelope.data ?? {}) as {
    version?: unknown;
    platform?: unknown;
    supported_surfaces?: unknown;
  };
  assert.equal(typeof data.version, "string");
  assert.equal(data.platform, "linux");
  assert.ok(Array.isArray(data.supported_surfaces));
  assert.equal(statSync(stateRoot).mode & 0o777, 0o700, "the state root stays private after the call");
});

test("live runner cancels an in-flight invocation when its AbortSignal fires", async (t) => {
  const root = tempRoot(t);
  const runner = liveRunner(root);
  if (!runner.resolve()) {
    t.skip("agent-desktop is not installed; live smoke test skipped");
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  timer.unref();
  const started = Date.now();
  const result = await runner.run(["wait", "5000"], {
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  const elapsed = Date.now() - started;
  clearTimeout(timer);

  assert.equal(result.aborted, true);
  assert.equal(result.envelope.error?.code, "ABORTED");
  assert.ok(elapsed < 4_000, `abort took ${elapsed}ms; the 5000ms wait was not cancelled`);
  assert.equal(statSync(path.join(root, "state")).mode & 0o777, 0o700);
});
