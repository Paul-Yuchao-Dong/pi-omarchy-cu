import assert from "node:assert/strict";
import { test } from "node:test";
import { createCuTools } from "../src/extension.js";
import { ACT_OPERATIONS, SET_VALUE_ABSTAIN_REASON } from "../src/policy/operations.js";
import type { AdNode, DecisionResponse } from "../src/types.js";
import {
  choiceAnswer,
  decision,
  FakeCliRunner,
  FakeDecisionClient,
  makeContext,
  makeDeps,
  noulAnswer,
  okEnvelope,
} from "./fakes.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const notesTree: AdNode = {
  role: "window",
  name: "Notes",
  children: [
    { role: "button", name: "List View", ref_id: "@s1:e1", available_actions: ["Click"] },
    { role: "switch", name: "Dark Mode", ref_id: "@s1:e2", available_actions: ["Toggle"] },
    { role: "button", name: "Disabled", ref_id: "@s1:e3", states: ["disabled"], available_actions: ["Click"] },
  ],
};

function snapshotEnvelope(tree: AdNode, extra: Record<string, unknown> = {}) {
  return okEnvelope("snapshot", {
    app: "Notes",
    window: { id: "w1", title: "Notes — Preferences" },
    snapshot_id: "s1",
    ref_count: 2,
    complete: true,
    truncated: false,
    nodes_observed: 3,
    tree,
    surfaces: [],
    ...extra,
  });
}

/** A probability distribution that sums to 1 for `chosen`. */
function distribution(chosen: string, confidence: number, options: readonly string[]): Record<string, number> {
  const others = options.filter((option) => option !== chosen);
  const each = others.length > 0 ? (1 - confidence) / others.length : 0;
  const out: Record<string, number> = {};
  for (const option of options) out[option] = option === chosen ? confidence : each;
  return out;
}

interface ActDecisionOptions {
  target: string;
  targetConfidence: number;
  command: string;
  /** Target options offered by the request (refs plus `none`). */
  offered?: readonly string[];
  present?: number;
  destructive?: number;
  needsText?: number;
  targetDistribution?: Record<string, number>;
  commandConfidence?: number;
}

/** A coherent five-answer System One response. */
function actDecision(options: ActDecisionOptions): DecisionResponse {
  const offered = options.offered ?? [...notesTree.children!.map((node) => String(node.ref_id)), "none"];
  const commandConfidence = options.commandConfidence ?? 0.9;
  return decision({
    target: choiceAnswer(
      options.target,
      options.targetConfidence,
      options.targetDistribution ?? distribution(options.target, options.targetConfidence, offered),
    ),
    command: choiceAnswer(
      options.command,
      commandConfidence,
      distribution(options.command, commandConfidence, ACT_OPERATIONS),
    ),
    present: noulAnswer(options.present ?? 0.95),
    destructive: noulAnswer(options.destructive ?? 0.02),
    needs_text: noulAnswer(options.needsText ?? 0.01),
  });
}

function actTool(deps: ReturnType<typeof makeDeps>) {
  const tool = createCuTools(deps).find((candidate) => candidate.name === "cu_act");
  assert.ok(tool, "cu_act must be registered");
  return tool;
}

function mutationEnvelope(args: string[]) {
  return okEnvelope(args[0] ?? "unknown", {
    ref: args[1],
    disposition: { delivery: "delivered_verified", retry: "safe" },
    steps: [{ action: args[0], ref: args[1] }],
    post_state: { value: "post" },
  });
}

/* -------------------------------------------------------------------------- */
/* Core execution                                                              */
/* -------------------------------------------------------------------------- */

test("cu_act executes a high-confidence click with the exact mutating CLI args", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(notesTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({ target: "@s1:e1", targetConfidence: 0.93, command: "click" }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "press the List View button", app: "Notes", execute: true },
    undefined,
    undefined,
    makeContext(),
  );
  const details = result.details as any;

  assert.deepEqual(runner.argLists("snapshot"), [
    ["snapshot", "--app", "Notes", "-i", "--compact", "--include-bounds", "--skeleton"],
  ]);
  assert.deepEqual(runner.argLists("click"), [["click", "@s1:e1"]]);
  assert.equal(result.isError, undefined);
  assert.equal(details.decision, "act");
  assert.deepEqual(details.target, { ref: "@s1:e1", role: "button", name: "List View" });
  assert.equal(details.operation, "click");
  assert.equal(details.executed, true);
  assert.equal(details.reconciled_note, null);
  assert.equal(details.delivery, "delivered_verified");
  assert.deepEqual(details.post_state, { value: "post" });
  assert.deepEqual(details.steps, [{ action: "click", ref: "@s1:e1" }]);
  assert.equal(details.reranked, false);
  assert.equal(details.confidence, 0.93);
  assert.equal(decisionClient.requests.length, 1);
  assert.ok(!result.content[0].text.includes('"tree"'), "tool output must never contain the accessibility tree");
});

test("cu_act defaults to a dry run and never issues a mutating command", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(notesTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({ target: "@s1:e1", targetConfidence: 0.93, command: "click" }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "press the List View button", app: "Notes" },
    undefined,
    undefined,
    makeContext(),
  );
  const details = result.details as any;

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].args[0], "snapshot");
  assert.equal(details.decision, "act");
  assert.equal(details.executed, false);
  assert.equal(details.execute, false);
  assert.equal("delivery" in details, false);
});

test("cu_act asks one five-question System One request over the offerable candidates", async () => {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(notesTree));
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({ target: "@s1:e1", targetConfidence: 0.93, command: "click" }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  await actTool(deps).execute(
    "call-1",
    { intent: "press the List View button", app: "Notes" },
    undefined,
    undefined,
    makeContext(),
  );

  const request = decisionClient.requests[0];
  assert.deepEqual(Object.keys(request.questions), ["target", "command", "present", "destructive", "needs_text"]);
  assert.equal(request.questions.target.type, "choice");
  assert.deepEqual(Object.keys(request.questions.target.criteria as object), ["@s1:e1", "@s1:e2", "none"]);
  assert.equal(request.questions.command.type, "choice");
  assert.deepEqual(Object.keys(request.questions.command.criteria as object), [...ACT_OPERATIONS]);
  for (const id of ["present", "destructive", "needs_text"]) {
    assert.equal(request.questions[id].type, "noul");
  }
  const state = request.state as any;
  assert.equal(state.intent, "press the List View button");
  assert.deepEqual(state.candidates.map((candidate: any) => candidate.ref), ["@s1:e1", "@s1:e2"]);
  assert.equal(state.window.title, "Notes — Preferences");
});

/* -------------------------------------------------------------------------- */
/* Reranking, reconciliation, and Route Decision                               */
/* -------------------------------------------------------------------------- */

const denseTree: AdNode = {
  role: "window",
  name: "Dense",
  children: Array.from({ length: 6 }, (_, index) => ({
    role: "button",
    name: `Item ${index + 1}`,
    ref_id: `@s1:e${index + 1}`,
    available_actions: ["Click"],
    ...(index === 1 ? { children_count: 3 } : {}),
  })),
};

test("cu_act reranks the top 5 candidates with rich descriptions below 0.70 target confidence", async () => {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(denseTree));
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(
    actDecision({
      target: "@s1:e1",
      targetConfidence: 0.62,
      command: "click",
      offered: ["@s1:e1", "@s1:e2", "@s1:e3", "@s1:e4", "@s1:e5", "@s1:e6", "none"],
      targetDistribution: {
        "@s1:e1": 0.3,
        "@s1:e2": 0.25,
        "@s1:e3": 0.2,
        "@s1:e4": 0.12,
        "@s1:e5": 0.08,
        "@s1:e6": 0.05,
      },
    }),
    actDecision({
      target: "@s1:e2",
      targetConfidence: 0.88,
      command: "click",
      offered: ["@s1:e1", "@s1:e2", "@s1:e3", "@s1:e4", "@s1:e5", "none"],
    }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "press the second item", app: "Dense" },
    undefined,
    undefined,
    makeContext(),
  );
  const details = result.details as any;

  assert.equal(decisionClient.requests.length, 2);
  const rerank = decisionClient.requests[1];
  assert.deepEqual(
    (rerank.state as any).candidates.map((candidate: any) => candidate.ref),
    ["@s1:e1", "@s1:e2", "@s1:e3", "@s1:e4", "@s1:e5"],
  );
  assert.match((rerank.state as any).candidates[0].description, /actions: Click/);
  assert.match((rerank.state as any).candidates[1].description, /hidden_children: 3/);
  assert.match((rerank.state as any).candidates[0].description, /parent: window/);
  assert.deepEqual(Object.keys(rerank.questions.target.criteria as object), [
    "@s1:e1",
    "@s1:e2",
    "@s1:e3",
    "@s1:e4",
    "@s1:e5",
    "none",
  ]);
  assert.equal(details.reranked, true);
  assert.ok(details.notes.some((note: string) => /reranked the top 5 candidates/.test(note)));
  assert.equal(details.target.ref, "@s1:e2");
  assert.equal(details.confidence, 0.88);
  assert.equal(details.decision, "act");
});

test("cu_act corrects an unadvertised set-value to click on a readonly combobox", async () => {
  const tree: AdNode = {
    role: "window",
    name: "Prefs",
    children: [
      { role: "combobox", name: "Theme", ref_id: "@s1:e1", available_actions: ["Click", "Expand"] },
    ],
  };
  const runner = new FakeCliRunner((args) => snapshotEnvelope(tree));
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({ target: "@s1:e1", targetConfidence: 0.91, command: "set-value", offered: ["@s1:e1", "none"], needsText: 0.1 }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "choose the theme", app: "Prefs" },
    undefined,
    undefined,
    makeContext(),
  );
  const details = result.details as any;

  assert.equal(details.decision, "act");
  assert.equal(details.operation, "click");
  assert.equal(details.reconciled, true);
  assert.match(details.reconciled_note, /corrected to click/);
  assert.equal(runner.calls.length, 1);
});

test("cu_act abstains with the SetValue explanation when the target cannot receive text", async () => {
  const tree: AdNode = {
    role: "window",
    name: "Notes",
    children: [{ role: "entry", name: "Search", ref_id: "@s1:e1", available_actions: ["Click"] }],
  };
  const runner = new FakeCliRunner((args) => snapshotEnvelope(tree));
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({ target: "@s1:e1", targetConfidence: 0.92, command: "set-value", offered: ["@s1:e1", "none"], needsText: 0.9 }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "type hello into the search box", app: "Notes", text: "hello", execute: true },
    undefined,
    undefined,
    makeContext(),
  );
  const details = result.details as any;

  assert.equal(details.decision, "abstain");
  assert.equal(details.why, SET_VALUE_ABSTAIN_REASON);
  assert.equal(details.executed, false);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].args[0], "snapshot");
});

test("cu_act returns needs_text when the resolved Operation has no caller-supplied text", async () => {
  const tree: AdNode = {
    role: "window",
    name: "Notes",
    children: [{ role: "entry", name: "Search", ref_id: "@s1:e1", available_actions: ["SetValue"] }],
  };
  const runner = new FakeCliRunner((args) => snapshotEnvelope(tree));
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({ target: "@s1:e1", targetConfidence: 0.93, command: "set-value", offered: ["@s1:e1", "none"], needsText: 0.95 }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "fill in the search box", app: "Notes", execute: true },
    undefined,
    undefined,
    makeContext(),
  );
  const details = result.details as any;

  assert.equal(details.decision, "needs_text");
  assert.equal(details.operation, "set-value");
  assert.match(details.why, /text/);
  assert.equal(details.executed, false);
  assert.equal(runner.calls.length, 1);
});

test("cu_act does not act on an incoherent first-pass distribution", async () => {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(notesTree));
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({
      target: "@s1:e1",
      targetConfidence: 0.93,
      command: "click",
      targetDistribution: { "@s1:e1": 0.5, "@s1:e2": 0.3, none: 0.1 },
    }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "press the List View button", app: "Notes", execute: true },
    undefined,
    undefined,
    makeContext(),
  );
  const details = result.details as any;

  assert.equal(details.decision, "abstain");
  assert.match(details.why, /distribution/);
  assert.equal(runner.calls.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Interactive confirmation                                                    */
/* -------------------------------------------------------------------------- */

function confirmDecision() {
  return actDecision({ target: "@s1:e1", targetConfidence: 0.62, command: "click", destructive: 0.15 });
}

test("cu_act confirms an ambiguous step in the UI and executes it when approved", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(notesTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient(() => confirmDecision());
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const ctx = makeContext({ confirm: true });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "press the List View button", app: "Notes", execute: true },
    undefined,
    undefined,
    ctx,
  );
  const details = result.details as any;

  assert.equal(ctx.ui.confirms.length, 1);
  const prompt = ctx.ui.confirms[0];
  assert.equal(prompt.title, "Approve click?");
  assert.match(prompt.message, /Window: Notes — Preferences/);
  assert.match(prompt.message, /Operation: click/);
  assert.match(prompt.message, /Target: button "List View" \(@s1:e1\)/);
  assert.match(prompt.message, /Target confidence: 0\.62/);
  assert.match(prompt.message, /Destructive risk: 0\.15/);
  assert.deepEqual(runner.argLists("click"), [["click", "@s1:e1"]]);
  assert.equal(details.decision, "confirm");
  assert.equal(details.executed, true);
  assert.equal(details.confirmedByUser, true);
  assert.equal(details.delivery, "delivered_verified");
});

test("cu_act does not execute a declined confirmation and reports NOT_EXECUTED", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(notesTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient(() => confirmDecision());
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const ctx = makeContext({ confirm: false });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "press the List View button", app: "Notes", execute: true },
    undefined,
    undefined,
    ctx,
  );
  const details = result.details as any;

  assert.equal(ctx.ui.confirms.length, 1);
  assert.equal(runner.invocations("click").length, 0);
  assert.equal(details.decision, "confirm");
  assert.equal(details.executed, false);
  assert.equal(details.delivery, "not_delivered");
  assert.equal(details.code, "NOT_EXECUTED");
  assert.ok(details.notes.some((note: string) => /declined/.test(note)));
});

test("cu_act returns the confirm decision headless instead of executing it", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(notesTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient(() => confirmDecision());
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const ctx = makeContext({ hasUI: false });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "press the List View button", app: "Notes", execute: true },
    undefined,
    undefined,
    ctx,
  );
  const details = result.details as any;

  assert.equal(ctx.ui.confirms.length, 0);
  assert.equal(runner.invocations("click").length, 0);
  assert.equal(details.decision, "confirm");
  assert.equal(details.delivery, "not_delivered");
  assert.equal(details.code, "NOT_EXECUTED");
});

test("cu_act returns the confirm decision when confirmPolicy is return even with a UI", async () => {
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(notesTree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient(() => confirmDecision());
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const ctx = makeContext({ confirm: true });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "press the List View button", app: "Notes", execute: true, confirmPolicy: "return" },
    undefined,
    undefined,
    ctx,
  );
  const details = result.details as any;

  assert.equal(ctx.ui.confirms.length, 0);
  assert.equal(runner.invocations("click").length, 0);
  assert.equal(details.decision, "confirm");
  assert.equal(details.code, "NOT_EXECUTED");
});

/* -------------------------------------------------------------------------- */
/* Values, redaction, truncation, overlay, abort                               */
/* -------------------------------------------------------------------------- */

const valueTree: AdNode = {
  role: "window",
  name: "Notes",
  children: [
    { role: "entry", name: "Search", value: "hunter2-secret", ref_id: "@s1:e1", available_actions: ["SetValue"] },
    { role: "button", name: "Save", ref_id: "@s1:e2", available_actions: ["Click"] },
  ],
};

async function resolveWithValuesOption(noValues: boolean): Promise<FakeDecisionClient> {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(valueTree));
  const decisionClient = new FakeDecisionClient();
  decisionClient.queue(
    actDecision({
      target: "@s1:e1",
      targetConfidence: 0.62,
      command: "click",
      offered: ["@s1:e1", "@s1:e2", "none"],
    }),
    actDecision({
      target: "@s1:e1",
      targetConfidence: 0.91,
      command: "click",
      offered: ["@s1:e1", "@s1:e2", "none"],
    }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  await actTool(deps).execute(
    "call-1",
    { intent: "press the search field", app: "Notes", ...(noValues ? { noValues: true } : {}) },
    undefined,
    undefined,
    makeContext(),
  );
  return decisionClient;
}

test("cu_act withholds live field values from decision requests when noValues is true", async () => {
  const visible = await resolveWithValuesOption(false);
  assert.match(JSON.stringify(visible.requests[1]), /hunter2-secret/);

  const withheld = await resolveWithValuesOption(true);
  assert.ok(!JSON.stringify(withheld.requests).includes("hunter2-secret"));
});

test("cu_act redacts caller-supplied set-value text from tool output when redactText is true", async () => {
  const tree: AdNode = {
    role: "window",
    name: "Notes",
    children: [{ role: "entry", name: "Search", ref_id: "@s1:e1", available_actions: ["SetValue"] }],
  };
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(tree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({
      target: "@s1:e1",
      targetConfidence: 0.93,
      command: "set-value",
      offered: ["@s1:e1", "none"],
      needsText: 0.95,
    }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "type the search query", app: "Notes", text: "hunter2-secret", redactText: true, execute: true },
    undefined,
    undefined,
    makeContext(),
  );
  const details = result.details as any;

  assert.deepEqual(runner.argLists("set-value"), [
    ["set-value", "@s1:e1", "hunter2-secret"],
  ]);
  assert.ok(result.content[0].text.includes("[redacted]"));
  assert.ok(!result.content[0].text.includes("hunter2-secret"));
  assert.ok(!JSON.stringify(details).includes("hunter2-secret"));
  assert.equal(details.delivery, "delivered_verified");
});

test("cu_act never treats a SELECT option label as a secret", async () => {
  const tree: AdNode = {
    role: "window",
    name: "Prefs",
    children: [{ role: "combo box", name: "Theme", ref_id: "@s1:e1", available_actions: ["Select"] }],
  };
  const runner = new FakeCliRunner((args) => (args[0] === "snapshot" ? snapshotEnvelope(tree) : mutationEnvelope(args)));
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({
      target: "@s1:e1",
      targetConfidence: 0.92,
      command: "select",
      offered: ["@s1:e1", "none"],
      needsText: 0.95,
    }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "choose the Dark Mode theme", app: "Prefs", text: "Dark Mode", redactText: true, execute: true },
    undefined,
    undefined,
    makeContext(),
  );

  assert.deepEqual(runner.argLists("select"), [
    ["select", "@s1:e1", "Dark Mode"],
  ]);
  assert.ok(result.content[0].text.includes("Dark Mode"));
  assert.ok(!result.content[0].text.includes("[redacted]"));
});

test("cu_act records the 254-candidate truncation note", async () => {
  const wide: AdNode = {
    role: "window",
    name: "Wide",
    children: Array.from({ length: 300 }, (_, index) => ({
      role: "button",
      name: `Button ${index}`,
      ref_id: `@s1:e${index}`,
      available_actions: ["Click"],
    })),
  };
  const refs = wide.children!.map((node) => String(node.ref_id));
  const runner = new FakeCliRunner((args) => snapshotEnvelope(wide));
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({
      target: "@s1:e0",
      targetConfidence: 0.93,
      command: "click",
      offered: [...refs, "none"],
    }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "press Button 0", app: "Wide" },
    undefined,
    undefined,
    makeContext(),
  );
  const details = result.details as any;

  assert.equal(Object.keys(decisionClient.requests[0].questions.target.criteria as object).length, 255);
  assert.equal(details.truncated, 46);
  assert.ok(details.notes.some((note: string) => /capped at 254 candidates/.test(note)));
});

test("cu_act snapshots an open Overlay Surface instead of the Window behind it", async () => {
  const sheetTree: AdNode = {
    role: "sheet",
    name: "Allow access?",
    children: [{ role: "button", name: "Allow", ref_id: "@s2:e1", available_actions: ["Click"] }],
  };
  const runner = new FakeCliRunner((args) => {
    if (args[0] !== "snapshot") return mutationEnvelope(args);
    return args.includes("--surface")
      ? snapshotEnvelope(sheetTree, { surfaces: [{ kind: "sheet" }] })
      : snapshotEnvelope(notesTree, { surfaces: [{ kind: "sheet" }] });
  });
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({ target: "@s2:e1", targetConfidence: 0.93, command: "click", offered: ["@s2:e1", "none"] }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  const result = await actTool(deps).execute(
    "call-1",
    { intent: "press Allow", app: "Notes" },
    undefined,
    undefined,
    makeContext(),
  );
  const details = result.details as any;

  // agent-desktop forbids `--skeleton` on a surface, so the surface read is `-i` alone.
  assert.deepEqual(runner.argLists("snapshot"), [
    ["snapshot", "--app", "Notes", "-i", "--compact", "--include-bounds", "--skeleton"],
    ["snapshot", "--app", "Notes", "-i", "--surface", "sheet"],
  ]);
  assert.equal(details.surface, "sheet");
  assert.equal(details.target.ref, "@s2:e1");
  assert.ok(details.notes.some((note: string) => /Overlay Surface/.test(note)));
});

test("cu_act reads an explicitly pinned Overlay Surface without skeleton or bounds flags", async () => {
  const sheetTree: AdNode = {
    role: "sheet",
    name: "Allow access?",
    children: [{ role: "button", name: "Allow", ref_id: "@s2:e1", available_actions: ["Click"] }],
  };
  const runner = new FakeCliRunner((args) => snapshotEnvelope(sheetTree, { surfaces: [{ kind: "sheet" }] }));
  const decisionClient = new FakeDecisionClient(() =>
    actDecision({ target: "@s2:e1", targetConfidence: 0.93, command: "click", offered: ["@s2:e1", "none"] }),
  );
  const deps = makeDeps({ cli: runner, decision: decisionClient });

  await actTool(deps).execute(
    "call-1",
    { intent: "press Allow", app: "Notes", surface: "sheet" },
    undefined,
    undefined,
    makeContext(),
  );

  assert.deepEqual(runner.argLists("snapshot"), [["snapshot", "--app", "Notes", "-i", "--surface", "sheet"]]);
});

test("cu_act forwards the AbortSignal to the runner and the decision client", async () => {
  const runner = new FakeCliRunner((args) => snapshotEnvelope(notesTree));
  const signals: Array<AbortSignal | undefined> = [];
  const decisionClient = new FakeDecisionClient((request, signal) => {
    signals.push(signal);
    return actDecision({ target: "@s1:e1", targetConfidence: 0.93, command: "click" });
  });
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const controller = new AbortController();

  await actTool(deps).execute(
    "call-1",
    { intent: "press the List View button", app: "Notes" },
    controller.signal,
    undefined,
    makeContext(),
  );

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].options?.signal, controller.signal);
  assert.equal(signals.length, 1);
  assert.equal(signals[0], controller.signal);
});

test("cu_act lets a cancelled decision request abort instead of reporting DECISION_FAILED", async () => {
  const runner = new FakeCliRunner(() => snapshotEnvelope(notesTree));
  const decisionClient = new FakeDecisionClient(() => {
    throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
  });
  const deps = makeDeps({ cli: runner, decision: decisionClient });
  const controller = new AbortController();

  await assert.rejects(
    actTool(deps).execute(
      "call-1",
      { intent: "press the List View button", app: "Notes" },
      controller.signal,
      undefined,
      makeContext(),
    ),
    /aborted/i,
  );
});
