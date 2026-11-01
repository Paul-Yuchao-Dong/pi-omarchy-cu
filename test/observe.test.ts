import assert from "node:assert/strict";
import { test } from "node:test";
import { createCuTools } from "../src/extension.js";
import type { AdEnvelope, CuContentBlock, CuToolResult } from "../src/types.js";
import { errEnvelope, FakeCliRunner, makeContext, makeDeps, okEnvelope } from "./fakes.js";

const homeWindow = {
  app: "nautilus",
  window: { id: "w1", title: "Home" },
  snapshot_id: "s1",
  ref_count: 2,
  complete: true,
  truncated: false,
  nodes_observed: 3,
  surfaces: [],
  tree: {
    role: "window",
    name: "Home",
    children: [
      { role: "button", name: "Save", ref_id: "@s1:e1", available_actions: ["Click"] },
      { role: "button", name: "List View", ref_id: "@s1:e2", available_actions: ["Click"] },
    ],
  },
};

function snapshotEnvelope(overrides: Record<string, unknown> = {}): AdEnvelope {
  return okEnvelope("snapshot", { ...homeWindow, ...overrides });
}

/** A runner that answers each successive call from a script, then repeats the last answer. */
function cliWith(...envelopes: AdEnvelope[]): FakeCliRunner {
  const script = [...envelopes];
  return new FakeCliRunner(() => script.length > 1 ? script.shift()! : script[0]);
}

function observe(cli: FakeCliRunner) {
  const tool = createCuTools(makeDeps({ cli })).find((candidate) => candidate.name === "cu_observe");
  assert.ok(tool, "cu_observe must be registered");
  return (params: Record<string, unknown>): Promise<CuToolResult> =>
    tool.execute("call-1", params, undefined, undefined, makeContext());
}

function payloadOf(result: CuToolResult): any {
  const block = result.content[0] as CuContentBlock;
  return JSON.parse(block.text);
}

function detailsOf(result: CuToolResult): any {
  return result.details;
}

test("observe snapshot defaults to an interactive compact skeleton read", async () => {
  const cli = new FakeCliRunner(() => snapshotEnvelope());
  const result = await observe(cli)({});

  assert.deepEqual(cli.argLists("snapshot"), [["snapshot", "-i", "--compact", "--include-bounds", "--skeleton"]]);

  const payload = payloadOf(result);
  assert.equal(payload.action, "snapshot");
  assert.equal(payload.snapshot_id, "s1");
  assert.equal(payload.ref_count, 2);
  assert.equal(payload.complete, true);
  assert.equal(payload.surface, null);
  assert.equal(payload.tree.role, "window");
  assert.deepEqual(payload.notes, []);
  assert.equal(detailsOf(result).snapshotId, "s1");
  assert.equal(detailsOf(result).refCount, 2);
});

test("observe snapshot honours explicit flag overrides", async () => {
  const cli = new FakeCliRunner(() => snapshotEnvelope());
  await observe(cli)({ interactiveOnly: false, compact: false, skeleton: false, includeBounds: true });

  assert.deepEqual(cli.argLists("snapshot"), [["snapshot", "--include-bounds"]]);
});

test("observe snapshot reads a Region root without forcing skeleton flags", async () => {
  const cli = new FakeCliRunner(() => snapshotEnvelope());
  const result = await observe(cli)({ root: "@s1:e2" });

  assert.deepEqual(cli.argLists("snapshot"), [["snapshot", "-i", "--compact", "--root", "@s1:e2"]]);
  assert.equal(detailsOf(result).root, "@s1:e2");
  assert.equal(result.isError, undefined);
});

test("observe snapshot honours maxDepth and forwards the timeout", async () => {
  const cli = new FakeCliRunner(() => snapshotEnvelope());
  await observe(cli)({ maxDepth: 6, timeoutMs: 2000 });

  assert.deepEqual(cli.argLists("snapshot"), [
    ["snapshot", "-i", "--compact", "--max-depth", "6", "--timeout-ms", "2000"],
  ]);
});

test("observe switches to an alert Overlay Surface instead of the Window behind it", async () => {
  const cli = cliWith(
    snapshotEnvelope({ surfaces: [{ kind: "menu" }, { kind: "alert" }] }),
    snapshotEnvelope({
      snapshot_id: "s2",
      surfaces: ["alert"],
      ref_count: 1,
      tree: { role: "alert", name: "Delete file?", children: [{ role: "button", name: "Delete", ref_id: "@s2:e1" }] },
    }),
  );
  const result = await observe(cli)({ windowId: "w1" });

  assert.deepEqual(cli.argLists("snapshot"), [
    ["snapshot", "--window-id", "w1", "-i", "--compact", "--include-bounds", "--skeleton"],
    ["snapshot", "--window-id", "w1", "-i", "--surface", "alert"],
  ]);

  const payload = payloadOf(result);
  assert.equal(payload.surface, "alert");
  assert.equal(payload.snapshot_id, "s2");
  assert.equal(payload.tree.role, "alert");
  assert.equal(detailsOf(result).surface, "alert");
  assert.equal(detailsOf(result).autoSurface, true);
  assert.ok((payload.notes as string[]).some((note) => /Overlay Surface/.test(note)));
});

test("observe passes an explicit surface without probing the Window first", async () => {
  const cli = new FakeCliRunner(() => snapshotEnvelope({ surfaces: ["menu"] }));
  const result = await observe(cli)({ surface: "menu" });

  assert.deepEqual(cli.argLists("snapshot"), [
    ["snapshot", "-i", "--compact", "--include-bounds", "--skeleton", "--surface", "menu"],
  ]);
  assert.equal(payloadOf(result).surface, "menu");
  assert.equal(detailsOf(result).autoSurface, false);
});

test("observe verifies a pinned Region belongs to the pinned Window before reading it", async () => {
  const cli = cliWith(snapshotEnvelope(), snapshotEnvelope());
  const result = await observe(cli)({ windowId: "w1", root: "@s1:e2" });

  assert.deepEqual(cli.argLists("snapshot"), [
    ["snapshot", "--window-id", "w1", "-i", "--compact"],
    ["snapshot", "--window-id", "w1", "-i", "--compact", "--root", "@s1:e2"],
  ]);
  assert.equal(result.isError, undefined);
  assert.equal(detailsOf(result).root, "@s1:e2");
});

test("observe rejects a Region Ref that is not in the pinned Window", async () => {
  const cli = new FakeCliRunner(() => snapshotEnvelope());
  const result = await observe(cli)({ windowId: "w1", root: "@s9:e7" });

  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).code, "root_outside_window");
  assert.deepEqual(cli.argLists("snapshot"), [["snapshot", "--window-id", "w1", "-i", "--compact"]]);
  assert.equal(detailsOf(result).windowId, "w1");
});

test("observe rejects an Overlay Surface owned by another Window", async () => {
  const auto = cliWith(
    snapshotEnvelope({ surfaces: ["alert"] }),
    snapshotEnvelope({ window: { id: "w2", title: "Other" }, surfaces: ["alert"], snapshot_id: "s2" }),
  );
  const autoResult = await observe(auto)({ windowId: "w1" });
  assert.equal(autoResult.isError, true);
  assert.equal(payloadOf(autoResult).code, "surface_outside_window");
  assert.deepEqual(auto.argLists("snapshot")[1], ["snapshot", "--window-id", "w1", "-i", "--surface", "alert"]);

  const explicit = new FakeCliRunner(() => snapshotEnvelope({ window: { id: "w2" }, surfaces: ["sheet"] }));
  const explicitResult = await observe(explicit)({ windowId: "w1", surface: "sheet" });
  assert.equal(explicitResult.isError, true);
  assert.equal(payloadOf(explicitResult).code, "surface_outside_window");
});

test("observe rejects a root and surface combination agent-desktop cannot honour", async () => {
  const cli = new FakeCliRunner(() => snapshotEnvelope());
  const result = await observe(cli)({ root: "@s1:e1", surface: "menu" });

  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).code, "INVALID_ARGUMENT");
  assert.equal(cli.calls.length, 0);
});

test("observe find forwards filters, repeated states, exact, and limit", async () => {
  const cli = new FakeCliRunner(() =>
    okEnvelope("find", {
      snapshot_id: "s1",
      matches: [{ ref_id: "@s1:e1", role: "button", name: "Save" }],
    }),
  );
  const result = await observe(cli)({
    action: "find",
    app: "nautilus",
    windowId: "w1",
    role: "button",
    name: "Save",
    text: "Sav",
    value: "yes",
    state: ["enabled", "checked=false"],
    exact: true,
    limit: 5,
    timeoutMs: 4000,
  });

  assert.deepEqual(cli.argLists("find"), [
    [
      "find",
      "--app",
      "nautilus",
      "--window-id",
      "w1",
      "--role",
      "button",
      "--name",
      "Save",
      "--text",
      "Sav",
      "--value",
      "yes",
      "--state",
      "enabled",
      "--state",
      "checked=false",
      "--exact",
      "--limit",
      "5",
      "--timeout-ms",
      "4000",
    ],
  ]);

  const payload = payloadOf(result);
  assert.equal(payload.snapshot_id, "s1");
  assert.equal(payload.count, 1);
  assert.equal(payload.matches[0].ref_id, "@s1:e1");
  assert.deepEqual(payload.notes, []);
});

test("observe find accepts one state token and notes a full limit", async () => {
  const cli = new FakeCliRunner(() =>
    okEnvelope("find", {
      snapshot_id: "s1",
      matches: [
        { ref_id: "@s1:e1", role: "button", name: "Save" },
        { ref_id: "@s1:e2", role: "button", name: "Save as" },
      ],
    }),
  );
  const result = await observe(cli)({ action: "find", state: "enabled", limit: 2 });

  assert.deepEqual(cli.argLists("find"), [["find", "--state", "enabled", "--limit", "2"]]);
  assert.ok((payloadOf(result).notes as string[]).some((note) => /limit/.test(note)));
});

test("observe get and is require a Ref and forward the property", async () => {
  const cli = new FakeCliRunner((args) =>
    args[0] === "get"
      ? okEnvelope("get", { ref: "@s1:e1", property: "text", value: "Save" })
      : okEnvelope("is", { ref: "@s1:e1", property: "checked", result: false, applicable: true }),
  );
  const run = observe(cli);

  const missingGet = await run({ action: "get" });
  assert.equal(missingGet.isError, true);
  assert.equal(payloadOf(missingGet).code, "INVALID_ARGUMENT");

  const missingIs = await run({ action: "is" });
  assert.equal(missingIs.isError, true);
  assert.equal(payloadOf(missingIs).code, "INVALID_ARGUMENT");

  const got = await run({ action: "get", ref: "@s1:e1", property: "text" });
  assert.deepEqual(cli.argLists("get"), [["get", "@s1:e1", "--property", "text"]]);
  assert.deepEqual(payloadOf(got), {
    ok: true,
    action: "get",
    ref: "@s1:e1",
    property: "text",
    value: "Save",
    notes: [],
  });

  const state = await run({ action: "is", ref: "@s1:e1", property: "checked" });
  assert.deepEqual(cli.argLists("is"), [["is", "@s1:e1", "--property", "checked"]]);
  assert.equal(payloadOf(state).result, false);
  assert.equal(payloadOf(state).applicable, true);
});

test("observe list-surfaces forwards the application and returns surfaces", async () => {
  const cli = new FakeCliRunner(() =>
    okEnvelope("list-surfaces", {
      surfaces: [
        { kind: "window", title: "Home" },
        { kind: "menu", title: "File" },
      ],
      windows: [{ id: "w1", title: "Home", unclassified: ["sheet"] }],
    }),
  );
  const result = await observe(cli)({ action: "list-surfaces", app: "nautilus" });

  assert.deepEqual(cli.argLists("list-surfaces"), [["list-surfaces", "--app", "nautilus"]]);
  const payload = payloadOf(result);
  assert.deepEqual((payload.surfaces as any[]).map((surface) => surface.kind), ["window", "menu"]);
  assert.equal(payload.windows[0].id, "w1");
});

test("observe surfaces agent-desktop errors with their code intact", async () => {
  const cli = new FakeCliRunner(() =>
    errEnvelope("snapshot", "PLATFORM_NOT_SUPPORTED", "No display server is configured in this session"),
  );
  const result = await observe(cli)({});

  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.equal(payload.code, "PLATFORM_NOT_SUPPORTED");
  assert.match(String(payload.message), /No display server is configured in this session/);
  assert.equal(detailsOf(result).command, "snapshot");
});

test("observe reports incomplete snapshots and truncated Regions", async () => {
  const cli = new FakeCliRunner(() =>
    okEnvelope("snapshot", {
      ...homeWindow,
      complete: false,
      truncated: true,
      tree: {
        role: "window",
        name: "Home",
        children: [
          {
            role: "group",
            name: "Files",
            ref_id: "@s1:e4",
            children_count: 12,
            children: [{ role: "button", name: "a", ref_id: "@s1:e5" }],
          },
        ],
      },
    }),
  );
  const result = await observe(cli)({});

  const payload = payloadOf(result);
  assert.equal(payload.complete, false);
  const notes = payload.notes as string[];
  assert.ok(notes.some((note) => /incomplete/.test(note)));
  assert.ok(notes.some((note) => /Region/.test(note) && /@s1:e4/.test(note)));
});

test("observe caps a wide snapshot for the model context", async () => {
  const cli = new FakeCliRunner(() =>
    okEnvelope("snapshot", {
      ...homeWindow,
      ref_count: 600,
      tree: {
        role: "window",
        name: "Home",
        children: Array.from({ length: 600 }, (_, index) => ({
          role: "button",
          name: `button ${index} ${"x".repeat(20)}`,
          ref_id: `@s1:e${index}`,
          available_actions: ["Click"],
        })),
      },
    }),
  );
  const result = await observe(cli)({});

  const text = (result.content[0] as CuContentBlock).text;
  assert.ok(text.length <= 12_200, `expected a capped payload, got ${text.length} chars`);
  assert.match(text, /truncated at 12000 chars/);
});

test("observe forwards the AbortSignal to agent-desktop", async () => {
  const cli = new FakeCliRunner(() => snapshotEnvelope());
  const controller = new AbortController();
  const tool = createCuTools(makeDeps({ cli })).find((candidate) => candidate.name === "cu_observe");
  assert.ok(tool, "cu_observe must be registered");

  await tool.execute("call-1", { action: "find", role: "button" }, controller.signal, undefined, makeContext());

  assert.equal(cli.calls[0].options?.signal, controller.signal);
});
