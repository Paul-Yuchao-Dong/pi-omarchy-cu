import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AgentDesktopCliRunner } from "../src/agent-desktop/runner.js";
import {
  findWaylandDisplay,
  findX11Display,
  withDisplayFallback,
  X11_SOCKET_DIR,
} from "../src/system/display.js";

function runtimeWithSockets(sockets: Array<{ name: string; mtime: number }>): {
  dir: string;
  entries: string[];
  mtimes: Record<string, number>;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "cu-runtime-"));
  const mtimes: Record<string, number> = {};
  for (const socket of sockets) {
    const file = path.join(dir, socket.name);
    writeFileSync(file, "");
    mtimes[file] = socket.mtime;
  }
  return { dir, entries: sockets.map((socket) => socket.name), mtimes };
}

test("display fallback derives the newest Wayland socket and the lowest X11 display", () => {
  const wayland = runtimeWithSockets([
    { name: "wayland-1", mtime: 100 },
    { name: "wayland-2", mtime: 200 },
    { name: "wayland-1.lock", mtime: 300 },
  ]);
  const result = withDisplayFallback(
    { XDG_RUNTIME_DIR: wayland.dir },
    {
      readdir: (dir) => (dir === X11_SOCKET_DIR ? ["X1", "X0"] : wayland.entries),
      mtimeMs: (file) => wayland.mtimes[file] ?? 0,
      exists: () => true,
    },
  );

  assert.equal(result.env.WAYLAND_DISPLAY, "wayland-2");
  assert.equal(result.env.DISPLAY, ":0");
  assert.deepEqual(result.derived, { waylandDisplay: "wayland-2", display: ":0" });
});

test("explicit display variables always win over the fallback", () => {
  const result = withDisplayFallback(
    { XDG_RUNTIME_DIR: "/run/user/1000", WAYLAND_DISPLAY: "wayland-9", DISPLAY: ":7" },
    {
      readdir: () => ["wayland-1", "X0"],
      exists: () => true,
      mtimeMs: () => 1,
    },
  );

  assert.equal(result.env.WAYLAND_DISPLAY, "wayland-9");
  assert.equal(result.env.DISPLAY, ":7");
  assert.deepEqual(result.derived, {});
});

test("display fallback leaves the environment alone when no sockets exist", () => {
  const result = withDisplayFallback(
    { XDG_RUNTIME_DIR: "/run/user/1000" },
    { readdir: () => [], exists: () => false },
  );

  assert.equal(result.env.WAYLAND_DISPLAY, undefined);
  assert.equal(result.env.DISPLAY, undefined);
  assert.deepEqual(result.derived, {});
  assert.equal(findWaylandDisplay({}, { readdir: () => [] }), null);
  assert.equal(findX11Display({ readdir: () => [] }), null);
});

test("agent-desktop children receive the derived display environment", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cu-display-runner-"));
  const runtime = path.join(root, "runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(runtime, "wayland-1"), "");

  const binary = path.join(root, "agent-desktop");
  writeFileSync(
    binary,
    '#!/bin/sh\nprintf \'{"ok":true,"command":"status","data":{"wayland":"%s","display":"%s"}}\' "$WAYLAND_DISPLAY" "$DISPLAY"\n',
    { mode: 0o755 },
  );

  const runner = new AgentDesktopCliRunner({
    env: {
      AGENT_DESKTOP_BIN: binary,
      AGENT_DESKTOP_HOME: path.join(root, "state"),
      XDG_RUNTIME_DIR: runtime,
      PATH: "/nonexistent",
    },
    homedir: root,
    pathLookup: () => null,
  });

  const result = await runner.run(["status"]);
  assert.equal(result.envelope.ok, true);
  assert.equal((result.envelope.data as Record<string, unknown>).wayland, "wayland-1");
});
