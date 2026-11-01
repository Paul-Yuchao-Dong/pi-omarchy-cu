import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../extensions/index.js";

/**
 * The package must load through Pi's extension factory without a session: the
 * factory only registers capabilities, it never starts processes or dialogs.
 */
test("extension factory registers the five tools and the /cu command", () => {
  const tools: Array<{ name: string; description: string; parameters: unknown }> = [];
  const commands: Array<{ name: string; handler: unknown }> = [];

  const pi = {
    registerTool(tool: { name: string; description: string; parameters: unknown }) {
      tools.push(tool);
    },
    registerCommand(name: string, options: { handler: unknown }) {
      commands.push({ name, handler: options.handler });
    },
    on() {
      return () => {};
    },
  };

  extension(pi as any);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["cu_status", "cu_observe", "cu_ref", "cu_act", "cu_run"],
  );
  for (const tool of tools) {
    assert.ok(tool.description.length > 100, `${tool.name} needs a self-sufficient description`);
    assert.ok(tool.parameters, `${tool.name} needs a TypeBox parameter schema`);
  }
  assert.deepEqual(
    commands.map((command) => command.name),
    ["cu"],
  );
  assert.equal(typeof commands[0].handler, "function");
});
