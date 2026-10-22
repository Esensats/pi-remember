import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSummaryPrompt, gatherConversationText, parseFacts } from "../summary.ts";

test("gatherConversationText flattens user/assistant only", () => {
  const text = gatherConversationText([
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Hi" }] } },
    { type: "message", message: { role: "assistant", content: "Hello there" } },
    { type: "message", message: { role: "toolResult", content: "ignored" } },
    { type: "custom", message: { role: "user", content: "ignored" } },
  ]);
  assert.equal(text, "User: Hi\n\nAssistant: Hello there");
});

test("gatherConversationText caps at maxChars keeping the tail", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "x".repeat(5000) } },
  ];
  const text = gatherConversationText(entries, 1000);
  assert.ok(text.length <= 1100);
  assert.ok(text.endsWith("x"));
});

test("buildSummaryPrompt mentions NONE contract", () => {
  const p = buildSummaryPrompt("some conversation");
  assert.match(p, /NONE/);
  assert.match(p, /some conversation/);
});

test("parseFacts: NONE, fenced, headings, short junk dropped", () => {
  assert.deepEqual(parseFacts("NONE"), []);
  assert.deepEqual(parseFacts(""), []);
  assert.deepEqual(
    parseFacts("```\ncode\n```\n# Heading\nshort\n- #preference Use pnpm always in this repo."),
    ["#preference Use pnpm always in this repo."],
  );
  assert.deepEqual(parseFacts("here are the facts:\n#fact A real fact worth keeping"), [
    "#fact A real fact worth keeping",
  ]);
});
