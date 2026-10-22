import { strict as assert } from "node:assert";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import {
  appendEntry,
  entryId,
  parseEntries,
  parseMemoId,
  readMemo,
  readMemoryText,
  readCatalogue,
  resolveNotePath,
  resolveStores,
  restoreEntry,
  updateMemo,
  writeNote,
  type StorePaths,
} from "../store.ts";

// All fixtures live under this root, including files used as escape targets.
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-remember-revision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = resolveStores(join(root, "project"), join(root, "global"), ".pi");
  for (const store of Object.values(stores)) await mkdir(store.dir, { recursive: true });
  return { root, stores, local: stores.local, global: stores.global };
}

async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

const meta = (id: string) => `<!-- 2024-02-03T04:05:06Z [${id}] manually-authored -->`;
const fact = (id: string, line = "Original fact") => `${meta(id)}\n${line}\n`;
const noteIndex = (id: string, rel = "notes/old-name.md", title = "Stable title") =>
  fact(id, `#note [[${rel}]] ${title}`);
const managedHeader = "<!-- pi-remember note: 2024-02-03T04:05:06Z -->\r\n# Original title\r\n\r\n";

// Snapshot bytes and directory membership, not just parsed entries: this catches
// orphan creation, recovery rewrites, newline conversion, and lost metadata.
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      const key = relative(root, child);
      const info = await lstat(child);
      if (info.isSymbolicLink()) result[key] = `symlink:${await readlink(child)}`;
      else if (info.isDirectory()) {
        result[key] = "directory";
        await walk(child);
      } else result[key] = (await readFile(child)).toString("base64");
    }
  }
  await walk(root);
  return result;
}

function assertError(result: { status: string; message?: string }, pattern?: RegExp) {
  assert.equal(result.status, "error");
  assert.equal(typeof result.message, "string");
  assert.ok(result.message!.length > 0);
  if (pattern) assert.match(result.message!, pattern);
}

// Same path-keyed queue contract used by the caller, without importing Pi.
function mutationQueue(paths: string[] = []) {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(path: string, operation: () => Promise<T>): Promise<T> => {
    paths.push(path);
    const next = (tails.get(path) ?? Promise.resolve()).then(operation);
    tails.set(path, next.catch(() => undefined));
    return next;
  };
}

async function recoveryFile(store: StorePaths, id: string, record: unknown) {
  const path = join(store.recoveryDir, `${id}.json`);
  await put(path, JSON.stringify(record));
  return path;
}

// Malformed records are boundary failures, not conflicts. Accept an explicit
// error result or the store's specialized validation exception, never success.
async function assertInvalidRecovery(operation: () => ReturnType<typeof restoreEntry>) {
  try {
    const result = await operation();
    assert.ok(result, "invalid recovery must not be reported as missing");
    assertError(result);
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "InvalidRecoveryRecordError");
  }
}

test("revision: IDs are exact hexadecimal metadata IDs, not line text or timestamps", () => {
  assert.equal(parseMemoId("ABCDef09"), "abcdef09");
  for (const invalid of ["", "abcdef0", "abcdef012", "abcdefgh", " abcdef01", "abcdef01\n", "[abcdef01]", "../abcdef01"])
    assert.equal(parseMemoId(invalid), null, invalid);
  assert.equal(entryId({ meta: meta("ABCD1234"), line: "A fact" }), "abcd1234");
  assert.equal(entryId({ line: "Mention [abcd1234] without metadata" }), null);
  assert.equal(entryId({ meta: "<!-- 2024-02-03T04:05:06Z -->", line: "Legacy fact" }), null);
  assert.equal(entryId({ meta: "<!-- [not-an-id] -->", line: "Fact" }), null);
});

test("revision: readMemo finds manually authored IDs and exposes exact CRLF spans", async (t) => {
  const { stores, local, root } = await fixture(t);
  const text = `Legacy without ID  \r\n\r\n${meta("ABCD1234")}\r\nTarget fact\t  \r\n\r\n${meta("11223344")}\r\nUnrelated fact\r\n`;
  await put(local.memoryFile, text);
  const before = await snapshot(root);
  const result = await readMemo(stores, "abcd1234", ["local"]);
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.deepEqual(result.store, local);
  assert.equal(result.text, text);
  assert.deepEqual(result.entry, { meta: meta("ABCD1234"), line: "Target fact" });
  assert.equal(result.start, text.indexOf("Target fact"));
  assert.equal(result.end, result.start + "Target fact\t  ".length);
  assert.equal(text.slice(result.start, result.end), "Target fact\t  ");
  assert.equal(result.noteRel, undefined);
  assert.equal(result.notePath, undefined);
  assert.equal(result.noteText, undefined);
  assert.deepEqual(await snapshot(root), before);
});

test("revision: new facts and notes return IDs that read back from metadata", async (t) => {
  const { stores, local, global } = await fixture(t);
  const appended = await appendEntry(local, "\n A brand new fact\t with whitespace  ");
  assert.equal(appended.duplicate, false);
  assert.ok(appended.id);
  assert.equal(parseMemoId(appended.id), appended.id);
  const readFact = await readMemo(stores, appended.id);
  assert.equal(readFact.status, "found");
  if (readFact.status !== "found") return;
  assert.equal(entryId(readFact.entry), appended.id);
  assert.equal(readFact.entry.line, "A brand new fact with whitespace");

  const written = await writeNote(global, "Fresh note", "Fresh body");
  assert.equal(written.duplicate, false);
  assert.ok(written.id);
  assert.ok(written.notePath);
  assert.ok(written.noteRel);
  const readNote = await readMemo(stores, written.id);
  assert.equal(readNote.status, "found");
  if (readNote.status !== "found") return;
  assert.equal(readNote.store.scope, "global");
  assert.equal(entryId(readNote.entry), written.id);
  assert.equal(readNote.notePath, written.notePath);
  assert.equal(readNote.noteRel, written.noteRel);
  assert.equal(readNote.noteText, await readFile(written.notePath, "utf8"));
});

test("revision: invalid, missing and legacy no-ID lookups do not mutate storage", async (t) => {
  const { root, stores, local } = await fixture(t);
  await put(local.memoryFile, "Legacy fact [deadbeef] without an ID comment\n");
  const before = await snapshot(root);
  assertError(await readMemo(stores, "not-an-id"), /invalid/i);
  assertError(await readMemo(stores, "deadbeef"), /not found/i);
  assertError(await readMemo(stores, "cafebabe", ["global"]), /not found/i);
  assertError(await updateMemo(local, "deadbeef", "Replacement"), /not found/i);
  assert.deepEqual(await snapshot(root), before);
});

test("revision: duplicate IDs across scopes require scope; same-scope duplicates remain errors", async (t) => {
  const { root, stores, local, global } = await fixture(t);
  await put(local.memoryFile, fact("1234abcd", "Local fact"));
  await put(global.memoryFile, fact("1234abcd", "Global fact"));
  assertError(await readMemo(stores, "1234ABCD"), /ambiguous/i);
  for (const scope of ["local", "global"] as const) {
    const result = await readMemo(stores, "1234abcd", [scope]);
    assert.equal(result.status, "found");
    if (result.status === "found") {
      assert.equal(result.store.scope, scope);
      assert.equal(result.entry.line, scope === "local" ? "Local fact" : "Global fact");
    }
  }
  await put(local.memoryFile, fact("1234abcd", "First local") + fact("1234ABCD", "Second local"));
  const before = await snapshot(root);
  assertError(await readMemo(stores, "1234abcd", ["local"]), /ambiguous/i);
  assertError(await updateMemo(local, "1234abcd", "Must not replace either"), /ambiguous/i);
  assert.deepEqual(await snapshot(root), before);
});

test("revision: colliding relative note paths are scoped; absolute paths identify a store", async (t) => {
  const { stores, local, global } = await fixture(t);
  for (const store of [local, global]) {
    await put(join(store.notesDir, "old-name.md"), `${store.scope} body\n`);
    await put(store.memoryFile, noteIndex(store.scope === "local" ? "11112222" : "33334444"));
  }
  assertError(resolveNotePath(stores, "notes/old-name.md"), /ambiguous/i);
  for (const store of [local, global]) {
    const scoped = resolveNotePath(stores, "notes/old-name.md", [store.scope]);
    assert.equal(scoped.status, "found");
    if (scoped.status !== "found") continue;
    assert.deepEqual(scoped.store, store);
    assert.equal(scoped.rel, "notes/old-name.md");
    assert.equal(scoped.absPath, join(store.notesDir, "old-name.md"));
    assert.deepEqual(resolveNotePath(stores, scoped.absPath), scoped);
    const memo = await readMemo(stores, store.scope === "local" ? "11112222" : "33334444");
    assert.equal(memo.status, "found");
    if (memo.status === "found") assert.equal(memo.noteText, `${store.scope} body\n`);
  }
});

test("revision: a missing indexed note fails lookup/update without creating a file", async (t) => {
  const { root, stores, local } = await fixture(t);
  await put(local.memoryFile, noteIndex("0123abcd", "notes/missing.md"));
  const before = await snapshot(root);
  assertError(resolveNotePath(stores, "notes/missing.md"));
  assertError(await readMemo(stores, "0123abcd"));
  assertError(await updateMemo(local, "0123abcd", "Do not recreate missing note"));
  assert.deepEqual(await snapshot(root), before);
});

for (const scenario of ["traversal", "absolute", "sibling-prefix", "note-symlink", "directory-symlink", "outside-notes"] as const) {
  test(`revision: unsafe note reference (${scenario}) never reads or overwrites the escape target`, async (t) => {
    const { root, stores, local } = await fixture(t);
    const outside = join(root, "outside", "secret.md");
    const sibling = join(`${local.dir}-sibling`, "secret.md");
    await put(outside, "Outside must stay private\n");
    await put(sibling, "Sibling must stay private\n");
    await mkdir(local.notesDir, { recursive: true });
    let ref: string;
    switch (scenario) {
      case "traversal": ref = relative(local.dir, outside); break;
      case "absolute": ref = outside; break;
      case "sibling-prefix": ref = sibling; break;
      case "note-symlink":
        await symlink(outside, join(local.notesDir, "escape.md"));
        ref = "notes/escape.md";
        break;
      case "directory-symlink":
        await symlink(dirname(outside), join(local.notesDir, "linked"));
        ref = "notes/linked/secret.md";
        break;
      case "outside-notes":
        await put(join(local.dir, "private.md"), "Inside store but not a note\n");
        ref = "notes/../private.md";
        break;
    }
    await put(local.memoryFile, noteIndex("abcdef01", ref));
    const before = await snapshot(root);
    if (scenario !== "outside-notes") assertError(resolveNotePath(stores, ref, ["local"]));
    assertError(await readMemo(stores, "abcdef01", ["local"]));
    assertError(await updateMemo(local, "abcdef01", "Never write here"));
    assert.deepEqual(await snapshot(root), before);
  });
}

test("revision: duplicate note preflight preserves existing ID/path/body and old orphans", async (t) => {
  const { root, stores, local } = await fixture(t);
  const rel = "notes/1999-12-31-hand-authored.md";
  const index = `Legacy line without an ID\r\n\r\n${noteIndex("aabbccdd", rel, "Build system quirks").replace(/\n/g, "\r\n")}`;
  await put(local.memoryFile, index);
  await put(join(local.dir, rel), "# Hand-authored heading\n\nOriginal details\n");
  const today = new Date().toISOString().slice(0, 10);
  await put(join(local.notesDir, `${today}-build-system-quirks.md`), "Old orphan: must not be overwritten\n");
  const before = await snapshot(root);
  for (const title of ["Build system quirks", " build SYSTEM quirks ", "Build system", "Build system quirks and workarounds"]) {
    const duplicate = await writeNote(local, title, "Ignored replacement body");
    assert.equal(duplicate.duplicate, true, title);
    assert.equal(duplicate.id, "aabbccdd");
    assert.equal(duplicate.noteRel, rel);
    assert.equal(duplicate.indexLine, `#note [[${rel}]] Build system quirks`);
    assert.equal(entryId(duplicate.existing![0]), "aabbccdd");
    assert.deepEqual(await snapshot(root), before, title);
  }
  const memo = await readMemo(stores, "aabbccdd");
  assert.equal(memo.status, "found");
  if (memo.status === "found") assert.equal(memo.noteText, "# Hand-authored heading\n\nOriginal details\n");
});

test("revision: duplicate missing-note and legacy fact indexes do not create notes or metadata IDs", async (t) => {
  const { root, local } = await fixture(t);
  await put(local.memoryFile, noteIndex("01020304", "notes/gone.md", "Missing note topic") + "Legacy fact topic\n");
  const before = await snapshot(root);
  const missing = await writeNote(local, "Missing note topic", "Do not recreate");
  assert.equal(missing.duplicate, true);
  assert.equal(missing.id, "01020304");
  assert.equal(missing.noteRel, "notes/gone.md");
  const legacy = await writeNote(local, "Legacy fact topic", "Do not invent an ID");
  assert.equal(legacy.duplicate, true);
  assert.equal(legacy.id, undefined);
  assert.deepEqual(await snapshot(root), before);
});

test("revision: fresh note storage avoids an existing unindexed slug file", async (t) => {
  const { local } = await fixture(t);
  const day = new Date().toISOString().slice(0, 10);
  const orphan = join(local.notesDir, `${day}-collision-title.md`);
  await put(orphan, "Historical orphan bytes\r\n");
  const result = await writeNote(local, "Collision title", "New content");
  assert.equal(result.duplicate, false);
  assert.ok(result.notePath);
  assert.notEqual(result.notePath, orphan);
  assert.equal(await readFile(orphan, "utf8"), "Historical orphan bytes\r\n");
  assert.match(await readFile(result.notePath, "utf8"), /New content/);
  assert.equal(parseEntries(await readCatalogue(local)).length, 1);
  await assert.rejects(readFile(local.memoryFile), { code: "ENOENT" });
});

test("revision: targeted fact update/restore preserves all unrelated bytes, CRLF, metadata and no-ID lines", async (t) => {
  const { stores, local, global } = await fixture(t);
  const prefix = `Legacy no-ID fact\t  \r\n\r\n${meta("cafe1234")}\r\n`;
  const originalLine = "Original target fact\t  ";
  const suffix = `\r\n\r\n${meta("abcd5678")}\r\nUnrelated fact\t\r\n\r\n<!-- trailing comment -->\r\n`;
  const original = prefix + originalLine + suffix;
  await put(local.memoryFile, original);
  await put(global.memoryFile, fact("cafe1234", "Global collision must remain untouched"));
  const globalBefore = await readFile(global.memoryFile);
  const queuePaths: string[] = [];
  const queue = mutationQueue(queuePaths);
  // Caller owns the memory-file queue; updateMemo must not reacquire it.
  const result = await queue(local.memoryFile, () => updateMemo(local, "CAFE1234", "\n Revised\t fact\r\n with   spaces \n", queue));
  assert.equal(result.status, "updated");
  if (result.status !== "updated") return;
  assert.equal(result.entry.line, "Revised fact with spaces");
  assert.equal(result.entry.meta, meta("cafe1234"));
  assert.deepEqual(queuePaths, [local.memoryFile]);
  assert.equal(await readMemoryText(local), prefix + "Revised fact with spaces" + suffix);
  assert.deepEqual(await readFile(global.memoryFile), globalBefore);
  const recordPath = join(local.recoveryDir, `${result.recoveryId}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(record.kind, "update");
  assert.equal(record.memoId, "cafe1234");
  assert.equal(record.before, originalLine);
  assert.equal(record.after, "Revised fact with spaces");
  assert.equal(record.meta, meta("cafe1234"));
  const restored = await restoreEntry(stores, result.recoveryId, queue);
  assert.ok(restored);
  assert.equal(restored.status, "restored");
  if (restored.status === "restored") {
    assert.equal(restored.scope, "local");
    assert.deepEqual(restored.entries, [{ meta: meta("cafe1234"), line: "Original target fact" }]);
  }
  assert.equal(await readMemoryText(local), original);
  assert.deepEqual(await readFile(global.memoryFile), globalBefore);
  assert.deepEqual(await readdir(local.recoveryDir), []);
  assert.equal(await restoreEntry(stores, result.recoveryId), null);
});

test("revision: fact size validation uses the normalized single line, accepting exactly 300 characters", async (t) => {
  const { root, local } = await fixture(t);
  await put(local.memoryFile, fact("abcdef12"));
  let before = await snapshot(root);
  for (const invalid of ["", " \t\r\n ", "x".repeat(301), "#note [[notes/fake.md]] Invalid conversion"]) {
    assertError(await updateMemo(local, "abcdef12", invalid));
    assert.deepEqual(await snapshot(root), before);
  }
  const valid = "x".repeat(149) + " " + "y".repeat(150);
  const result = await updateMemo(local, "abcdef12", ` \n${"x".repeat(149)}\t\n  ${"y".repeat(150)}\r\n`);
  assert.equal(result.status, "updated");
  if (result.status === "updated") assert.equal(result.entry.line, valid);
  before = await snapshot(root);
  const unchanged = await updateMemo(local, "abcdef12", valid);
  assert.equal(unchanged.status, "unchanged");
  assert.deepEqual(await snapshot(root), before);
});

for (const preexistingRecovery of [false, true]) {
  test(`revision: blank/unchanged fact and note updates leave recovery ${preexistingRecovery ? "bytes" : "directory absence"} unchanged`, async (t) => {
    const { root, local } = await fixture(t);
    await put(local.memoryFile, fact("1111aaaa", "Same fact") + noteIndex("2222bbbb"));
    await put(join(local.notesDir, "old-name.md"), managedHeader + "Body stays\r\n\r\n");
    if (preexistingRecovery) await put(join(local.recoveryDir, "deadbeef.json"), "Existing opaque record\r\n");
    const before = await snapshot(root);
    const factResult = await updateMemo(local, "1111aaaa", " \nSame\t fact  ");
    assert.equal(factResult.status, "unchanged");
    const noteResult = await updateMemo(local, "2222bbbb", " \nBody stays\t\n ");
    assert.equal(noteResult.status, "unchanged");
    assertError(await updateMemo(local, "1111aaaa", "\t\n"));
    assertError(await updateMemo(local, "2222bbbb", "\r\n "));
    assert.deepEqual(await snapshot(root), before);
  });
}

test("revision: note update replaces only body, retaining managed header/title, ID, filename and index bytes", async (t) => {
  const { stores, local } = await fixture(t);
  const index = `Legacy fact\t\r\n\r\n${noteIndex("9876abcd").replace(/\n/g, "\r\n")}\r\n${fact("7654abcd", "Another fact").replace(/\n/g, "\r\n")}`;
  const notePath = join(local.notesDir, "old-name.md");
  const original = managedHeader + "Original body\r\n\r\n## Old section\r\nDetails\r\n";
  await put(local.memoryFile, index);
  await put(notePath, original);
  const paths: string[] = [];
  const queue = mutationQueue(paths);
  const body = "New body\n\n## New section\n" + "Detailed text ".repeat(40);
  const result = await queue(local.memoryFile, () => updateMemo(local, "9876abcd", ` \n${body}\n\t`, queue));
  assert.equal(result.status, "updated");
  if (result.status !== "updated") return;
  assert.deepEqual(paths, [local.memoryFile, notePath]);
  assert.equal(await readFile(notePath, "utf8"), managedHeader + body.trim() + "\n");
  assert.equal(await readMemoryText(local), index);
  assert.equal(entryId(result.entry), "9876abcd");
  assert.equal(result.entry.line, "#note [[notes/old-name.md]] Stable title");
  const lookup = await readMemo(stores, "9876abcd");
  assert.equal(lookup.status, "found");
  if (lookup.status === "found") {
    assert.equal(lookup.noteRel, "notes/old-name.md");
    assert.equal(lookup.notePath, notePath);
    assert.equal(lookup.noteText, managedHeader + body.trim() + "\n");
  }
  const restored = await restoreEntry(stores, result.recoveryId, queue);
  assert.ok(restored);
  assert.equal(restored.status, "restored");
  assert.deepEqual(paths, [local.memoryFile, notePath, local.memoryFile, notePath]);
  assert.equal(await readFile(notePath, "utf8"), original);
  assert.equal(await readMemoryText(local), index);
  assert.deepEqual(await readdir(local.recoveryDir), []);
});

test("revision: a legacy note without managed header is all body, and undo recovers exact original bytes", async (t) => {
  const { stores, local } = await fixture(t);
  await put(local.memoryFile, noteIndex("abcdef98"));
  const path = join(local.notesDir, "old-name.md");
  const original = "Legacy prose without a heading\r\n\r\nMore prose, no final newline";
  await put(path, original);
  const result = await updateMemo(local, "abcdef98", "Replacement body");
  assert.equal(result.status, "updated");
  if (result.status !== "updated") return;
  assert.equal(await readFile(path, "utf8"), "Replacement body\n");
  assert.equal((await restoreEntry(stores, result.recoveryId))?.status, "restored");
  assert.equal(await readFile(path, "utf8"), original);
});

test("revision: queued note edit racing update is detected before creating recovery", async (t) => {
  const { root, local } = await fixture(t);
  await put(local.memoryFile, noteIndex("1111bbbb"));
  const path = join(local.notesDir, "old-name.md");
  await put(path, managedHeader + "Before\n");
  const paths: string[] = [];
  const interveningQueue = async <T>(queuedPath: string, operation: () => Promise<T>) => {
    paths.push(queuedPath);
    await put(path, managedHeader + "Intervening edit\n");
    return operation();
  };
  const indexBefore = await readFile(local.memoryFile);
  const result = await updateMemo(local, "1111bbbb", "Requested replacement", interveningQueue);
  assertError(result, /changed/i);
  assert.deepEqual(paths, [path]);
  assert.equal(await readFile(path, "utf8"), managedHeader + "Intervening edit\n");
  assert.deepEqual(await readFile(local.memoryFile), indexBefore);
  assert.equal((await snapshot(root))[relative(root, local.recoveryDir)], undefined);
});

for (const scenario of ["fact-edited", "fact-removed", "metadata-edited", "note-edited", "note-removed", "reference-edited"] as const) {
  test(`revision: update undo retains recovery and refuses later change (${scenario})`, async (t) => {
    const { root, stores, local } = await fixture(t);
    const isNote = scenario.startsWith("note-") || scenario === "reference-edited";
    const path = join(local.notesDir, "old-name.md");
    await put(local.memoryFile, isNote ? noteIndex("decaf123") : fact("decaf123"));
    if (isNote) await put(path, managedHeader + "Original note\n");
    const updated = await updateMemo(local, "decaf123", "Updated content");
    assert.equal(updated.status, "updated");
    if (updated.status !== "updated") return;
    switch (scenario) {
      case "fact-edited": await put(local.memoryFile, fact("decaf123", "Later user fact")); break;
      case "fact-removed": await put(local.memoryFile, "Only a legacy fact remains\n"); break;
      case "metadata-edited":
        await put(local.memoryFile, `${meta("decaf123").replace("manually-authored", "changed")}\nUpdated content\n`);
        break;
      case "note-edited": await put(path, managedHeader + "Later user note\n"); break;
      case "note-removed": await rm(path); break;
      case "reference-edited":
        await put(join(local.notesDir, "new-reference.md"), managedHeader + "Updated content\n");
        await put(local.memoryFile, noteIndex("decaf123", "notes/new-reference.md"));
        break;
    }
    const before = await snapshot(root);
    const result = await restoreEntry(stores, updated.recoveryId);
    assert.ok(result);
    assertError(result);
    assert.deepEqual(await snapshot(root), before);
    assert.ok(await readFile(join(local.recoveryDir, `${updated.recoveryId}.json`), "utf8"));
  });
}

test("revision: update undo preserves unrelated edits made after update", async (t) => {
  const { stores, local } = await fixture(t);
  await put(local.memoryFile, fact("abcd0001") + "Legacy original\n");
  const updated = await updateMemo(local, "abcd0001", "Revised target");
  assert.equal(updated.status, "updated");
  if (updated.status !== "updated") return;
  const laterSuffix = "\r\nLegacy unrelated changed  \r\n" + fact("abcd0002", "Later added fact");
  await put(local.memoryFile, fact("abcd0001", "Revised target") + laterSuffix);
  assert.equal((await restoreEntry(stores, updated.recoveryId))?.status, "restored");
  assert.equal(await readMemoryText(local), fact("abcd0001") + laterSuffix);
});

test("revision: legacy deletion JSON without kind restores ID and no-ID entries without reserializing current index", async (t) => {
  const { root, stores, local } = await fixture(t);
  const current = `Legacy existing\t \r\n\r\n${meta("aaaabbbb")}\r\nCurrent fact without final newline`;
  await put(local.memoryFile, current);
  const entries = [
    { meta: meta("01234567"), line: "Deleted identified fact" },
    { line: "Deleted legacy fact" },
  ];
  await recoveryFile(local, "fedcba98", { id: "fedcba98", scope: "local", timestamp: "2024-02-03T04:05:06Z", entries });
  const restored = await restoreEntry(stores, "FEDCBA98");
  assert.ok(restored);
  assert.equal(restored.status, "restored");
  if (restored.status === "restored") {
    assert.equal(restored.scope, "local");
    assert.deepEqual(restored.entries, entries);
  }
  assert.equal(await readMemoryText(local), `${current}\n${meta("01234567")}\nDeleted identified fact\n\nDeleted legacy fact\n`);
  assert.deepEqual(await readdir(local.recoveryDir), []);
  const before = await snapshot(root);
  assert.equal(await restoreEntry(stores, "fedcba98"), null);
  for (const id of ["not-an-id", "../../fedcba98", "12345678"]) assert.equal(await restoreEntry(stores, id), null);
  assert.deepEqual(await snapshot(root), before);
});

test("revision: legacy deletion restore can create a missing index", async (t) => {
  const { stores, global } = await fixture(t);
  const entries = [{ line: "Recovered legacy fact" }];
  await recoveryFile(global, "abcdef90", { id: "abcdef90", scope: "global", entries });
  const result = await restoreEntry(stores, "abcdef90");
  assert.ok(result);
  assert.equal(result.status, "restored");
  if (result.status === "restored") assert.equal(result.scope, "global");
  assert.equal(await readMemoryText(global), "Recovered legacy fact\n");
});

for (const collision of ["id", "line"] as const) {
  test(`revision: deletion restore rejects existing ${collision} and retains the whole record`, async (t) => {
    const { root, stores, local } = await fixture(t);
    await put(local.memoryFile, fact("123456ab", "Existing fact"));
    const entries = [
      collision === "id" ? { meta: meta("123456ab"), line: "Different line, same ID" } : { line: "Existing fact" },
      { line: "Nonconflicting entry must not be partly restored" },
    ];
    await recoveryFile(local, "123456cd", { id: "123456cd", scope: "local", entries });
    const before = await snapshot(root);
    const result = await restoreEntry(stores, "123456cd");
    assert.ok(result);
    assertError(result, /already exists|duplicate|conflict/i);
    assert.deepEqual(await snapshot(root), before);
  });
}

test("revision: ambiguous recovery IDs across scopes do not choose the first record", async (t) => {
  const { root, stores, local, global } = await fixture(t);
  for (const store of [local, global]) {
    await put(store.memoryFile, `${store.scope} existing\n`);
    await recoveryFile(store, "a1b2c3d4", { id: "a1b2c3d4", scope: store.scope, entries: [{ line: `${store.scope} recovered` }] });
  }
  const before = await snapshot(root);
  const result = await restoreEntry(stores, "a1b2c3d4");
  assert.ok(result);
  assertError(result, /ambiguous/i);
  assert.deepEqual(await snapshot(root), before);
});

test("revision: queued simultaneous restores consume a recovery record only once", async (t) => {
  const { stores, local } = await fixture(t);
  await put(local.memoryFile, fact("1234abcd"));
  const updated = await updateMemo(local, "1234abcd", "Revised fact");
  assert.equal(updated.status, "updated");
  if (updated.status !== "updated") return;
  const paths: string[] = [];
  const queue = mutationQueue(paths);
  const results = await Promise.all([
    restoreEntry(stores, updated.recoveryId, queue),
    restoreEntry(stores, updated.recoveryId, queue),
  ]);
  assert.equal(results.filter((result) => result?.status === "restored").length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
  assert.ok(paths.every((path) => path === local.memoryFile));
  assert.equal(await readMemoryText(local), fact("1234abcd"));
  assert.deepEqual(await readdir(local.recoveryDir), []);
});

const recoveryId = "badc0ffe";
const validDeletion = { id: recoveryId, scope: "local", entries: [{ line: "Deleted fact" }] };
const validUpdate = {
  id: recoveryId, scope: "local", kind: "update", memoId: "0101abcd",
  before: "Original fact", after: "Updated fact", meta: meta("0101abcd"),
};
const malformedRecords: [string, unknown][] = [
  ["null", null],
  ["array", []],
  ["wrong ID", { ...validDeletion, id: "12345678" }],
  ["wrong scope", { ...validDeletion, scope: "global" }],
  ["unknown kind", { ...validDeletion, kind: "unrecognized" }],
  ["missing entries", { id: recoveryId, scope: "local" }],
  ["entries not array", { ...validDeletion, entries: {} }],
  ["null entry", { ...validDeletion, entries: [null] }],
  ["numeric line", { ...validDeletion, entries: [{ line: 42 }] }],
  ["multiline line", { ...validDeletion, entries: [{ line: "Fact\nInjected entry" }] }],
  ["multiline metadata", { ...validDeletion, entries: [{ line: "Fact", meta: "<!-- meta -->\rInjected" }] }],
  ["non-string metadata", { ...validDeletion, entries: [{ line: "Fact", meta: false }] }],
  ["invalid update memo ID", { ...validUpdate, memoId: "not-an-id" }],
  ["missing update before", { ...validUpdate, before: undefined }],
  ["non-string update after", { ...validUpdate, after: {} }],
  ["non-string update metadata", { ...validUpdate, meta: 123 }],
  ["non-string note reference", { ...validUpdate, noteRel: [] }],
  ["multiline fact before", { ...validUpdate, before: "Original\nInjected fact" }],
  ["multiline fact after", { ...validUpdate, after: "Updated\rInjected fact" }],
];

for (const [name, record] of malformedRecords) {
  test(`revision: malformed recovery boundary (${name}) fails without any filesystem mutation`, async (t) => {
    const { root, stores, local } = await fixture(t);
    await put(local.memoryFile, fact("0101abcd", "Updated fact"));
    await recoveryFile(local, recoveryId, record);
    const before = await snapshot(root);
    await assertInvalidRecovery(() => restoreEntry(stores, recoveryId));
    assert.deepEqual(await snapshot(root), before);
  });
}

test("revision: invalid JSON recovery is retained and does not rewrite an index", async (t) => {
  const { root, stores, local } = await fixture(t);
  await put(local.memoryFile, fact("0101abcd", "Updated fact"));
  await put(join(local.recoveryDir, `${recoveryId}.json`), '{"id":"badc0ffe", broken JSON\n');
  const before = await snapshot(root);
  await assertInvalidRecovery(() => restoreEntry(stores, recoveryId));
  assert.deepEqual(await snapshot(root), before);
});

for (const escape of ["traversal", "symlink"] as const) {
  test(`revision: update recovery cannot write through an unsafe note reference (${escape})`, async (t) => {
    const { root, stores, local } = await fixture(t);
    const outside = join(root, "outside.md");
    await put(outside, "Updated content\n");
    await mkdir(local.notesDir, { recursive: true });
    let noteRel: string;
    if (escape === "symlink") {
      await symlink(outside, join(local.notesDir, "escape.md"));
      noteRel = "notes/escape.md";
    } else noteRel = `notes/../${relative(local.dir, outside)}`;
    await put(local.memoryFile, noteIndex("0101abcd", noteRel));
    await recoveryFile(local, recoveryId, { ...validUpdate, noteRel, before: "Original secret\n", after: "Updated content\n" });
    const before = await snapshot(root);
    const result = await restoreEntry(stores, recoveryId);
    assert.ok(result);
    assertError(result);
    assert.deepEqual(await snapshot(root), before);
  });
}
