import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AgentDesktopCliRunner, parseEnvelope } from "../src/agent-desktop/runner.js";
import { createCuTools } from "../src/extension.js";
import { resolveJevConfig, validateEndpoint } from "../src/jev/config.js";
import {
  ACT_OPERATIONS,
  cliCommandFor,
  reconcileOperation,
  requiredAction,
  SET_VALUE_ABSTAIN_REASON,
} from "../src/policy/operations.js";
import { decideRoute, validateChoice } from "../src/policy/route.js";
import {
  collectCandidates,
  detectOverlay,
  screenFingerprint,
  walkNodes,
} from "../src/desktop/tree.js";
import { TextQueue } from "../src/text/queue.js";
import {
  FakeCliRunner,
  FakeDecisionClient,
  makeDeps,
  sdkClientWithTransport,
} from "./fakes.js";

test("jev configuration mirrors pi-jev resolution order", () => {
  const config = resolveJevConfig({
    env: { TYPESAFE_API_KEY: "ts-key", PI_JEV_MODEL: "jev-latest" },
    homedir: "/home/fake",
    readFile: () => null,
  });
  assert.equal(config.apiKey, "ts-key");
  assert.equal(config.keyOrigin, "$TYPESAFE_API_KEY");
  assert.equal(config.baseURL, "https://api.typesafe.ai/v1/systemone");
  assert.equal(config.model, "jev-latest");
  assert.equal(config.configured, true);

  const openrouter = resolveJevConfig({
    env: { OPENROUTER_API_KEY: "sk-or-x", TYPESAFE_MODEL: "jev-max" },
    homedir: "/home/fake",
    readFile: () => null,
  });
  assert.equal(openrouter.baseURL, "https://openrouter.ai/api");
  assert.equal(openrouter.openrouter, true);
  assert.equal(openrouter.model, "~typesafe/jev-max");

  const secretFile = resolveJevConfig({
    env: {},
    homedir: "/home/fake",
    readFile: (file) =>
      file.endsWith(path.join("secrets", "openrouter_api_key")) ? "sk-or-file" : null,
  });
  assert.equal(secretFile.keyOrigin, "~/.pi/agent/secrets/openrouter_api_key");
  assert.equal(secretFile.baseURL, "https://openrouter.ai/api");
  assert.equal(secretFile.model, "~typesafe/jev-latest");
});

test("jev endpoint validation allows https and loopback http only", () => {
  assert.equal(validateEndpoint("https://api.typesafe.ai/v1/systemone").ok, true);
  assert.equal(validateEndpoint("http://127.0.0.1:8080/v1").ok, true);
  assert.equal(validateEndpoint("http://localhost:8080/v1").ok, true);
  assert.equal(validateEndpoint("http://[::1]:8080/v1").ok, true);
  assert.equal(validateEndpoint("http://jev.example.com/v1").ok, false);
  assert.equal(validateEndpoint("https://user:pass@jev.example.com/v1").ok, false);
  assert.equal(validateEndpoint("ftp://jev.example.com").ok, false);
});

test("sdk decision client retries 429 and 503 twice with backoff", async () => {
  const slept: number[] = [];
  let calls = 0;
  const client = sdkClientWithTransport(
    async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      if (calls === 2) throw Object.assign(new Error("unavailable"), { status: 503 });
      return { answers: { present: { noul: 0.9 } }, model: "jev-latest" };
    },
    { sleep: async (ms) => void slept.push(ms) },
  );

  const response = await client.evaluate({
    state: "x",
    questions: { present: { type: "noul", instructions: "is it present" } },
  });
  assert.equal(calls, 3);
  assert.deepEqual(slept, [500, 1000]);
  assert.equal(response.answers.present.value, 0.9);
});

test("sdk decision client does not retry 400 and honours an aborted signal", async () => {
  let calls = 0;
  const client = sdkClientWithTransport(async () => {
    calls += 1;
    throw Object.assign(new Error("bad request"), { status: 400 });
  });
  await assert.rejects(
    client.evaluate({ state: "x", questions: { target: { type: "noul", instructions: "x" } } }),
    /bad request/,
  );
  assert.equal(calls, 1);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.evaluate({ state: "x", questions: { target: { type: "noul", instructions: "x" } } }, controller.signal),
    /aborted/i,
  );
});

test("route decision enforces the confidence floor, bars, and destructive gate", () => {
  assert.equal(decideRoute({ confidence: 0.9, present: 0.95, destructive: 0.1 }).decision, "act");
  assert.equal(decideRoute({ confidence: 0.6, present: 0.95, destructive: 0.1 }).decision, "confirm");
  assert.equal(decideRoute({ confidence: 0.4, present: 0.95, destructive: 0.1 }).decision, "abstain");
  assert.equal(decideRoute({ confidence: 0.9, present: 0.1, destructive: 0.1 }).decision, "abstain");
  assert.equal(decideRoute({ confidence: 0.85, present: 0.95, destructive: 0.95 }).decision, "confirm");
  assert.equal(decideRoute({ confidence: 0.95, present: 0.95, destructive: 0.95 }).decision, "act");
  assert.equal(decideRoute({ confidence: 0.9, present: 0.95, destructive: 0.1, needsText: true }).decision, "needs_text");
  assert.equal(decideRoute({ confidence: 0.9, present: 0.95, destructive: null, none: true }).decision, "abstain");
});

test("choice validation rejects out-of-set options and bad distributions", () => {
  const offered = ["a", "b"];
  const good = validateChoice({ type: "choice", value: "a", confidence: 0.8, distribution: { a: 0.8, b: 0.2 } }, offered);
  assert.equal(good.ok, true);
  const outOfSet = validateChoice({ type: "choice", value: "c", confidence: 0.8 }, offered);
  assert.equal(outOfSet.ok, false);
  const badSum = validateChoice({ type: "choice", value: "a", confidence: 0.8, distribution: { a: 0.5, b: 0.2 } }, offered);
  assert.equal(badSum.ok, false);
  const badConfidence = validateChoice({ type: "choice", value: "a", confidence: 1.5 }, offered);
  assert.equal(badConfidence.ok, false);
});

test("operation reconciliation corrects unsupported verbs and abstains on text", () => {
  assert.equal(requiredAction("click"), "Click");
  assert.equal(requiredAction("set-value"), "SetValue");
  assert.equal(requiredAction("scroll-to"), "Scroll");
  assert.equal(cliCommandFor("TYPE_TEXT"), "set-value");
  assert.equal(cliCommandFor("RIGHT_CLICK"), "right-click");
  assert.equal(cliCommandFor("SCROLL_TO"), "scroll-to");

  const readonlyCombo = reconcileOperation({
    desired: "set-value",
    advertised: ["Click", "Expand"],
  });
  assert.equal(readonlyCombo.operation, "click");
  assert.equal(readonlyCombo.reconciled, true);

  const noSetValue = reconcileOperation({
    desired: "set-value",
    advertised: ["Click"],
    textIntent: true,
  });
  assert.equal(noSetValue.abstain, true);
  assert.equal(noSetValue.why, SET_VALUE_ABSTAIN_REASON);

  const supported = reconcileOperation({ desired: "toggle", advertised: ["Toggle", "Click"] });
  assert.equal(supported.operation, "toggle");
  assert.equal(supported.reconciled, false);
  assert.deepEqual([...ACT_OPERATIONS].length, 11);
});

const tree = {
  role: "window",
  name: "Preferences",
  children: [
    {
      role: "button",
      name: "List View",
      ref_id: "@s1:e1",
      available_actions: ["Click"],
    },
    {
      role: "button",
      name: "Disabled",
      ref_id: "@s1:e2",
      states: ["disabled"],
      available_actions: ["Click"],
    },
    {
      role: "group",
      name: "hidden group",
      children: [{ role: "button", name: "Hidden", ref_id: "@s1:e3", states: ["hidden"], available_actions: ["Click"] }],
    },
    {
      role: "static",
      name: "no actions",
      ref_id: "@s1:e4",
      available_actions: [],
    },
    {
      role: "treeitem",
      name: "row",
      ref_id: "@s1:e5",
      available_actions: ["Click"],
      children: [
        { role: "cell", name: "cell", ref_id: "@s1:e6", available_actions: ["Click"] },
      ],
    },
    { role: "button", name: "Save", ref_id: "@s1:e7", available_actions: ["Click"] },
  ],
};

test("candidate collection withholds disabled, hidden, action-less, and nested cells", () => {
  const collection = collectCandidates(tree);
  assert.deepEqual(
    collection.candidates.map((candidate) => candidate.node.ref_id),
    ["@s1:e1", "@s1:e5", "@s1:e7"],
  );
  assert.equal(collection.truncated, 0);
  assert.equal(walkNodes(tree).length, 9);
});

test("candidate collection caps at 254 and records a truncation note", () => {
  const wide = {
    role: "window",
    children: Array.from({ length: 300 }, (_, index) => ({
      role: "button",
      name: `button ${index}`,
      ref_id: `@s1:e${index}`,
      available_actions: ["Click"],
    })),
  };
  const collection = collectCandidates(wide);
  assert.equal(collection.candidates.length, 254);
  assert.equal(collection.truncated, 46);
  assert.match(String(collection.note), /254/);
});

test("overlay detection prefers alert over sheet, menu, and popover", () => {
  assert.equal(detectOverlay({ surfaces: ["menu", "sheet"] })?.kind, "sheet");
  assert.equal(detectOverlay({ surfaces: [{ kind: "popover" }, { kind: "alert" }] })?.kind, "alert");
  assert.equal(detectOverlay({ surfaces: [{ role: "menu" }] })?.kind, "menu");
  assert.equal(detectOverlay({ tree: { role: "window" } }), null);
});

test("screen fingerprints change only when the visible screen changes", () => {
  const a = screenFingerprint({ tree });
  assert.equal(screenFingerprint({ tree: JSON.parse(JSON.stringify(tree)) }), a);
  const changed = JSON.parse(JSON.stringify(tree));
  changed.children[0].name = "Grid View";
  assert.notEqual(screenFingerprint({ tree: changed }), a);
});

test("text queue consumes in order and redacts only TYPE_TEXT values", () => {
  const queue = new TextQueue(["secret value", "Option B"]);
  const typed = queue.take({ sensitive: true });
  const selected = queue.take();
  assert.equal(typed, "secret value");
  assert.equal(selected, "Option B");
  assert.deepEqual([...queue.secrets], ["secret value"]);
  assert.equal(queue.redact('set-value "secret value"'), 'set-value "[redacted]"');
  assert.equal(queue.redact('selected "Option B"'), 'selected "Option B"');
  assert.equal(new TextQueue([]).empty, true);
});

test("runner parses an envelope from stdout or stderr and rejects junk", () => {
  assert.deepEqual(parseEnvelope('{"ok":true,"command":"status","data":{}}'), {
    ok: true,
    command: "status",
    data: {},
  });
  assert.equal(parseEnvelope("not json at all"), null);
});

test("real runner resolves the probe binary and enforces a 0700 state root", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cu-root-"));
  const runner = new AgentDesktopCliRunner({
    env: { ...process.env, AGENT_DESKTOP_HOME: path.join(root, "state"), PATH: "/nonexistent" },
    homedir: root,
    probePath: "/tmp/ad-probe/node_modules/.bin/agent-desktop",
  });
  const resolution = runner.resolve();
  assert.ok(resolution, "expected agent-desktop to resolve from the probe path");
  const info = await runner.ensureStateRoot();
  assert.equal(info.mode, 0o700);
  assert.equal(statSync(info.path).mode & 0o777, 0o700);
});

test("extension exposes the five cu tools with model-facing metadata", () => {
  const deps = makeDeps({ cli: new FakeCliRunner(), decision: new FakeDecisionClient() });
  const tools = createCuTools(deps);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["cu_status", "cu_observe", "cu_ref", "cu_act", "cu_run"],
  );
  for (const tool of tools) {
    assert.ok(tool.description.length > 100, `${tool.name} needs a self-sufficient description`);
    assert.ok(tool.promptSnippet.length > 0);
    assert.ok(tool.promptGuidelines.length > 0);
    assert.ok(tool.parameters);
  }
});

test("sdk decision client exposes choice probabilities as the answer distribution", async () => {
  const client = sdkClientWithTransport(async () => ({
    answers: {
      target: { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } },
    },
    model: "jev-latest",
  }));
  const response = await client.evaluate({
    state: "x",
    questions: { target: { type: "choice", instructions: "pick", criteria: { a: null, b: null } } },
  });
  assert.equal(response.answers.target.value, "a");
  assert.deepEqual(response.answers.target.distribution, { a: 0.8, b: 0.2 });
});
