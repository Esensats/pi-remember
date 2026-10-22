import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  appendEntry, forgetEntries, readMemoryText, resolveNotePath, resolveStores,
  restoreEntry, statMemory, updateMemo, writeNote,
} from "../store.ts";
import { searchStores } from "../search.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-remember-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = resolveStores(join(root, "project"), join(root, "global"), ".pi");
  return { root, stores, store: stores.local };
}

test("fact updates reject metadata comments without changing identity or creating recovery", async (t) => {
  const { store } = await fixture(t);
  const written = await appendEntry(store, "Original durable fact");
  assert.ok(written.id);
  await writeFile(store.memoryFile, "Legacy unrelated line\n", { flag: "a" });
  const before = await readMemoryText(store);
  const result = await updateMemo(store, written.id, " <!-- revised fact --> ");
  assert.equal(result.status, "error");
  assert.equal(await readMemoryText(store), before);
  assert.equal((await statMemory(store)).recoveryCount, 0);
});

test("search skips symlink escapes and directories instead of reading external data", async (t) => {
  const { root, stores, store } = await fixture(t);
  await mkdir(store.notesDir, { recursive: true });
  const external = join(root, "outside.md");
  await writeFile(external, "Private needle outside memory\n");
  await symlink(external, join(store.notesDir, "escape.md"));
  await mkdir(join(store.notesDir, "directory.md"));
  assert.equal(resolveNotePath(stores, "notes/escape.md", ["local"]).status, "error");
  assert.equal(resolveNotePath(stores, "notes/directory.md", ["local"]).status, "error");
  assert.deepEqual(await searchStores(stores, "needle", ["local"]), []);
});

test("search exposes metadata IDs for facts and indexed note contents, not orphan files", async (t) => {
  const { stores, store } = await fixture(t);
  const fact = await appendEntry(store, "Needle fact identifier");
  const note = await writeNote(store, "Operational details", "Needle note identifier");
  await writeFile(join(store.notesDir, "legacy-orphan.md"), "Needle orphan identifier\n");
  const hits = await searchStores(stores, "needle", ["local"]);
  assert.equal(hits.find((hit) => hit.file === "MEMORY.md")?.id, fact.id);
  assert.equal(hits.find((hit) => hit.file === note.noteRel)?.id, note.id);
  assert.equal(hits.find((hit) => hit.file === "notes/legacy-orphan.md")?.id, undefined);
});

test("deletion recovery refuses duplicate IDs inside a record and retains its bytes", async (t) => {
  const { stores, store } = await fixture(t);
  await appendEntry(store, "Existing unaffected knowledge");
  await mkdir(store.recoveryDir, { recursive: true });
  const recordPath = join(store.recoveryDir, "12345678.json");
  const body = JSON.stringify({ id: "12345678", scope: "local", entries: [
    { meta: "<!-- old [abcdef01] -->", line: "First recovered line" },
    { meta: "<!-- old [ABCDEF01] -->", line: "Second recovered line" },
  ] });
  await writeFile(recordPath, body);
  const before = await readMemoryText(store);
  const result = await restoreEntry(stores, "12345678");
  assert.equal(result?.status, "error");
  assert.equal(await readMemoryText(store), before);
  assert.equal(await readFile(recordPath, "utf8"), body);
});

test("atomic fact and note updates/restores preserve permission bits despite restrictive umask", async (t) => {
  const { stores, store } = await fixture(t);
  const fact = await appendEntry(store, "Old fact");
  const note = await writeNote(store, "Permission preservation", "Old body");
  assert.ok(fact.id && note.id && note.notePath);
  await chmod(store.memoryFile, 0o660);
  await chmod(note.notePath, 0o664);
  const previousMask = process.umask(0o077);
  try {
    const factUpdate = await updateMemo(store, fact.id, "New fact");
    assert.ok(factUpdate.status === "updated");
    assert.equal((await stat(store.memoryFile)).mode & 0o777, 0o660);
    assert.equal((await restoreEntry(stores, factUpdate.recoveryId))?.status, "restored");
    assert.equal((await stat(store.memoryFile)).mode & 0o777, 0o660);
    const noteUpdate = await updateMemo(store, note.id, "New body");
    assert.ok(noteUpdate.status === "updated");
    assert.equal((await stat(note.notePath)).mode & 0o777, 0o664);
    assert.equal((await restoreEntry(stores, noteUpdate.recoveryId))?.status, "restored");
    assert.equal((await stat(note.notePath)).mode & 0o777, 0o664);
  } finally {
    process.umask(previousMask);
  }
});

test("failed recovery creation leaves both fact and note originals untouched", async (t) => {
  const { store } = await fixture(t);
  const fact = await appendEntry(store, "Original fact before I/O failure");
  const note = await writeNote(store, "Recovery failure safety", "Original body before I/O failure");
  assert.ok(fact.id && note.id && note.notePath);
  const indexBefore = await readMemoryText(store);
  const noteBefore = await readFile(note.notePath, "utf8");
  await writeFile(store.recoveryDir, "A file blocks recovery directory creation\n");
  for (const id of [fact.id, note.id]) {
    await assert.rejects(updateMemo(store, id, "This must not be written"));
    assert.equal(await readMemoryText(store), indexBefore);
    assert.equal(await readFile(note.notePath, "utf8"), noteBefore);
  }
});

test("blank forget queries cannot delete the entire memory", async (t) => {
  const { store } = await fixture(t);
  await appendEntry(store, "Durable existing knowledge");
  const before = await readMemoryText(store);
  for (const query of ["", "  ", "\n"]) {
    assert.deepEqual(await forgetEntries(store, query), { removed: [], recoveryId: null });
  }
  assert.equal(await readMemoryText(store), before);
  assert.equal((await statMemory(store)).recoveryCount, 0);
});
