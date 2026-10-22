import { strict as assert } from "node:assert";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, describe, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CURRENT_VERSION } from "../migration.ts";
import { parseNote, serializeNote } from "../notes.ts";
import { parseMemoId } from "../store.ts";

// Only host packages are substituted. The extension, workspace resolver, stores,
// search and snapshot builder all run unchanged, against real temporary files.
const hostSource = `
  export const CONFIG_DIR_NAME = ".pi";
  export const queueCalls = [];
  const tails = new Map();
  export async function withFileMutationQueue(path, operation) {
    queueCalls.push(path);
    const previous = tails.get(path) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    tails.set(path, result);
    try { return await result; }
    finally { if (tails.get(path) === result) tails.delete(path); }
  }
  // These tests deliberately stay below the output caps.
  export function truncateTail(content) {
    const lines = content.split("\\n").length;
    return { content, truncated: false, outputLines: lines, totalLines: lines };
  }
`;
const optionalKey = Symbol.for("pi-remember-test.optional");
const schemaSource = `
  const optional = Symbol.for("pi-remember-test.optional");
  export const Type = {
    String: (options = {}) => ({ type: "string", ...options }),
    Optional: (schema) => ({ ...schema, [optional]: true }),
    Object: (properties) => ({ type: "object", properties,
      required: Object.keys(properties).filter(key => !properties[key][optional]) }),
  };
`;
const stubSources = new Map([
  ["@earendil-works/pi-coding-agent", hostSource],
  ["typebox", schemaSource],
  ["@earendil-works/pi-ai", "export const StringEnum = values => ({ type: 'string', enum: [...values] });"],
  ["@earendil-works/pi-tui", "export class Text {}"],
]);
const stubUrls = new Map([...stubSources].map(([name, source]) => [
  name, `data:text/javascript,${encodeURIComponent(source)}`,
]));
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubUrls.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());
const host = await import(stubUrls.get("@earendil-works/pi-coding-agent")!) as {
  queueCalls: string[];
  withFileMutationQueue: <T>(path: string, operation: () => Promise<T>) => Promise<T>;
};

interface Schema {
  type?: string;
  minLength?: number;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
  [optionalKey]?: boolean;
}
interface ToolResult {
  content: { type: string; text: string }[];
  details: unknown;
  isError?: boolean;
}
interface Context { cwd: string; hasUI: false }
interface Tool {
  name: string;
  parameters: Schema;
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal,
    onUpdate: undefined, ctx: Context) => Promise<ToolResult>;
}
type EventHandler = (event: Record<string, unknown>, ctx: Context) => Promise<{ systemPrompt: string } | void>;

const toolNames = ["memory_init", "memory_write", "memory_store", "memory_update", "memory_read",
  "memory_search", "memory_forget", "memory_restore", "memory_status"];
const memoryDir = (root: string) => join(root, ".pi", "memory");
const memoryFile = (root: string) => join(memoryDir(root), "MEMORY.md");
const noteFile = (root: string, path: string) => join(memoryDir(root), path);
const textOf = (result: ToolResult) => result.content.map(block => block.text).join("\n");

function success(result: ToolResult): string {
  assert.notEqual(result.isError, true, textOf(result));
  return textOf(result);
}
function error(result: ToolResult, pattern: RegExp): string {
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), pattern);
  return textOf(result);
}
function memoId(result: ToolResult): string {
  const match = success(result).match(/Memo ID: ([a-f0-9]{8})/i);
  assert.ok(match, textOf(result));
  return match[1];
}
function recoveryId(result: ToolResult, target?: { scope: "local" | "global"; root?: string }): string {
  const text = success(result);
  const match = text.match(/Recovery id: ([a-f0-9]{8})/i);
  assert.ok(match, text);
  if (target) {
    const hint = text.match(/Undo with memory_restore\((\{[^\n]+\})\)\./);
    assert.ok(hint, "undo hint must contain a JSON argument object");
    assert.deepEqual(JSON.parse(hint[1]), { recoveryId: match[1], ...target });
  }
  return match[1];
}
function notePath(result: ToolResult): string {
  const match = success(result).match(/Stored note: (notes\/[^\n]+)/);
  assert.ok(match, textOf(result));
  return match[1];
}
async function absent(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}
async function queued<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
  const start = host.queueCalls.length;
  const result = await operation();
  assert.deepEqual(host.queueCalls.slice(start), paths, "mutation must use the target file queue(s)");
  return result;
}

// Wait for the actual queue call, not a guessed delay before changing the disk.
// Always drain both promises, including when an assertion or filesystem edit fails.
async function blockedQueue<T>(path: string, operation: () => Promise<T>, change: () => Promise<void>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocker = host.withFileMutationQueue(path, () => gate);
  const start = host.queueCalls.length;
  let settled = false;
  const pending = operation().finally(() => { settled = true; });
  void pending.catch(() => {});
  try {
    for (let i = 0; i < 200 && !host.queueCalls.slice(start).includes(path) && !settled; i++) {
      await delay(5);
    }
    assert.deepEqual(host.queueCalls.slice(start), [path], "tool must enqueue behind the blocker");
    assert.equal(settled, false, "tool must still be waiting for the queue");
    await change();
  } finally {
    release();
    await blocker;
    await pending.catch(() => {});
  }
  return pending;
}

async function directoryState(root: string, omit: string[] = []) {
  const paths = (await readdir(root, { recursive: true })).filter(path => !omit.includes(path)).sort();
  return Promise.all(paths.map(async path => {
    const absolute = join(root, path);
    return [path, (await lstat(absolute)).isDirectory() ? null : await readFile(absolute)] as const;
  }));
}

async function putFixtureFile(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function migrationBackup(dir: string) {
  const runs = await readdir(join(dir, "migrations"));
  assert.equal(runs.length, 1, "migration must run exactly once");
  const backup = join(dir, "migrations", runs[0]);
  const manifest = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8"));
  assert.equal(manifest.fromVersion, 0);
  assert.equal(manifest.toVersion, CURRENT_VERSION);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "pi-remember.json"), "utf8")), { version: CURRENT_VERSION });
  await absent(join(dir, ".pi-remember-migration.lock"));
  return backup;
}

const summaryFact = "#decision The workshop uses zirconium glaze for outdoor ceramic fixtures.";
function summaryContext(cwd: string) {
  const calls = { find: 0, auth: 0, complete: 0 };
  const model = { provider: "test", id: "summary" };
  const ctx = {
    cwd, hasUI: false as const, model,
    sessionManager: {
      getBranch: () => [{ type: "message", message: {
        role: "user", content: "The ceramic workshop standardizes on zirconium glaze for outdoor fixtures because repeated weathering trials showed much better durability than the previous recipe.",
      } }],
    },
    modelRegistry: {
      find() { calls.find++; return model; },
      hasConfiguredAuth() { calls.auth++; return true; },
      async complete() {
        calls.complete++;
        return { content: [{ type: "text", text: summaryFact }] };
      },
    },
  };
  return { ctx, calls };
}

let fixtureNumber = 0;
async function fixture(t: TestContext, options: {
  exitSummary?: boolean;
  beforeStart?: (paths: { cwd: string; other: string; globalDir: string }) => Promise<void>;
} = {}) {
  const base = await mkdtemp(join(tmpdir(), "pi-remember-tools-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, "session");
  const other = join(base, "external");
  const third = join(base, "third");
  const globalDir = join(base, "global");
  await Promise.all([cwd, other, third].map(root => mkdir(root)));

  // Each import has its own module-level stores/snapshot/config. No chdir, no
  // real user memory, and no dependence on inherited injection/summary settings.
  const environment = {
    PI_REMEMBER_DIR: globalDir,
    PI_REMEMBER_EXIT_SUMMARY: options.exitSummary ? "1" : "0",
    PI_REMEMBER_EXIT_SUMMARY_SCOPE: "local",
    PI_REMEMBER_EXIT_SUMMARY_MODEL: "test/summary",
    PI_REMEMBER_EXIT_SUMMARY_TIMEOUT_MS: "50",
    PI_REMEMBER_INJECT_CHARS_GLOBAL: "20000",
    PI_REMEMBER_INJECT_CHARS_LOCAL: "20000",
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  let extension;
  try {
    Object.assign(process.env, environment);
    extension = (await import(new URL(`../index.ts?tools-fixture=${++fixtureNumber}`, import.meta.url).href)).default;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const tools = new Map<string, Tool>();
  const events = new Map<string, EventHandler>();
  const commands = new Map<string, unknown>();
  extension({
    registerTool(tool: Tool) {
      assert.ok(!tools.has(tool.name), `duplicate tool registration: ${tool.name}`);
      tools.set(tool.name, tool);
    },
    on(name: string, handler: EventHandler) {
      assert.ok(!events.has(name), `duplicate event registration: ${name}`);
      events.set(name, handler);
    },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
  });
  const ctx: Context = { cwd, hasUI: false };
  const signal = new AbortController().signal;
  async function call(name: string, params: Record<string, unknown> = {}) {
    const tool = tools.get(name);
    assert.ok(tool, `tool registered: ${name}`);
    return tool.execute("test-call", params, signal, undefined, ctx);
  }
  async function prompt() {
    const handler = events.get("before_agent_start");
    assert.ok(handler);
    return (await handler({ systemPrompt: "BASE PROMPT" }, ctx))?.systemPrompt ?? "BASE PROMPT";
  }
  const start = events.get("session_start");
  assert.ok(start);
  await options.beforeStart?.({ cwd, other, globalDir });
  await start({}, ctx);
  return { base, cwd, other, third, globalDir, tools, events, commands, call, prompt };
}

// The extension has module-level session state and process-wide env/hooks.
// Keep fixtures serial; concurrency is exercised explicitly inside a fixture.
describe("real extension tool wiring", { concurrency: false }, () => {
  test("registers all nine tools with optional root and restore's optional scope", async t => {
    const f = await fixture(t);
    assert.deepEqual([...f.tools.keys()].sort(), [...toolNames].sort());
    assert.deepEqual([...f.events.keys()].sort(), ["before_agent_start", "session_shutdown", "session_start"]);
    assert.ok(f.commands.has("memory"));
    for (const name of toolNames) {
      const schema = f.tools.get(name)!.parameters;
      const root = schema.properties?.root;
      assert.ok(root, `${name} exposes root`);
      assert.equal(root.type, "string", name);
      assert.equal(root.minLength, 1, name);
      assert.equal(root[optionalKey], true, name);
      assert.ok(!schema.required?.includes("root"), name);
    }
    const slug = f.tools.get("memory_store")!.parameters.properties?.slug;
    assert.equal(slug?.type, "string");
    assert.equal(slug?.minLength, 1);
    assert.equal(slug?.[optionalKey], true);
    assert.ok(!f.tools.get("memory_store")!.parameters.required?.includes("slug"));
    const restore = f.tools.get("memory_restore")!.parameters;
    assert.deepEqual(restore.properties?.scope.enum, ["global", "local", "both"]);
    assert.ok(!restore.required?.includes("scope"));
  });

  test("all local/both operations require init, while status is diagnostic and read-only", async t => {
    const f = await fixture(t);
    const cases: [string, Record<string, unknown>][] = [
      ["memory_write", { content: "Uninitialized durable fact" }],
      ["memory_store", { title: "Uninitialized note", content: "Body" }],
      ["memory_update", { id: "1234abcd", content: "Replacement fact" }],
      ["memory_read", {}], ["memory_read", { scope: "local" }],
      ["memory_read", { scope: "both", id: "1234abcd" }],
      ["memory_read", { path: "notes/missing.md" }],
      ["memory_search", { query: "fact" }], ["memory_search", { query: "fact", scope: "local" }],
      ["memory_search", { query: "fact", scope: "both" }],
      ["memory_forget", { text: "fact" }],
      ["memory_restore", { recoveryId: "1234abcd" }],
      ["memory_restore", { recoveryId: "1234abcd", scope: "local" }],
      ["memory_restore", { recoveryId: "1234abcd", scope: "both" }],
    ];
    const beforeQueue = host.queueCalls.length;
    for (const root of [undefined, f.other]) {
      const target = root ?? f.cwd;
      const explicitLocal = cases.filter(([name]) =>
        ["memory_write", "memory_store", "memory_update", "memory_forget"].includes(name))
        .map(([name, params]): [string, Record<string, unknown>] => [name, { ...params, scope: "local" }]);
      for (const [name, params] of [...cases, ...explicitLocal]) {
        const message = error(await f.call(name, { ...params, root }), /memory_init/);
        assert.ok(message.includes(memoryFile(target)), `${name}: target path in guidance`);
        assert.ok(message.includes(`root:${JSON.stringify(target)}`), `${name}: actionable root`);
      }
      const status = success(await f.call("memory_status", { root }));
      assert.ok(status.includes(memoryFile(target)));
      assert.ok(status.includes(join(f.globalDir, "MEMORY.md")));
      assert.match(status, /no memory yet; run memory_init first/);
      assert.match(status, /0 chars \(global 0, local 0\)/);
    }
    assert.equal(host.queueCalls.length, beforeQueue, "guards/status must not mutate");
    assert.deepEqual(await readdir(f.cwd), []);
    assert.deepEqual(await readdir(f.other), []);
    await absent(f.globalDir);
    assert.equal(await f.prompt(), "BASE PROMPT");
  });

  test("init uses session cwd, resolves absolute/relative/~/ roots, preserves bytes, rejects missing roots", async t => {
    const f = await fixture(t);
    assert.notEqual(f.cwd, process.cwd(), "default is session cwd, not process.cwd()");
    assert.match(success(await queued([memoryFile(f.cwd)], () => f.call("memory_init"))), /Initialized local memory/);
    assert.equal(await readFile(memoryFile(f.cwd), "utf8"), "");
    const bytes = Buffer.from("<!-- manual -->\r\nKeep exactly\t \r\n\0");
    await writeFile(memoryFile(f.cwd), bytes);
    const before = await lstat(memoryFile(f.cwd));
    assert.match(success(await queued([memoryFile(f.cwd)], () => f.call("memory_init"))), /already initialized.*preserved/);
    assert.deepEqual(await readFile(memoryFile(f.cwd)), bytes);
    const after = await lstat(memoryFile(f.cwd));
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    for (const root of [f.other, "../external", `~/${relative(homedir(), f.other)}`]) {
      success(await queued([memoryFile(f.other)], () => f.call("memory_init", { root })));
      assert.ok(success(await f.call("memory_status", { root })).includes(memoryFile(f.other)));
    }
    assert.equal(await readFile(memoryFile(f.other), "utf8"), "");
    for (const workspace of [f.other, f.cwd]) {
      assert.deepEqual((await readdir(memoryDir(workspace))).sort(), ["MEMORY.md", "migrations", "pi-remember.json"]);
      assert.deepEqual(JSON.parse(await readFile(join(memoryDir(workspace), "pi-remember.json"), "utf8")), { version: CURRENT_VERSION });
      assert.equal((await readdir(join(memoryDir(workspace), "migrations"))).length, 1, "repeated init must not remigrate");
    }
    const missing = join(f.base, "missing", "nested");
    const queueStart = host.queueCalls.length;
    for (const name of ["memory_init", "memory_status"]) {
      error(await f.call(name, { root: missing }), /Cannot resolve workspace root/);
    }
    assert.equal(host.queueCalls.length, queueStart);
    await absent(join(f.base, "missing"));
    await absent(f.globalDir);
  });

  test("external fact and note lifecycle targets that root without changing default local memory", async t => {
    const f = await fixture(t);
    success(await f.call("memory_init"));
    success(await f.call("memory_init", { root: f.other }));
    success(await f.call("memory_write", { content: "Current workspace sentinel stays untouched" }));
    const localBefore = await readFile(memoryFile(f.cwd));
    const snapshotBefore = await f.prompt();
    const root = "../external";
    const index = memoryFile(f.other);
    const fact = "External kiln temperature is 940 degrees";
    const factId = memoId(await queued([index], () => f.call("memory_write", { root, content: fact })));
    const stored = await queued([index], () => f.call("memory_store", {
      root, title: "Ceramic workshop handbook", content: "Original glaze recipe uses zirconium.",
    }));
    const noteId = memoId(stored);
    const path = notePath(stored);
    const originalNote = await readFile(noteFile(f.other, path), "utf8");
    assert.ok(success(await f.call("memory_read", { root })).includes(fact));
    assert.ok(success(await f.call("memory_read", { root, id: factId })).includes(fact));
    assert.match(success(await f.call("memory_read", { root, query: "KILN" })), /940 degrees/);
    for (const selector of [{ id: noteId }, { path }]) {
      assert.match(success(await f.call("memory_read", { root, ...selector })), /Original glaze recipe/);
    }
    const hits = success(await f.call("memory_search", { root, query: "zirconium" }));
    assert.ok(hits.includes(`[local/${path}] [id=${noteId}]`));
    assert.ok(success(await f.call("memory_search", { root, query: "kiln" })).includes(`[id=${factId}]`));

    const factUndo = recoveryId(await queued([index], () => f.call("memory_update", {
      root, id: factId, content: "External kiln temperature is 960 degrees",
    })), { scope: "local", root });
    assert.match(success(await f.call("memory_read", { root, id: factId })), /960 degrees/);
    assert.match(success(await queued([index], () => f.call("memory_restore", { root, recoveryId: factUndo }))), /Restored/);
    assert.ok(success(await f.call("memory_read", { root, id: factId })).includes(fact));

    const noteUndo = recoveryId(await queued([index, noteFile(f.other, path)], () => f.call("memory_update", {
      root, id: noteId, content: "Revised glaze recipe uses feldspar.",
    })), { scope: "local", root });
    assert.match(success(await f.call("memory_read", { root, path })), /Revised glaze recipe/);
    assert.equal(success(await f.call("memory_search", { root, query: "zirconium" })), "No matches in memory.");
    success(await queued([index, noteFile(f.other, path)], () => f.call("memory_restore", { root, recoveryId: noteUndo })));
    assert.equal(await readFile(noteFile(f.other, path), "utf8"), originalNote);

    for (const [id, query] of [[factId, "External kiln"], [noteId, "Ceramic workshop handbook"]]) {
      const forgetQueues = id === noteId ? [index, noteFile(f.other, path)] : [index];
      const undo = recoveryId(await queued(forgetQueues, () => f.call("memory_forget", { root, text: query })), { scope: "local", root });
      error(await f.call("memory_read", { root, id }), /not found/i);
      assert.match(success(await f.call("memory_restore", { recoveryId: undo })), /No recovery record/);
      assert.match(success(await f.call("memory_restore", { root, scope: "global", recoveryId: undo })), /No recovery record/);
      success(await queued([index], () => f.call("memory_restore", { root, recoveryId: undo })));
      assert.ok(success(await f.call("memory_read", { root, id })).includes(query));
    }
    assert.deepEqual(await readdir(join(memoryDir(f.other), "recovery")), []);
    assert.match(success(await f.call("memory_status", { root })), /1 facts, 1 notes/);
    assert.deepEqual(await readFile(memoryFile(f.cwd)), localBefore);
    assert.equal(await f.prompt(), snapshotBefore, "foreign mutations must not refresh/inject foreign memory");
    const defaultRead = success(await f.call("memory_read"));
    assert.match(defaultRead, /Current workspace sentinel/);
    assert.doesNotMatch(defaultRead, /External kiln|Ceramic workshop/);
    assert.equal(success(await f.call("memory_search", { query: "zirconium" })), "No matches in memory.");
    await absent(f.globalDir);
  });

  test("every global-only tool ignores root and works with uninitialized session local memory", async t => {
    const f = await fixture(t);
    const index = join(f.globalDir, "MEMORY.md");
    // Unsupported syntax would fail workspace resolution if a global tool used it.
    const params = { root: "~not-a-supported-user/missing", scope: "global" };
    const id = memoId(await queued([index], () => f.call("memory_write", { ...params, content: "Machine keyboard layout is Colemak" })));
    const stored = await queued([index], () => f.call("memory_store", {
      ...params, title: "Monitor calibration guide", content: "Display whitepoint is D65.",
    }));
    const path = notePath(stored);
    assert.match(success(await f.call("memory_read", { ...params, id })), /Colemak/);
    assert.match(success(await f.call("memory_read", { ...params, path })), /whitepoint/);
    assert.match(success(await f.call("memory_search", { ...params, query: "whitepoint" })), /D65/);
    const undo = recoveryId(await queued([index], () => f.call("memory_update", {
      ...params, id, content: "Machine keyboard layout is Dvorak",
    })), { scope: "global" });
    error(await f.call("memory_restore", { recoveryId: undo }), /memory_init/);
    assert.match(success(await queued([index], () => f.call("memory_restore", { ...params, recoveryId: undo }))), /to global memory/);
    const deletion = recoveryId(await queued([index], () => f.call("memory_forget", { ...params, text: "Colemak" })), { scope: "global" });
    success(await queued([index], () => f.call("memory_restore", { ...params, recoveryId: deletion })));
    assert.match(success(await f.call("memory_read", params)), /Colemak/);
    assert.match(await f.prompt(), /Colemak/);
    assert.deepEqual(await readdir(f.cwd), []);
    assert.deepEqual(await readdir(f.other), []);
  });

  test("restore defaults to both, rejects ambiguity, and explicit scope selects the correct record", async t => {
    const f = await fixture(t);
    success(await f.call("memory_init", { root: f.other }));
    const root = f.other;
    const globalId = memoId(await f.call("memory_write", { scope: "global", content: "Global recovery fixture original" }));
    const localId = memoId(await f.call("memory_write", { root, content: "Local recovery fixture original" }));
    const globalUndo = recoveryId(await f.call("memory_forget", { scope: "global", text: "Global recovery fixture" }));
    const localUndo = recoveryId(await f.call("memory_forget", { root, text: "Local recovery fixture" }));
    // Force an otherwise astronomically unlikely cross-scope recovery ID collision.
    const globalRecoveryDir = join(f.globalDir, "recovery");
    const record = JSON.parse(await readFile(join(globalRecoveryDir, `${globalUndo}.json`), "utf8"));
    await writeFile(join(globalRecoveryDir, `${localUndo}.json`), JSON.stringify({ ...record, id: localUndo }));
    const localBefore = await readFile(memoryFile(root));
    const globalBefore = await readFile(join(f.globalDir, "MEMORY.md"));
    error(await f.call("memory_restore", { root, recoveryId: localUndo }), /Ambiguous recovery ID/);
    error(await f.call("memory_restore", { root, scope: "both", recoveryId: localUndo }), /Ambiguous recovery ID/);
    assert.deepEqual(await readFile(memoryFile(root)), localBefore);
    assert.deepEqual(await readFile(join(f.globalDir, "MEMORY.md")), globalBefore);
    success(await queued([memoryFile(root)], () => f.call("memory_restore", { root, scope: "local", recoveryId: localUndo })));
    assert.match(success(await f.call("memory_read", { root, id: localId })), /Local recovery fixture original/);
    success(await queued([join(f.globalDir, "MEMORY.md")], () => f.call("memory_restore", {
      root: join(f.base, "nonexistent"), scope: "global", recoveryId: localUndo,
    })));
    assert.match(success(await f.call("memory_read", { scope: "global", id: globalId })), /Global recovery fixture original/);
    // A fresh global deletion is found by default-both even through an external root.
    const nextUndo = recoveryId(await f.call("memory_forget", { scope: "global", text: "Global recovery fixture" }));
    success(await f.call("memory_restore", { root, recoveryId: nextUndo }));
    await absent(memoryDir(f.cwd));
  });

  test("only current local/global mutations refresh the session snapshot", async t => {
    const f = await fixture(t);
    success(await f.call("memory_init"));
    success(await f.call("memory_init", { root: f.other }));
    const localId = memoId(await f.call("memory_write", { content: "Current amber lighthouse marker" }));
    const initial = await f.prompt();
    assert.match(initial, /Current amber lighthouse marker/);
    success(await f.call("memory_write", { root: f.other, content: "Foreign violet canyon marker" }));
    success(await f.call("memory_read", { root: f.other }));
    success(await f.call("memory_search", { root: f.other, query: "violet" }));
    success(await f.call("memory_status", { root: f.other }));
    assert.equal(await f.prompt(), initial);
    const globalId = memoId(await f.call("memory_write", {
      root: f.other, scope: "global", content: "Universal turquoise keyboard marker",
    }));
    const shared = await f.prompt();
    assert.match(shared, /Current amber lighthouse marker/);
    assert.match(shared, /Universal turquoise keyboard marker/);
    assert.doesNotMatch(shared, /Foreign violet canyon marker/);
    for (const [id, scope, oldWord, newWord] of [
      [localId, "local", "amber", "copper"], [globalId, "global", "turquoise", "emerald"],
    ]) {
      const replacement = scope === "local" ? "Current copper lighthouse marker" : "Universal emerald keyboard marker";
      const undo = recoveryId(await f.call("memory_update", { id, scope, content: replacement }));
      assert.ok((await f.prompt()).includes(newWord));
      assert.ok(!(await f.prompt()).includes(oldWord));
      success(await f.call("memory_restore", { scope, recoveryId: undo }));
      assert.ok((await f.prompt()).includes(oldWord));
      const deletion = recoveryId(await f.call("memory_forget", { scope, text: oldWord }));
      assert.ok(!(await f.prompt()).includes(oldWord));
      success(await f.call("memory_restore", { scope, recoveryId: deletion }));
      assert.ok((await f.prompt()).includes(oldWord));
    }
    assert.doesNotMatch(await f.prompt(), /Foreign violet/);
  });

  test("cross-scope similarity uses the target local store, and global writes ignore provided root", async t => {
    const f = await fixture(t);
    success(await f.call("memory_init"));
    success(await f.call("memory_init", { root: f.other }));
    success(await f.call("memory_write", { root: f.other, content: "Orchid copper calibration protocol delta" }));
    success(await f.call("memory_store", { root: f.other, title: "Basalt lunar refraction checklist", content: "External optics." }));
    // These resemble ONLY external memory: a prior external call must not have
    // switched the session store used by a global-only operation.
    assert.doesNotMatch(success(await f.call("memory_write", {
      scope: "global", root: f.other, content: "Orchid copper calibration protocol epsilon",
    })), /similar entry in local/);
    assert.doesNotMatch(success(await f.call("memory_store", {
      scope: "global", root: f.other, title: "Basalt lunar refraction handbook", content: "Machine optics.",
    })), /similar entry in local/);
    success(await f.call("memory_write", { content: "Saffron glacier telemetry profile alpha" }));
    success(await f.call("memory_store", { title: "Quartz meadow impedance workflow", content: "Current workspace details." }));
    const warning = success(await f.call("memory_write", {
      scope: "global", root: f.other, content: "Saffron glacier telemetry profile beta",
    }));
    assert.match(warning, /similar entry in local memory: Saffron glacier telemetry profile alpha/);
    assert.match(success(await f.call("memory_store", {
      scope: "global", root: f.other, title: "Quartz meadow impedance procedure", content: "Shared details.",
    })), /similar entry in local memory:.*Quartz meadow impedance workflow/);
    // Conversely, a foreign local write must check the global counterpart, not
    // default local memory or a stale per-call store.
    assert.match(success(await f.call("memory_write", {
      root: f.other, content: "Saffron glacier telemetry profile gamma",
    })), /similar entry in global memory/);
  });

  for (const name of ["memory_init", "memory_write", "memory_store", "memory_update", "memory_forget", "memory_restore", "memory_read", "memory_search"]) {
    for (const loss of ["index", "workspace", "symlink replacement"] as const) {
      // Recreating a missing index is the explicit purpose of memory_init.
      if (name === "memory_init" && loss === "index") continue;
      test(`${name} revalidates a queued local target after ${loss} loss`, async t => {
        const f = await fixture(t);
        const root = "../external";
        const index = memoryFile(f.other);
        let params: Record<string, unknown> = { root };
        if (name !== "memory_init") {
          success(await f.call("memory_init", { root }));
          const id = memoId(await f.call("memory_write", { root, content: "Original kiln calibration sentinel" }));
          const note = await f.call("memory_store", { root, title: "Original workshop handbook", content: "Preserve this note body." });
          const noteId = memoId(note);
          const undo = name === "memory_restore"
            ? recoveryId(await f.call("memory_forget", { root, text: "Original kiln" }), { scope: "local", root })
            : undefined;
          const argumentsByTool: Record<string, Record<string, unknown>> = {
            memory_write: { content: "Queued compass calibration must never be saved" },
            memory_store: { title: "Queued optics manual", content: "Must never create a note." },
            memory_update: { id: noteId, content: "Must never replace the existing note." },
            memory_forget: { text: "Original kiln" },
            memory_restore: { recoveryId: undo },
            memory_read: { scope: "local", id: noteId },
            memory_search: { scope: "local", query: "Original workshop" },
          };
          params = { root, ...argumentsByTool[name] };
          assert.ok(id, "real existing fact available for forget/restore");
        }
        const original = await directoryState(f.other);
        const parked = join(f.base, "parked-workspace");
        const parkedIndex = join(f.base, "parked-MEMORY.md");
        let replacement: Awaited<ReturnType<typeof directoryState>> | undefined;
        if (loss === "symlink replacement") {
          // Copy recovery records too: without the canonical-root check a restore
          // could consume a valid record through the replacement symlink.
          await cp(f.other, f.third, { recursive: true });
          success(await f.call("memory_init", { root: f.third }));
          success(await f.call("memory_write", { root: f.third, content: "Replacement workspace sentinel must stay untouched" }));
          replacement = await directoryState(f.third);
        }
        let withoutIndex: Awaited<ReturnType<typeof directoryState>> | undefined;
        const result = await blockedQueue(index, () => f.call(name, params), async () => {
          if (loss === "index") {
            await rename(index, parkedIndex);
            withoutIndex = await directoryState(f.other);
          } else {
            await rename(f.other, parked);
            if (loss === "symlink replacement") await symlink(f.third, f.other, "dir");
          }
        });
        const message = error(result, /memory_init|workspace root/i);
        assert.ok(message.includes(loss === "index" ? index : f.other));
        if (loss === "index") {
          await absent(index);
          assert.deepEqual(await directoryState(f.other), withoutIndex, "no notes/recovery files may change");
          await rename(parkedIndex, index);
          assert.deepEqual(await directoryState(f.other), original, "detached index bytes must be preserved");
        } else {
          assert.deepEqual(await directoryState(parked), original, "original store must be untouched");
          if (loss === "workspace") await absent(f.other);
          else {
            assert.equal((await lstat(f.other)).isSymbolicLink(), true);
            assert.deepEqual(await directoryState(f.third), replacement, "replacement store must be untouched");
          }
        }
        await absent(f.globalDir);
      });
    }
  }

  for (const corruption of ["directory", "unreadable permissions"] as const) {
    test(`global mutations survive a local index with ${corruption} and status stays diagnostic`, async t => {
      if (corruption === "unreadable permissions" && process.getuid?.() === 0) {
        t.skip("root can read files despite permission bits");
        return;
      }
      const f = await fixture(t);
      success(await f.call("memory_init"));
      success(await f.call("memory_write", { content: "Local broken index sentinel must not be injected" }));
      const index = memoryFile(f.cwd);
      const original = await readFile(index);
      const parkedIndex = join(f.base, "unreadable-original.md");
      const mode = (await lstat(index)).mode & 0o777;
      if (corruption === "directory") {
        await rename(index, parkedIndex);
        await mkdir(index);
      } else await chmod(index, 0o000);
      const localState = await directoryState(memoryDir(f.cwd), ["MEMORY.md"]);
      const corruptIndex = await lstat(index);
      try {
        await assert.rejects(readFile(index), { code: corruption === "directory" ? "EISDIR" : "EACCES" });
        // Exercise startup as well as post-commit snapshot refreshes.
        await f.events.get("session_start")!({}, { cwd: f.cwd, hasUI: false });
        assert.equal(await f.prompt(), "BASE PROMPT");
        const params = { scope: "global", root: f.other };
        const globalIndex = join(f.globalDir, "MEMORY.md");
        const fact = "Machine keyboard layout is Colemak";
        const id = memoId(await queued([globalIndex], () => f.call("memory_write", { ...params, content: fact })));
        assert.match(await f.prompt(), /Colemak/);
        const note = await queued([globalIndex], () => f.call("memory_store", {
          ...params, title: "Monitor calibration reference", content: "Display whitepoint is D65.",
        }));
        memoId(note);
        const path = notePath(note);
        assert.match(success(await f.call("memory_read", { ...params, path })), /whitepoint is D65/);
        assert.match(await f.prompt(), /Monitor calibration reference/);
        const undo = recoveryId(await queued([globalIndex], () => f.call("memory_update", {
          ...params, id, content: "Machine keyboard layout is Dvorak",
        })), { scope: "global" });
        await lstat(join(f.globalDir, "recovery", `${undo}.json`));
        assert.match(await f.prompt(), /Dvorak/);
        assert.doesNotMatch(await f.prompt(), /Colemak/);
        success(await queued([globalIndex], () => f.call("memory_restore", { ...params, recoveryId: undo })));
        assert.match(await f.prompt(), /Colemak/);
        const deletion = recoveryId(await queued([globalIndex], () => f.call("memory_forget", {
          ...params, text: "Colemak",
        })), { scope: "global" });
        await lstat(join(f.globalDir, "recovery", `${deletion}.json`));
        assert.doesNotMatch(await f.prompt(), /Colemak/);
        success(await queued([globalIndex], () => f.call("memory_restore", { ...params, recoveryId: deletion })));
        assert.match(success(await f.call("memory_read", { ...params, id })), /Colemak/);
        assert.deepEqual(await readdir(join(f.globalDir, "recovery")), []);
        const prompt = await f.prompt();
        assert.match(prompt, /Colemak/);
        assert.doesNotMatch(prompt, /Local broken index sentinel/);
        const queueStart = host.queueCalls.length;
        const status = success(await f.call("memory_status"));
        assert.ok(status.includes(`global: ${globalIndex} (1 facts, 1 notes,`));
        assert.ok(status.includes(`local: ${index} (inspection error:`));
        assert.match(status, corruption === "directory" ? /EISDIR/ : /EACCES/);
        assert.match(status, /injected snapshot.*global [1-9]\d*, local 0/);
        assert.equal(host.queueCalls.length, queueStart, "status inspection must remain read-only");
        assert.deepEqual(await directoryState(memoryDir(f.cwd), ["MEMORY.md"]), localState,
          "diagnostic tools must preserve the already-versioned store");
        const stillCorrupt = await lstat(index);
        assert.equal(stillCorrupt.ino, corruptIndex.ino);
        assert.equal(stillCorrupt.mode, corruptIndex.mode);
        assert.equal(stillCorrupt.mtimeMs, corruptIndex.mtimeMs);
        assert.deepEqual(await readdir(f.other), []);
      } finally {
        if (corruption === "unreadable permissions") await chmod(index, mode);
      }
      assert.deepEqual(await readFile(corruption === "directory" ? parkedIndex : index), original);
    });
  }

  test("local exit summary checks initialization before any model call", async t => {
    const f = await fixture(t, { exitSummary: true });
    const summary = summaryContext(f.cwd);
    const shutdown = f.events.get("session_shutdown")!;
    const queueStart = host.queueCalls.length;
    await shutdown({ reason: "quit" }, summary.ctx);
    assert.deepEqual(summary.calls, { find: 0, auth: 0, complete: 0 });
    assert.equal(host.queueCalls.length, queueStart);
    assert.deepEqual(await readdir(f.cwd), []);
    await absent(f.globalDir);
    assert.equal(await f.prompt(), "BASE PROMPT");
    // Positive control: the same conversation/model stub really produces facts
    // once the destination is initialized (and uses a short summary timeout).
    success(await f.call("memory_init"));
    await queued([memoryFile(f.cwd)], () => shutdown({ reason: "quit" }, summary.ctx));
    assert.deepEqual(summary.calls, { find: 1, auth: 1, complete: 1 });
    assert.ok((await readFile(memoryFile(f.cwd), "utf8")).includes(summaryFact));
    assert.ok((await f.prompt()).includes(summaryFact));
    await absent(f.globalDir);
  });

  test("queued local exit summary rechecks initialization after losing its index", async t => {
    const f = await fixture(t, { exitSummary: true });
    success(await f.call("memory_init"));
    success(await f.call("memory_write", { content: "Existing local summary sentinel" }));
    const index = memoryFile(f.cwd);
    const original = await readFile(index);
    const before = await f.prompt();
    const parkedIndex = join(f.base, "summary-MEMORY.md");
    const summary = summaryContext(f.cwd);
    let withoutIndex: Awaited<ReturnType<typeof directoryState>>;
    await blockedQueue(index, () => f.events.get("session_shutdown")!({ reason: "quit" }, summary.ctx), async () => {
      await rename(index, parkedIndex);
      withoutIndex = await directoryState(memoryDir(f.cwd));
    });
    assert.deepEqual(summary.calls, { find: 1, auth: 1, complete: 1 });
    await absent(index);
    assert.deepEqual(await readFile(parkedIndex), original);
    assert.deepEqual(await directoryState(memoryDir(f.cwd)), withoutIndex!);
    assert.equal(await f.prompt(), before, "failed summary must not inject unsaved facts");
    await absent(f.globalDir);
  });

  test("mixed concurrent roots stay isolated and all mutations use their own queues", async t => {
    const f = await fixture(t);
    const targets = [
      { root: undefined, workspace: f.cwd, label: "cedar" },
      { root: "../external", workspace: f.other, label: "maple" },
      { root: `~/${relative(homedir(), f.third)}`, workspace: f.third, label: "willow" },
    ];
    await Promise.all(targets.map(async ({ root }) => success(await f.call("memory_init", { root }))));
    const queueStart = host.queueCalls.length;
    const writes = targets.flatMap(({ root, label }) => Array.from({ length: 12 }, (_, i) => ({
      root, content: `${label} durable specimen ${String(i).padStart(3, "0")}`,
    })));
    const results = await Promise.all(writes.map(params => f.call("memory_write", params)));
    results.forEach(result => memoId(result));
    const writeQueues = host.queueCalls.slice(queueStart);
    for (const { workspace } of targets) assert.equal(writeQueues.filter(path => path === memoryFile(workspace)).length, 12);
    assert.equal(writeQueues.length, writes.length);

    // Repeated identical notes race on the read/check/write sequence. Exactly
    // one note per root must be created, not overwritten by the losing calls.
    const notes = await Promise.all(targets.flatMap(({ root, label }) => Array.from({ length: 6 }, (_, i) =>
      f.call("memory_store", { root, title: `${label} specimen handbook`, content: `${label} winning payload ${i}` }))));
    assert.equal(notes.filter(result => success(result).startsWith("Stored note:")).length, targets.length);
    const updates = await Promise.all(writes.map((params, i) => ({
      root: params.root, id: memoId(results[i]), content: `${params.content} revised`,
    })).map(async params => ({ ...params, undo: recoveryId(await f.call("memory_update", params)) })));
    await Promise.all(updates.map(async ({ root, undo }) =>
      success(await f.call("memory_restore", { root, scope: "local", recoveryId: undo }))));
    for (const { root, workspace, label } of targets) {
      const text = success(await f.call("memory_read", { root, scope: "local" }));
      for (const other of targets.filter(target => target.label !== label)) assert.ok(!text.includes(other.label));
      for (let i = 0; i < 12; i++) assert.ok(text.includes(`${label} durable specimen ${String(i).padStart(3, "0")}`));
      assert.doesNotMatch(text, /revised/);
      const files = await readdir(join(memoryDir(workspace), "notes"));
      assert.equal(files.length, 1);
      const body = success(await f.call("memory_read", { root, scope: "local", path: `notes/${files[0]}` }));
      assert.ok(body.includes(`${label} winning payload 0`), "duplicate note calls must not overwrite the first body");
      for (const other of targets.filter(target => target.label !== label)) assert.ok(!body.includes(other.label));
      assert.deepEqual(await readdir(join(memoryDir(workspace), "recovery")), []);
      assert.match(success(await f.call("memory_status", { root })), /12 facts, 1 notes/);
    }
    assert.match(await f.prompt(), /cedar durable specimen/);
    assert.doesNotMatch(await f.prompt(), /maple|willow/);
    await absent(f.globalDir);
  });

  test("invalid tool slugs are rejected before queues, migration or any writes", async t => {
    const f = await fixture(t);
    const before = await directoryState(f.base);
    const queueStart = host.queueCalls.length;
    for (const slug of ["", "../escape", "notes/topic", "topic.md", "a\\b", "two--parts", "x".repeat(81)]) {
      error(await f.call("memory_store", { scope: "global", title: "Valid title", content: "Valid body", slug }), /invalid slug/i);
      assert.deepEqual(await directoryState(f.base), before, slug);
    }
    assert.equal(host.queueCalls.length, queueStart);
    await absent(f.globalDir);
  });

  for (const kind of ["fact", "note"] as const) {
    test(`first global ${kind} mutation creates the version marker before refreshing the injected snapshot`, async t => {
      const f = await fixture(t);
      await absent(f.globalDir);
      assert.equal(await f.prompt(), "BASE PROMPT");
      const result = await queued([join(f.globalDir, "MEMORY.md")], () => kind === "fact"
        ? f.call("memory_write", { scope: "global", content: "Fresh machine fact sentinel" })
        : f.call("memory_store", { scope: "global", title: "Fresh machine note sentinel", content: "PRIVATE_FRESH_BODY" }));
      const id = memoId(result);
      assert.deepEqual(JSON.parse(await readFile(join(f.globalDir, "pi-remember.json"), "utf8")), { version: CURRENT_VERSION });
      // Do not read, migrate, restart or mutate again before checking this snapshot.
      const prompt = await f.prompt();
      assert.match(prompt, /## Global memory/);
      assert.ok(prompt.includes(id));
      assert.ok(prompt.includes(`Fresh machine ${kind} sentinel`));
      assert.doesNotMatch(prompt, /PRIVATE_FRESH_BODY/);
      if (kind === "note") {
        assert.ok(prompt.includes(notePath(result)));
        await absent(join(f.globalDir, "MEMORY.md"));
      }
      await absent(memoryDir(f.cwd));
    });
  }

  test("note-only global tools read, search, forget and restore without MEMORY.md or body injection", async t => {
    const f = await fixture(t);
    const stored = await f.call("memory_store", { scope: "global", title: "Zirconium ceramic handbook",
      content: "PRIVATE_MULLITE_BODY uses mullite shelves.", slug: "ceramic-protocol" });
    const id = memoId(stored), path = notePath(stored);
    assert.match(path, /^notes\/\d{4}-\d{2}-\d{2}-ceramic-protocol\.md$/);
    const absolute = join(f.globalDir, path);
    const original = await readFile(absolute, "utf8");
    const parsed = parseNote(original)!;
    assert.equal(path.slice(6, 16), parsed.metadata.created.slice(0, 10));
    assert.equal(parsed.body, "PRIVATE_MULLITE_BODY uses mullite shelves.\n");
    assert.equal(parsed.metadata.id, id);
    const backup = await migrationBackup(f.globalDir);
    const catalogue = success(await f.call("memory_read", { scope: "global" }));
    assert.match(catalogue, /Zirconium ceramic handbook/);
    assert.ok(catalogue.includes(id));
    assert.ok(catalogue.includes(path));
    assert.doesNotMatch(catalogue, /PRIVATE_MULLITE_BODY/);
    for (const selector of [{ id }, { path }]) assert.match(success(await f.call("memory_read", { scope: "global", ...selector })), /PRIVATE_MULLITE_BODY/);
    const hits = success(await f.call("memory_search", { scope: "global", query: "mullite" }));
    assert.ok(hits.includes(`[global/${path}] [id=${id}]`));
    assert.equal(hits.split("\n").length, 1, "description and body must not duplicate a note hit");
    const prompt = await f.prompt();
    assert.match(prompt, /Zirconium ceramic handbook/);
    assert.ok(prompt.includes(id) && prompt.includes(path));
    assert.doesNotMatch(prompt, /PRIVATE_MULLITE_BODY|last-modified-date/);
    const deletion = recoveryId(await queued([join(f.globalDir, "MEMORY.md"), absolute],
      () => f.call("memory_forget", { scope: "global", text: id })));
    await absent(absolute);
    error(await f.call("memory_read", { scope: "global", id }), /not found/i);
    error(await f.call("memory_read", { scope: "global", path }), /not found/i);
    for (const query of ["zirconium", "mullite"]) assert.equal(success(await f.call("memory_search", { scope: "global", query })), "No matches in memory.");
    assert.doesNotMatch(await f.prompt(), /Zirconium ceramic handbook/);
    await f.events.get("session_start")!({}, { cwd: f.cwd, hasUI: false });
    assert.doesNotMatch(await f.prompt(), /Zirconium ceramic handbook|PRIVATE_MULLITE_BODY/);
    assert.equal(success(await f.call("memory_search", { scope: "global", query: "mullite" })), "No matches in memory.");
    success(await f.call("memory_restore", { scope: "global", recoveryId: deletion }));
    assert.equal(await readFile(absolute, "utf8"), original);
    assert.match(await f.prompt(), /Zirconium ceramic handbook/);
    assert.doesNotMatch(await f.prompt(), /PRIVATE_MULLITE_BODY/);
    assert.match(success(await f.call("memory_search", { scope: "global", query: "mullite" })), /mullite shelves/);
    assert.equal(await migrationBackup(f.globalDir), backup);
    await absent(join(f.globalDir, "MEMORY.md"));
    assert.deepEqual(await readdir(f.cwd), []);
  });

  test("startup migrates both scopes with backups and injects only derived metadata, unchanged on subsequent turns", async t => {
    const created = "2024-02-03T04:05:06Z";
    const originals = new Map<string, { index: string; note: string; id: string }>();
    const f = await fixture(t, { beforeStart: async ({ cwd, globalDir }) => {
      for (const [dir, id, label] of [[globalDir, "1111aaaa", "Machine"], [memoryDir(cwd), "2222bbbb", "Project"]]) {
        const index = `<!-- keep fact bytes -->\r\n${label} fact with trailing spaces.  \r\n\r\n<!-- ${created} [${id}] -->\r\n#note [[notes/old.md]] ${label} ceramic reference\r\n`;
        const note = `<!-- pi-remember note: ${created} -->\r\n# Generated H1\r\n\r\n# User heading\r\nPRIVATE_${label}_BODY\r\n`;
        originals.set(dir, { index, note, id });
        await putFixtureFile(join(dir, "MEMORY.md"), index);
        await putFixtureFile(join(dir, "notes", "old.md"), note);
      }
    } });
    const prompt = await f.prompt();
    assert.match(prompt, /## Global memory/);
    assert.match(prompt, /## Project memory/);
    assert.match(prompt, /Machine ceramic reference/);
    assert.match(prompt, /Project ceramic reference/);
    assert.doesNotMatch(prompt, /PRIVATE_|User heading|Generated H1|last-modified-date|description:/);
    for (const [dir, original] of originals) {
      const backup = await migrationBackup(dir);
      assert.equal(await readFile(join(backup, "files", "MEMORY.md"), "utf8"), original.index);
      assert.equal(await readFile(join(backup, "files", "notes", "old.md"), "utf8"), original.note);
      assert.equal(await readFile(join(dir, "MEMORY.md"), "utf8"), original.index.slice(0, original.index.indexOf(`<!-- ${created}`)));
      const note = parseNote(await readFile(join(dir, "notes", "old.md"), "utf8"))!;
      assert.equal(note.metadata.id, original.id);
      assert.equal(note.metadata.created, created);
      assert.match(note.body, /^# User heading\r\nPRIVATE_/);
      assert.doesNotMatch(note.body, /Generated H1/);
      assert.ok(prompt.includes(original.id));
    }
    const migrated = await directoryState(f.base);
    for (let i = 0; i < 3; i++) assert.equal(await f.prompt(), prompt);
    await f.events.get("session_start")!({}, { cwd: f.cwd, hasUI: false });
    assert.equal(await f.prompt(), prompt);
    assert.deepEqual(await directoryState(f.base), migrated, "startup must not remigrate an up-to-date store");
    const localNote = join(memoryDir(f.cwd), "notes", "old.md");
    const parsed = parseNote(await readFile(localNote, "utf8"))!;
    await writeFile(localNote, serializeNote(parsed.metadata, "DISK_EDIT_BODY\n"));
    assert.match(success(await f.call("memory_read", { scope: "local", id: "2222bbbb" })), /DISK_EDIT_BODY/);
    assert.match(success(await f.call("memory_search", { scope: "local", query: "DISK_EDIT_BODY" })), /DISK_EDIT_BODY/);
    const afterEdit = await directoryState(f.base);
    assert.equal(await f.prompt(), prompt, "reads and per-turn injection do not rebuild the session snapshot");
    assert.equal(await f.prompt(), prompt);
    assert.deepEqual(await directoryState(f.base), afterEdit);
  });

  for (const firstAccess of ["catalogue", "id", "path", "search", "update", "forget", "restore"] as const) {
    test(`lazy ${firstAccess} access migrates legacy notes and old update/deletion undo end to end`, async t => {
      const f = await fixture(t);
      const dir = memoryDir(f.other), root = f.other;
      const created = "2024-02-03T04:05:06Z";
      const meta = (id: string) => `<!-- ${created} [${id}] manually-authored -->`;
      const old = (body: string) => `<!-- pi-remember note: ${created} -->\r\n# Generated heading\r\n\r\n${body}`;
      const facts = "<!-- keep bytes -->\r\nLegacy fact with spaces.  \r\n\r\n";
      const index = `${facts}${meta("1234abcd")}\r\n#note [[notes/active.md]] Active ceramic reference\r\n`;
      const active = old("Active after body\r\n");
      const deleted = old("Deleted mullite body\r\n");
      const records = {
        "aaaabbbb": { kind: "update", memoId: "1234abcd", noteRel: "notes/active.md", meta: meta("1234abcd"), before: old("# User heading\r\nActive before body\r\n"), after: active },
        "ccccdddd": { entries: [{ meta: meta("5678abcd"), line: "#note [[notes/deleted.md]] Forgotten workshop reference" }] },
        "eeeeffff": { kind: "update", memoId: "5678abcd", noteRel: "notes/deleted.md", meta: meta("5678abcd"), before: old("Deleted before body\r\n"), after: deleted },
      };
      await putFixtureFile(memoryFile(root), index);
      await putFixtureFile(join(dir, "notes", "active.md"), active);
      await putFixtureFile(join(dir, "notes", "deleted.md"), deleted);
      for (const [id, record] of Object.entries(records)) await putFixtureFile(join(dir, "recovery", `${id}.json`),
        JSON.stringify({ id, scope: "local", timestamp: "2025-06-07T08:09:10Z", ...record }));
      await absent(join(dir, "pi-remember.json"));
      const prompt = await f.prompt();
      const target = { root, scope: "local" };
      if (firstAccess === "catalogue") assert.match(success(await f.call("memory_read", target)), /Active ceramic reference/);
      if (firstAccess === "id") assert.match(success(await f.call("memory_read", { ...target, id: "1234abcd" })), /Active after body/);
      if (firstAccess === "path") assert.match(success(await f.call("memory_read", { ...target, path: "notes/active.md" })), /Active after body/);
      if (firstAccess === "search") assert.match(success(await f.call("memory_search", { ...target, query: "Active after" })), /id=1234abcd/);
      if (firstAccess === "update" || firstAccess === "forget") {
        const changed = firstAccess === "update"
          ? await f.call("memory_update", { ...target, id: "1234abcd", content: "Temporary replacement body" })
          : await f.call("memory_forget", { ...target, text: "1234abcd" });
        const undo = recoveryId(changed);
        success(await f.call("memory_restore", { ...target, recoveryId: undo }));
      }
      if (firstAccess === "restore") success(await f.call("memory_restore", { ...target, recoveryId: "aaaabbbb" }));
      const backup = await migrationBackup(dir);
      assert.equal(await readFile(join(backup, "files", "MEMORY.md"), "utf8"), index);
      assert.equal(await readFile(join(backup, "files", "notes", "active.md"), "utf8"), active);
      assert.equal(await readFile(join(backup, "files", "notes", "deleted.md"), "utf8"), deleted);
      for (const id of Object.keys(records)) assert.deepEqual(JSON.parse(await readFile(join(backup, "files", "recovery", `${id}.json`), "utf8")),
        { id, scope: "local", timestamp: "2025-06-07T08:09:10Z", ...records[id as keyof typeof records] });
      assert.equal(await readFile(memoryFile(root), "utf8"), facts);
      await absent(join(dir, "notes", "deleted.md"));
      assert.doesNotMatch(success(await f.call("memory_read", target)), /Forgotten workshop reference/);
      assert.equal(success(await f.call("memory_search", { ...target, query: "mullite" })), "No matches in memory.");
      assert.equal(await f.prompt(), prompt, "foreign store migration must not change current injection");
      if (firstAccess !== "restore") success(await f.call("memory_restore", { ...target, recoveryId: "aaaabbbb" }));
      const activeRead = success(await f.call("memory_read", { ...target, id: "1234abcd" }));
      assert.match(activeRead, /Active before body/);
      const activeNote = parseNote(await readFile(join(dir, "notes", "active.md"), "utf8"))!;
      assert.equal(activeNote.body, "# User heading\r\nActive before body\r\n");
      assert.equal(activeNote.metadata.id, "1234abcd");
      assert.equal(activeNote.metadata.description, "Active ceramic reference");
      assert.equal(activeNote.metadata.created, created);
      success(await f.call("memory_restore", { ...target, recoveryId: "ccccdddd" }));
      assert.match(success(await f.call("memory_read", { ...target, id: "5678abcd" })), /Deleted mullite body/);
      assert.match(success(await f.call("memory_search", { ...target, query: "mullite" })), /id=5678abcd/);
      success(await f.call("memory_restore", { ...target, recoveryId: "eeeeffff" }));
      const restored = parseNote(await readFile(join(dir, "notes", "deleted.md"), "utf8"))!;
      assert.equal(restored.body, "Deleted before body\r\n");
      assert.equal(restored.metadata.id, "5678abcd");
      assert.equal(restored.metadata.created, created);
      assert.equal(restored.metadata.description, "Forgotten workshop reference");
      assert.equal(await readFile(memoryFile(root), "utf8"), facts, "restoring notes must not reintroduce index references");
      assert.deepEqual(await readdir(join(dir, "recovery")), []);
      assert.equal(await migrationBackup(dir), backup);
      const after = await directoryState(root);
      success(await f.call("memory_read", target));
      success(await f.call("memory_search", { ...target, query: "ceramic" }));
      assert.deepEqual(await directoryState(root), after, "reads after one-time migration are observational");
      assert.equal(await f.prompt(), prompt);
      await absent(memoryDir(f.cwd));
      await absent(f.globalDir);
    });
  }

  test("healthy-scope mutations must not re-inject a future-version store rejected at startup", async t => {
    const f = await fixture(t, { beforeStart: async ({ cwd }) => {
      const dir = memoryDir(cwd);
      await putFixtureFile(join(dir, "pi-remember.json"), JSON.stringify({ version: CURRENT_VERSION + 1 }));
      await putFixtureFile(join(dir, "MEMORY.md"), "<!-- 2024-01-01T00:00:00Z [11112222] -->\nREJECTED_FUTURE_FACT\n");
      await putFixtureFile(join(dir, "notes", "future.md"), serializeNote({ id: parseMemoId("33334444")!, description: "REJECTED_FUTURE_DESCRIPTION",
        created: "2024-01-01T00:00:00Z", modified: "2025-01-01T00:00:00Z" }, "PRIVATE_FUTURE_BODY\n"));
    } });
    assert.equal(await f.prompt(), "BASE PROMPT");
    const futureBefore = await directoryState(memoryDir(f.cwd));
    success(await f.call("memory_write", { scope: "global", content: "Healthy global fact remains available" }));
    assert.deepEqual(await directoryState(memoryDir(f.cwd)), futureBefore);
    const prompt = await f.prompt();
    assert.match(prompt, /Healthy global fact remains available/);
    assert.doesNotMatch(prompt, /REJECTED_FUTURE_FACT|REJECTED_FUTURE_DESCRIPTION|PRIVATE_FUTURE_BODY/);
  });

  test("future versions reject tool reads and writes repeatedly without altering data or injecting startup content", async t => {
    const f = await fixture(t, { beforeStart: async ({ cwd, globalDir }) => {
      for (const dir of [memoryDir(cwd), globalDir]) {
        await putFixtureFile(join(dir, "pi-remember.json"), JSON.stringify({ version: CURRENT_VERSION + 1 }));
        await putFixtureFile(join(dir, "MEMORY.md"), "<!-- 2024-01-01T00:00:00Z [11112222] -->\nFUTURE_FACT_SENTINEL\n");
        await putFixtureFile(join(dir, "notes", "future.md"), serializeNote({ id: parseMemoId("33334444")!, description: "FUTURE_NOTE_SENTINEL",
          created: "2024-01-01T00:00:00Z", modified: "2025-01-01T00:00:00Z" }, "FUTURE_BODY_SENTINEL\n"));
        await putFixtureFile(join(dir, "recovery", "aaaabbbb.json"), JSON.stringify({ id: "aaaabbbb", scope: dir === globalDir ? "global" : "local",
          timestamp: "2025-01-01T00:00:00Z", kind: "forget", entries: [{ line: "Deleted future fact" }] }));
      }
    } });
    const before = await directoryState(f.base);
    assert.equal(await f.prompt(), "BASE PROMPT");
    const cases: [string, Record<string, unknown>][] = [
      ["memory_read", {}], ["memory_read", { id: "33334444" }], ["memory_read", { path: "notes/future.md" }],
      ["memory_read", { query: "FUTURE" }], ["memory_search", { query: "FUTURE" }],
      ["memory_write", { content: "Must not append this fact" }],
      ["memory_store", { title: "Must not create note", slug: "blocked", content: "No writes" }],
      ["memory_update", { id: "33334444", content: "Must not replace body" }],
      ["memory_forget", { text: "FUTURE" }], ["memory_restore", { recoveryId: "aaaabbbb" }],
    ];
    for (const scope of ["local", "global"] as const) {
      for (const [name, params] of cases) {
        error(await f.call(name, { ...params, scope }), /future store version/i);
        assert.deepEqual(await directoryState(f.base), before, `${scope} ${name} must not change data`);
      }
    }
    error(await f.call("memory_init"), /future store version/i);
    success(await f.call("memory_status")); // Diagnostic inspection deliberately does not migrate.
    assert.deepEqual(await directoryState(f.base), before);
    assert.equal(await f.prompt(), "BASE PROMPT");
    // A previously successful version check must not be permanently cached.
    const marker = join(f.globalDir, "pi-remember.json");
    await writeFile(marker, JSON.stringify({ version: CURRENT_VERSION }));
    assert.match(success(await f.call("memory_read", { scope: "global", id: "33334444" })), /FUTURE_BODY_SENTINEL/);
    await writeFile(marker, JSON.stringify({ version: CURRENT_VERSION + 1 }));
    const futureAgain = await directoryState(f.base);
    error(await f.call("memory_read", { scope: "global" }), /future store version/i);
    error(await f.call("memory_write", { scope: "global", content: "Still blocked" }), /future store version/i);
    assert.deepEqual(await directoryState(f.base), futureAgain);
  });
});
