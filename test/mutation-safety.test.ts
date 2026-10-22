import { strict as assert } from "node:assert";
import fs, { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseNote, serializeNote } from "../notes.ts";
import {
  appendEntry, forgetEntries, readCatalogue, readNotes, resolveStores,
  restoreEntry, statMemory, updateMemo, writeNote,
} from "../store.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-remember-mutation-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = resolveStores(join(root, "project"), join(root, "global"), ".pi");
  return { root, stores, store: stores.local };
}
async function absent(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Builtin ESM bindings must be synchronized both when installing and removing
// mocks. Node runs this file in its own test process; no production hooks/data.
function mockFs<K extends "readFile" | "writeFile" | "link" | "rm">(
  t: TestContext, name: K, implementation: typeof fs[K],
) {
  const mock = t.mock.method(fs, name, implementation);
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

test("forget waits for ordinary queued edits and holds ALL selected note locks before taking snapshots", async t => {
  const { stores, store } = await fixture(t);
  const first = await writeNote(store, "Queue batch amber", "Original amber body", "amber");
  const second = await writeNote(store, "Queue batch violet", "Original violet body", "violet");
  const paths = [first.notePath!, second.notePath!].sort((a, b) => a.localeCompare(b));
  const firstOriginal = await readFile(paths[0], "utf8");
  const before = await readFile(paths[1], "utf8");
  const parsed = parseNote(before)!;
  const latest = serializeNote({ ...parsed.metadata, modified: "2099-01-01T00:00:00Z" }, "Ordinary queued edit must survive\r\n");
  const gate = deferred(), entered = deferred();
  const tails = new Map<string, Promise<unknown>>();
  const held = new Set<string>();
  const calls: string[] = [];
  const queue = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
    calls.push(path);
    const pending = (tails.get(path) ?? Promise.resolve()).then(async () => {
      held.add(path);
      try { return await operation(); }
      finally { held.delete(path); }
    });
    tails.set(path, pending.catch(() => {}));
    return pending;
  };
  const ordinaryEdit = queue(paths[1], async () => {
    entered.resolve();
    await gate.promise;
    await writeFile(paths[1], latest);
  });
  await entered.promise;
  const originalRead = fs.readFile;
  const snapshotReads: string[] = [];
  mockFs(t, "readFile", (async (path, ...args) => {
    if (typeof path === "string" && paths.includes(path)) {
      snapshotReads.push(path);
      assert.ok(paths.every(selected => held.has(selected)), "every note lock must precede the first body read");
    }
    return originalRead(path, ...args);
  }) as typeof fs.readFile);
  const originalRemove = fs.rm;
  const deletions: string[] = [];
  mockFs(t, "rm", (async (path, ...args) => {
    if (typeof path === "string" && paths.includes(path)) {
      deletions.push(path);
      assert.ok(paths.every(selected => held.has(selected)), "every selected lock must remain held through deletion");
    }
    return originalRemove(path, ...args);
  }) as typeof fs.rm);
  let settled = false;
  const forgetting = forgetEntries(store, "Queue batch", queue).finally(() => { settled = true; });
  void forgetting.catch(() => {});
  try {
    for (let i = 0; i < 200 && calls.length < 3 && !settled; i++) await delay(5);
    assert.deepEqual(calls, [paths[1], ...paths], "forget must acquire note queues in deterministic order");
    assert.equal(settled, false, "forget must wait behind the ordinary edit");
    assert.deepEqual(snapshotReads, [], "no body may be snapshotted before the last lock is available");
  } finally {
    gate.resolve();
    await Promise.allSettled([ordinaryEdit, forgetting]);
  }
  await ordinaryEdit;
  const forgotten = await forgetting;
  assert.equal(forgotten.removed.length, 2);
  assert.ok(forgotten.recoveryId);
  assert.deepEqual([...snapshotReads].sort(), [...paths].sort());
  assert.deepEqual([...deletions].sort(), [...paths].sort());
  // Remove filesystem spies before explicitly inspecting/restoring the fixture.
  t.mock.restoreAll();
  syncBuiltinESMExports();
  for (const path of paths) await absent(path);
  const record = JSON.parse(await readFile(join(store.recoveryDir, `${forgotten.recoveryId}.json`), "utf8"));
  assert.equal(record.notes.find((note: { rel: string }) => join(store.dir, note.rel) === paths[1]).text, latest);
  assert.equal((await restoreEntry(stores, forgotten.recoveryId))?.status, "restored");
  assert.equal(await readFile(paths[0], "utf8"), firstOriginal);
  assert.equal(await readFile(paths[1], "utf8"), latest, "restore must not recover the pre-queue body");
  assert.equal((await readNotes(store)).length, 2);
});

test("readNotes skips internal file/directory aliases and forgetting an alias never deletes its target", async t => {
  const { store } = await fixture(t);
  const note = await writeNote(store, "Canonical handbook", "Private canonical body", "canonical");
  const original = await readFile(note.notePath!);
  const alias = join(store.notesDir, "alias.md");
  await symlink(note.notePath!, alias);
  await symlink(store.notesDir, join(store.notesDir, "loop"));
  await symlink(join(store.notesDir, "missing.md"), join(store.notesDir, "dangling.md"));
  assert.deepEqual((await readNotes(store)).map(note => note.rel), [note.noteRel]);
  assert.doesNotMatch(await readCatalogue(store), /alias|loop|dangling/);
  assert.deepEqual(await forgetEntries(store, "alias.md"), { removed: [], recoveryId: null });
  assert.deepEqual(await readFile(note.notePath!), original);
  assert.ok((await lstat(alias)).isSymbolicLink());
  await absent(store.recoveryDir);
});

test("readNotes skips a linked notesDir even when its target stays inside the store", async t => {
  const { store } = await fixture(t);
  const note = await writeNote(store, "Linked directory sentinel", "Body remains intact");
  const original = await readFile(note.notePath!);
  const target = join(store.dir, "internal-notes");
  await fs.rename(store.notesDir, target);
  await symlink(target, store.notesDir);
  assert.deepEqual(await readNotes(store), []);
  assert.equal(await readCatalogue(store), "");
  assert.deepEqual(await forgetEntries(store, "Linked directory"), { removed: [], recoveryId: null });
  assert.deepEqual(await readFile(join(target, note.noteRel!.slice("notes/".length))), original);
  await absent(store.recoveryDir);
});

for (const kind of ["note", "forget recovery", "update recovery"] as const) {
  test(`an interrupted partial ${kind} write is unpublished, invisible to discovery, and safely retryable`, async t => {
    const { stores, store } = await fixture(t);
    const existing = kind === "note" ? undefined : await writeNote(store, "Existing original sentinel", "Keep original body");
    const original = existing ? await readFile(existing.notePath!, "utf8") : undefined;
    const catalogue = await readCatalogue(store);
    const realWrite = fs.writeFile;
    const failure = new Error("simulated interrupted write after partial bytes");
    let interruptedPath: string | undefined;
    mockFs(t, "writeFile", (async (path, data, options) => {
      const directory = kind === "note" ? store.notesDir : store.recoveryDir;
      if (!interruptedPath && typeof path === "string" && dirname(path) === directory) {
        interruptedPath = path;
        // For notes keep the entire valid header: direct-to-.md creation would
        // poison the catalogue even though only the body is partially written.
        const text = String(data);
        await realWrite(path, kind === "note" ? text.slice(0, text.lastIndexOf("---\n") + 4) + "partial body" : text.slice(0, 25), options);
        assert.equal(await readCatalogue(store), catalogue, "partial bytes must never become indexed knowledge");
        assert.equal((await statMemory(store)).recoveryCount, 0, "partial JSON must never be a recovery record");
        assert.ok(path.endsWith(".tmp"));
        throw failure;
      }
      return realWrite(path, data, options);
    }) as typeof fs.writeFile);
    const operation = () => kind === "note" ? writeNote(store, "New atomic publication", "Complete body", "atomic")
      : kind === "forget recovery" ? forgetEntries(store, existing!.id!)
      : updateMemo(store, existing!.id!, "Updated complete body");
    await assert.rejects(operation(), error => error === failure);
    assert.ok(interruptedPath);
    await absent(interruptedPath);
    assert.equal(await readCatalogue(store), catalogue);
    if (existing) assert.equal(await readFile(existing.notePath!, "utf8"), original);
    const directory = kind === "note" ? store.notesDir : store.recoveryDir;
    assert.deepEqual(await readdir(directory), [], "failed publication must leave no final or temporary artifact");
    const result = await operation();
    if (kind === "note") {
      assert.equal(parseNote(await readFile((result as Awaited<ReturnType<typeof writeNote>>).notePath!, "utf8"))!.body, "Complete body\n");
    } else {
      assert.equal((await statMemory(store)).recoveryCount, 1);
      const recoveryId = (result as { recoveryId: string }).recoveryId;
      assert.equal((await restoreEntry(stores, recoveryId))?.status, "restored");
      assert.equal(await readFile(existing!.notePath!, "utf8"), original);
    }
  });
}

for (const kind of ["note", "forget recovery", "update recovery"] as const) {
  test(`${kind} hard-link publication cannot clobber a pathname created after the temporary write`, async t => {
    const { store } = await fixture(t);
    const existing = kind === "note" ? undefined : await writeNote(store, "Unchanged collision sentinel", "Original bytes");
    const original = existing ? await readFile(existing.notePath!) : undefined;
    const realLink = fs.link;
    let collisionPath: string | undefined;
    const sentinel = "Concurrent creator owns these exact bytes\r\n";
    mockFs(t, "link", (async (source, destination) => {
      if (!collisionPath && typeof destination === "string" && destination.startsWith(store.dir + "/")) {
        collisionPath = destination;
        assert.ok(String(source).endsWith(".tmp"));
        await writeFile(destination, sentinel, { flag: "wx" });
      }
      return realLink(source, destination);
    }) as typeof fs.link);
    if (kind === "note") {
      const note = await writeNote(store, "Atomic collision handbook", "Published body", "collision");
      assert.ok(note.noteRel!.endsWith("-collision-2.md"));
      assert.notEqual(note.notePath, collisionPath);
      assert.equal(parseNote(await readFile(note.notePath!, "utf8"))!.body, "Published body\n");
    } else {
      await assert.rejects(kind === "forget recovery" ? forgetEntries(store, existing!.id!)
        : updateMemo(store, existing!.id!, "Must not replace original"), { code: "EEXIST" });
      assert.deepEqual(await readFile(existing!.notePath!), original);
    }
    assert.ok(collisionPath, "creation must publish via the atomic no-clobber link boundary");
    assert.equal(await readFile(collisionPath, "utf8"), sentinel);
    assert.ok(!(await readdir(dirname(collisionPath))).some(path => path.endsWith(".tmp")));
  });
}

test("new note/recovery files are 0600 and the recovery directory is 0700 even with permissive umask", async t => {
  const { store } = await fixture(t);
  const mask = process.umask(0o000);
  try {
    const note = await writeNote(store, "Private permission sentinel", "Sensitive body");
    assert.equal((await lstat(note.notePath!)).mode & 0o777, 0o600);
    const fact = await appendEntry(store, "Original private fact");
    const updated = await updateMemo(store, fact.id!, "Revised private fact");
    assert.equal(updated.status, "updated");
    const forgotten = await forgetEntries(store, note.id!);
    assert.ok(forgotten.recoveryId);
    assert.equal((await lstat(store.recoveryDir)).mode & 0o777, 0o700);
    const files = await readdir(store.recoveryDir);
    assert.equal(files.length, 2);
    for (const file of files) assert.equal((await lstat(join(store.recoveryDir, file))).mode & 0o777, 0o600);
  } finally { process.umask(mask); }
});

for (const mode of [0o640, 0o664, 0o751]) {
  test(`forget snapshots mode ${mode.toString(8)} and restores exact note bytes/permissions despite restrictive umask`, async t => {
    const { stores, store } = await fixture(t);
    const note = await writeNote(store, "Restore permission sentinel", "Original body\n\nKeep all bytes");
    await chmod(note.notePath!, mode);
    const original = await readFile(note.notePath!, "utf8");
    const forgotten = await forgetEntries(store, note.id!);
    assert.ok(forgotten.recoveryId);
    await absent(note.notePath!);
    const recordPath = join(store.recoveryDir, `${forgotten.recoveryId}.json`);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.deepEqual(record.notes, [{ rel: note.noteRel, text: original, mode }]);
    const mask = process.umask(0o077);
    try {
      assert.equal((await restoreEntry(stores, forgotten.recoveryId))?.status, "restored");
    } finally { process.umask(mask); }
    assert.equal(await readFile(note.notePath!, "utf8"), original);
    assert.equal((await lstat(note.notePath!)).mode & 0o777, mode);
    await absent(recordPath);
  });
}
