import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MEMORY_UPDATE_PROMPT, registerMemoryCommand } from "../command.ts";

type CommandAPI = Parameters<typeof registerMemoryCommand>[0];
type Command = Parameters<CommandAPI["registerCommand"]>[1];

function harness(idle = true) {
  let command: Command | undefined;
  let statusCalls = 0;
  const messages: Parameters<CommandAPI["sendUserMessage"]>[] = [];
  const notifications: [string, string | undefined][] = [];
  registerMemoryCommand({
    registerCommand(name, options) {
      assert.equal(name, "memory");
      command = options;
    },
    sendUserMessage(...args) { messages.push(args); },
  }, async () => {
    statusCalls++;
    return "memory status";
  });
  assert.ok(command);
  const ctx = {
    isIdle: () => idle,
    ui: { notify: (message: string, level?: string) => notifications.push([message, level]) },
  } as unknown as ExtensionCommandContext;
  return { command, ctx, messages, notifications, statusCalls: () => statusCalls };
}

test("/memory retains status behavior without starting an agent turn", async () => {
  const h = harness();
  await h.command.handler("   ", h.ctx);
  assert.equal(h.statusCalls(), 1);
  assert.deepEqual(h.notifications, [["memory status", "info"]]);
  assert.deepEqual(h.messages, []);
});

for (const idle of [true, false]) {
  test(`/memory update ${idle ? "starts a turn when idle" : "queues a follow-up when busy"}`, async () => {
    const h = harness(idle);
    await h.command.handler("  update  ", h.ctx);
    assert.deepEqual(h.messages, [[MEMORY_UPDATE_PROMPT, { deliverAs: "followUp" }]]);
    assert.equal(h.statusCalls(), 0);
    assert.deepEqual(h.notifications, []);
  });
}

test("unknown arguments show usage without triggering a turn or status reads", async () => {
  for (const args of ["unknown", "update extra"]) {
    const h = harness();
    await h.command.handler(args, h.ctx);
    assert.deepEqual(h.notifications, [["Usage: /memory (status) or /memory update", "warning"]]);
    assert.deepEqual(h.messages, []);
    assert.equal(h.statusCalls(), 0);
  }
});

test("argument completion suggests update only for matching prefixes", async () => {
  const { command } = harness();
  for (const prefix of ["", "up", "update"]) {
    const items = await command.getArgumentCompletions!(prefix);
    assert.equal(items?.length, 1);
    assert.equal(items?.[0].value, "update");
  }
  assert.equal(await command.getArgumentCompletions!("other"), null);
  assert.equal(await command.getArgumentCompletions!("update "), null);
});

test("update reminder requires targeted, evidence-based changes and allows a no-op", () => {
  assert.match(MEMORY_UPDATE_PROMPT, /incremental memory reminder/);
  assert.match(MEMORY_UPDATE_PROMPT, /memory_read.*memory_search/);
  assert.match(MEMORY_UPDATE_PROMPT, /Save important knowledge you have not already saved/);
  assert.match(MEMORY_UPDATE_PROMPT, /preserve unrelated or still-correct information/);
  assert.match(MEMORY_UPDATE_PROMPT, /age alone or not mentioning it is not evidence/);
  assert.match(MEMORY_UPDATE_PROMPT, /edit the relevant file in place/);
  assert.match(MEMORY_UPDATE_PROMPT, /deletions are recoverable/);
  assert.match(MEMORY_UPDATE_PROMPT, /Default to local memory/);
  assert.match(MEMORY_UPDATE_PROMPT, /Do not store secrets, credentials, temporary task state/);
  assert.match(MEMORY_UPDATE_PROMPT, /does not authorize remote access/);
  assert.match(MEMORY_UPDATE_PROMPT, /If nothing useful needs changing, leave memory untouched/);
});
