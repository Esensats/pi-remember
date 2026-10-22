import { strict as assert } from "node:assert";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { appendEntry, forgetEntries, resolveStores, restoreEntry, updateMemo, writeNote } from "../store.ts";

for (const directory of ["notes", "recovery"] as const) {
  test(`writes refuse a redirected ${directory} directory in an already-versioned store`, async t => {
    const root = await mkdtemp(join(tmpdir(), "pi-remember-directory-safety-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = resolveStores(root, join(root, "global"), ".pi").local;
    const outside = join(root, "outside");
    await mkdir(outside);
    if (directory === "notes") {
      await mkdir(store.dir, { recursive: true });
      await symlink(outside, store.notesDir);
      await assert.rejects(writeNote(store, "Redirected note", "Do not write outside"), /symlink|outside/);
    } else {
      const note = await writeNote(store, "Private note sentinel", "Original private body");
      const before = await readFile(note.notePath!, "utf8");
      await symlink(outside, store.recoveryDir);
      await assert.rejects(updateMemo(store, note.id!, "Never publish this recovery outside"), /symlink|outside/);
      await assert.rejects(forgetEntries(store, note.id!), /symlink|outside/);
      assert.equal(await readFile(note.notePath!, "utf8"), before);
    }
    assert.deepEqual(await readdir(outside), []);
  });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-remember-restore-directory-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = resolveStores(root, join(root, "global"), ".pi");
  await appendEntry(stores.local, "Unrelated fact sentinel");
  return { root, stores, store: stores.local };
}

async function assertRefused(operation: () => ReturnType<typeof restoreEntry>) {
  await operation().then(result => {
    assert.equal(result?.status, "error");
    if (result?.status === "error") assert.match(result.message, /symlink|unsafe|outside/i);
  }, error => {
    assert.ok(error instanceof Error);
    assert.match(error.name, /MemoryConflictError|InvalidRecoveryRecordError/);
    assert.match(error.message, /symlink|unsafe|outside/i);
  });
}

for (const redirected of ["directory", "file"] as const) {
  for (const timing of ["lookup", "queued"] as const) {
    test(`restore refuses an external recovery ${redirected} symlink at ${timing}, retaining all bytes`, async t => {
      const { root, stores, store } = await fixture(t);
      const note = await writeNote(store, "Deleted private sentinel", "Private body must not escape");
      const forgotten = await forgetEntries(store, note.id!);
      const file = join(store.recoveryDir, `${forgotten.recoveryId}.json`);
      const record = await readFile(file);
      const index = await readFile(store.memoryFile);
      const outside = join(root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "sentinel"), "External data stays unchanged");
      const externalRecord = join(outside, `${forgotten.recoveryId}.json`);
      const redirect = async () => {
        if (redirected === "directory") {
          await rename(file, externalRecord);
          await rename(store.recoveryDir, join(store.dir, "original-recovery"));
          await symlink(outside, store.recoveryDir);
        } else {
          await rename(file, externalRecord);
          await symlink(externalRecord, file);
        }
      };
      if (timing === "lookup") await redirect();
      let queued = false;
      let prepared = false;
      const queue = async <T>(_path: string, operation: () => Promise<T>) => {
        queued = true;
        await redirect();
        return operation();
      };
      await assertRefused(() => restoreEntry(stores, forgotten.recoveryId!, queue, ["local"], undefined,
        async () => { prepared = true; }));
      assert.equal(queued, timing === "queued");
      assert.equal(prepared, false, "refusal must precede preparation side effects");
      assert.deepEqual(await readFile(externalRecord), record);
      assert.deepEqual(await readFile(store.memoryFile), index);
      assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "External data stays unchanged");
      assert.deepEqual((await readdir(outside)).sort(), [basename(externalRecord), "sentinel"].sort());
      await assert.rejects(lstat(note.notePath!), { code: "ENOENT" });
    });
  }
}

for (const alias of ["notes", "nested"] as const) {
  for (const snapshots of [true, false]) {
    test(`deletion restore refuses an internal ${alias} directory alias (${snapshots ? "snapshots" : "legacy references"})`, async t => {
      const { stores, store } = await fixture(t);
      const note = await writeNote(store, "Deleted alias sentinel", "Exact recovered private bytes");
      let notePath = note.notePath!;
      let directory = store.notesDir;
      if (alias === "nested") {
        directory = join(store.notesDir, "nested");
        await mkdir(join(directory, "deep"), { recursive: true });
        notePath = join(directory, "deep", basename(notePath));
        await rename(note.notePath!, notePath);
      }
      const forgotten = await forgetEntries(store, note.id!);
      const file = join(store.recoveryDir, `${forgotten.recoveryId}.json`);
      if (!snapshots) {
        const record = JSON.parse(await readFile(file, "utf8"));
        delete record.notes;
        await writeFile(file, JSON.stringify(record));
      }
      const record = await readFile(file);
      const index = await readFile(store.memoryFile);
      const target = join(store.dir, "owned-alias-target");
      await rename(directory, target);
      await symlink(target, directory);
      await writeFile(join(target, "sentinel"), "Owned data stays unchanged");
      const before = await readdir(target, { recursive: true });
      let prepared = false;
      await assertRefused(() => restoreEntry(stores, forgotten.recoveryId!, undefined, ["local"], undefined,
        async () => { prepared = true; }));
      assert.equal(prepared, false);
      assert.deepEqual(await readFile(file), record);
      assert.deepEqual(await readFile(store.memoryFile), index);
      assert.deepEqual(await readdir(target, { recursive: true }), before);
      assert.equal(await readFile(join(target, "sentinel"), "utf8"), "Owned data stays unchanged");
      await assert.rejects(lstat(notePath), { code: "ENOENT" });
    });
  }
}

for (const alias of ["notes", "nested", "file"] as const) {
  for (const timing of ["lookup", "note-queue"] as const) {
    test(`note-update undo refuses an internal ${alias} alias at ${timing}`, async t => {
      const { stores, store } = await fixture(t);
      const note = await writeNote(store, "Updated alias sentinel", "Original private body");
      let notePath = note.notePath!;
      let directory = store.notesDir;
      let rel = note.noteRel!;
      if (alias === "nested") {
        directory = join(store.notesDir, "nested");
        await mkdir(directory);
        notePath = join(directory, basename(notePath));
        await rename(note.notePath!, notePath);
        rel = `notes/nested/${basename(notePath)}`;
      }
      // Keep an indexed reference so readMemo would otherwise follow the alias.
      await appendEntry(store, note.indexLine.replace(note.noteRel!, rel));
      const updated = await updateMemo(store, note.id!, "Updated private body");
      assert.equal(updated.status, "updated");
      if (updated.status !== "updated") return;
      const file = join(store.recoveryDir, `${updated.recoveryId}.json`);
      const record = await readFile(file);
      const index = await readFile(store.memoryFile);
      const body = await readFile(notePath);
      const target = join(store.dir, "owned-update-target");
      const redirect = async () => {
        await rename(alias === "file" ? notePath : directory, target);
        await symlink(target, alias === "file" ? notePath : directory);
      };
      if (timing === "lookup") await redirect();
      const queue = async <T>(path: string, operation: () => Promise<T>) => {
        if (path === notePath) await redirect();
        return operation();
      };
      await assertRefused(() => restoreEntry(stores, updated.recoveryId, queue));
      assert.deepEqual(await readFile(notePath), body);
      assert.deepEqual(await readFile(file), record);
      assert.deepEqual(await readFile(store.memoryFile), index);
    });
  }
}

test("recovery lookup creates no directories for absent stores or records", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-remember-absent-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = resolveStores(root, join(root, "global"), ".pi");
  assert.equal(await restoreEntry(stores, "1234abcd"), null);
  assert.deepEqual(await readdir(root), []);
  await mkdir(stores.local.dir, { recursive: true });
  assert.equal(await restoreEntry(stores, "1234abcd"), null);
  assert.deepEqual(await readdir(stores.local.dir), []);
});
