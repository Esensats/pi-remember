import { strict as assert } from "node:assert";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { CURRENT_VERSION, ensureStoreVersion } from "../migration.ts";
import { legacyNote, parseNote, readNoteHeader, serializeNote, type NoteMetadata } from "../notes.ts";
import type { MemoId, StorePaths } from "../store.ts";

const created = "2024-02-03T04:05:06Z";
const modified = "2025-06-07T08:09:10.123Z";
const metadata = (id = "abcdef01", description = "A note"): NoteMetadata => ({ id: id as MemoId, description, created, modified });
const meta = (id = "abcdef01") => `<!-- ${created} [${id}] -->`;
const indexed = (id = "abcdef01", rel = "notes/a.md", title = "Indexed description") => `${meta(id)}\n#note [[${rel}]] ${title}\n`;
const old = (body = "Original body\n", title = "Generated title") => `<!-- pi-remember note: ${created} -->\n# ${title}\n\n${body}`;

async function fixture(t: TestContext, exists = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-remember-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "store");
  const store: StorePaths = { scope: "local", dir, memoryFile: join(dir, "MEMORY.md"), notesDir: join(dir, "notes"), recoveryDir: join(dir, "recovery") };
  if (exists) await mkdir(dir);
  return { root, store };
}
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function putNote(store: StorePaths, text = old(), rel = "notes/a.md") {
  const path = join(store.dir, rel);
  await put(path, text);
  await utimes(path, new Date(modified), new Date(modified));
  return path;
}
async function record(store: StorePaths, value: Record<string, unknown>, id = "12345678") {
  const path = join(store.recoveryDir, `${id}.json`);
  await put(path, JSON.stringify({ id, scope: store.scope, timestamp: modified, ...value }));
  return path;
}
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), info = await lstat(child), key = relative(root, child);
      if (info.isSymbolicLink()) result[key] = "symlink";
      else if (info.isDirectory()) { result[key] = "directory"; await walk(child); }
      else result[key] = (await readFile(child)).toString("base64");
    }
  };
  await walk(root);
  return result;
}
async function backup(store: StorePaths) {
  const runs = await readdir(join(store.dir, "migrations"));
  assert.equal(runs.length, 1);
  const dir = join(store.dir, "migrations", runs[0]);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  return { dir, manifest };
}

test("notes: roundtrip exact bodies and YAML scalar styles", () => {
  const body = "\r\n# User H1\r\n\r\nBody without final newline";
  const m = metadata("ABCDEF01", 'Description: "quoted" # value');
  assert.deepEqual(parseNote(serializeNote(m, body)), { metadata: { ...m, id: "abcdef01" }, body });
  const yaml = `---\r\ndescription: 'It''s a note' # comment\r\nmemory-id: ABCDEF01\r\ncreated-date: ${created}\r\nlast-modified-date: "${modified}"\r\n---\r\n${body}`;
  assert.deepEqual(parseNote(yaml), { metadata: metadata("abcdef01", "It's a note"), body });
  assert.equal(parseNote("# User heading\nbody"), null);
  assert.equal(parseNote("--- is a horizontal separator, not frontmatter\n"), null);
});

test("notes: malformed frontmatter cannot fall back to a legacy note", () => {
  for (const text of [
    "---\nmissing close", "---\ndescription: only description\n---\nbody",
    serializeNote(metadata(), "body").replace('"abcdef01"', '"not-an-id"'),
    serializeNote(metadata(), "body").replace(created, "2024-02-30T00:00:00Z"),
    serializeNote(metadata(), "body").replace(modified, "yesterday"),
    serializeNote(metadata(), "body").replace("description:", "unexpected:"),
    serializeNote(metadata(), "body").replace("memory-id:", 'description: "duplicate"\nmemory-id:'),
    serializeNote(metadata(), "body").replace('"A note"', '"unterminated'),
    serializeNote(metadata(), "body").replace('"A note"', "[a, list]"),
    serializeNote(metadata(), "body").replace('"A note"', "a: nested mapping"),
    serializeNote(metadata(), "body").replace('"A note"', '"line\\nbreak"'),
  ]) assert.throws(() => parseNote(text), /frontmatter/i);
  assert.throws(() => serializeNote(metadata("bad"), "body"), /memory-id/);
  assert.throws(() => serializeNote(metadata("abcdef01", "x".repeat(16384)), "body"), /16 KiB/);
});

test("notes: legacy stripping is limited to the generated marker and immediate heading", () => {
  assert.deepEqual(legacyNote(old("# User H1\r\nBody\r\n")), { description: "Generated title", created, body: "# User H1\r\nBody\r\n" });
  const user = "# My own heading\n\nBody\n";
  assert.deepEqual(legacyNote(user), { body: user });
  assert.deepEqual(legacyNote(`<!-- pi-remember note: ${created} -->\nBody\n# Later user heading\n`), { created, body: "Body\n# Later user heading\n" });
  assert.throws(() => legacyNote("<!-- pi-remember note: yesterday -->\n# title\n"), /Malformed/);
});

test("notes: header reads are bounded, including oversized/malformed headers", async (t) => {
  const { store } = await fixture(t);
  const path = await putNote(store, serializeNote(metadata(), "x".repeat(1024 * 1024)));
  assert.deepEqual(await readNoteHeader(path), metadata());
  await writeFile(path, "---\ndescription: " + "x".repeat(20 * 1024) + "\n---\nbody");
  await assert.rejects(readNoteHeader(path), /16 KiB|closing delimiter/);
  const prefix = serializeNote(metadata(), "").slice(0, -4);
  const padding = "#" + "x".repeat(16384 - Buffer.byteLength(prefix) - 5) + "\n";
  await writeFile(path, prefix + padding + "---not-a-delimiter\n");
  await assert.rejects(readNoteHeader(path), /16 KiB|closing delimiter/);
  await writeFile(path, "# User H1\n" + "x".repeat(20000));
  assert.equal(await readNoteHeader(path), null);
  await writeFile(path, "---\ndescription: only\n---\n" + "x".repeat(20000));
  await assert.rejects(readNoteHeader(path), /expected/);
});

test("migration: absent stores stay absent; existing empty stores get only version and backups", async (t) => {
  const { root, store } = await fixture(t, false);
  await ensureStoreVersion(store);
  assert.deepEqual(await readdir(root), []);
  await mkdir(store.dir);
  await ensureStoreVersion(store);
  assert.equal(CURRENT_VERSION, 1);
  assert.deepEqual(JSON.parse(await readFile(join(store.dir, "pi-remember.json"), "utf8")), { version: 1 });
  await assert.rejects(readFile(store.memoryFile), { code: "ENOENT" });
  const { manifest } = await backup(store);
  assert.deepEqual(manifest.files.map((f: { rel: string }) => f.rel), ["pi-remember.json"]);
});

test("migration: preserves IDs, path, body, headings, fact bytes, modes, and complete original backups", async (t) => {
  const { store } = await fixture(t);
  const prefix = "# Personal memory\r\n\r\n<!-- keep this annotation -->\r\n";
  const fact = "<!-- 2023-01-01T00:00:00Z [11111111] -->\r\n  Fact with trailing spaces.  \r\n\r\n";
  const suffix = "\r\n<!-- unrelated trailing comment -->\r\n";
  const index = indexed().replace(/\n/g, "\r\n");
  const original = `${prefix}${fact}${index}${suffix}`;
  await put(store.memoryFile, original);
  const body = "# User heading\r\n\r\nKeep exactly.  \r\n";
  const originalNote = old(body);
  const path = await putNote(store, originalNote);
  await chmod(path, 0o640);
  await chmod(store.memoryFile, 0o604);
  await ensureStoreVersion(store);
  assert.equal(await readFile(store.memoryFile, "utf8"), `${prefix}${fact}${suffix}`);
  const migrated = parseNote(await readFile(path, "utf8"))!;
  assert.deepEqual(migrated, { metadata: metadata("abcdef01", "Indexed description"), body });
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  assert.equal((await stat(store.memoryFile)).mode & 0o777, 0o604);
  const { dir, manifest } = await backup(store);
  assert.equal(await readFile(join(dir, "files/MEMORY.md"), "utf8"), original);
  assert.equal(await readFile(join(dir, "files/notes/a.md"), "utf8"), originalNote);
  assert.match(manifest.inference, /mtime/);
  assert.equal(manifest.files.find((f: { rel: string }) => f.rel === "notes/a.md").mode, 0o640);
  const before = await tree(store.dir);
  await ensureStoreVersion(store);
  assert.deepEqual(await tree(store.dir), before);
});

test("migration: mixed and partial formats, orphan notes, and generated timestamps", async (t) => {
  const { store } = await fixture(t);
  const ready = serializeNote(metadata(), "# Kept user H1\nBody\n");
  await putNote(store, ready);
  await put(store.memoryFile, indexed()); // Already converted note + old index, e.g. interrupted run.
  await putNote(store, "# User title\n\nUser body\n", "notes/user.md");
  await putNote(store, old("Generated orphan body\n"), "notes/generated.md");
  await ensureStoreVersion(store);
  assert.equal(await readFile(join(store.notesDir, "a.md"), "utf8"), ready);
  const user = parseNote(await readFile(join(store.notesDir, "user.md"), "utf8"))!;
  assert.equal(user.body, "# User title\n\nUser body\n");
  assert.equal(user.metadata.description, "User title");
  assert.equal(user.metadata.created, modified);
  const generated = parseNote(await readFile(join(store.notesDir, "generated.md"), "utf8"))!;
  assert.equal(generated.metadata.created, created);
  assert.equal(generated.body, "Generated orphan body\n");
  assert.equal(new Set([user.metadata.id, generated.metadata.id, "abcdef01"]).size, 3);
});

test("migration: rejects malformed, unsafe, negative, fractional and future versions on every call", async (t) => {
  const { store } = await fixture(t);
  for (const value of ["{", "null", "[]", "{}", '{"version":"1"}', '{"version":-1}', '{"version":0.5}', '{"version":9007199254740992}', '{"version":2}']) {
    await writeFile(join(store.dir, "pi-remember.json"), value);
    const before = await tree(store.dir);
    await assert.rejects(ensureStoreVersion(store), /version|malformed/);
    assert.deepEqual(await tree(store.dir), before);
  }
  await writeFile(join(store.dir, "pi-remember.json"), '{"version":0}');
  await ensureStoreVersion(store);
  await writeFile(join(store.dir, "pi-remember.json"), '{"version":99}');
  await assert.rejects(ensureStoreVersion(store), /future store version 99/);
});

test("migration: refuses duplicate/dangling/unsafe refs, IDs, malformed notes before modifying files", async (t) => {
  for (const [name, index, notes] of [
    ["duplicate reference", indexed() + indexed("22222222"), [["notes/a.md", old()]]],
    ["duplicate IDs", indexed() + indexed("abcdef01", "notes/b.md"), [["notes/a.md", old()], ["notes/b.md", old()]]],
    ["dangling", indexed(), []],
    ["traversal", indexed("abcdef01", "notes/../escape.md"), []],
    ["absolute", indexed("abcdef01", "/tmp/escape.md"), []],
    ["backslash", indexed("abcdef01", "notes/..\\escape.md"), []],
    ["malformed", indexed(), [["notes/a.md", "---\ndescription: incomplete\n---\n"]]],
    ["mismatching ID", indexed(), [["notes/a.md", serializeNote(metadata("22222222"), "body")]]],
    ["fact/note duplicate", meta() + "\nFact\n", [["notes/a.md", serializeNote(metadata(), "body")]]],
    ["note/note duplicate", "", [["notes/a.md", serializeNote(metadata(), "body")], ["notes/b.md", serializeNote(metadata(), "body")]]],
  ] as const) {
    await t.test(name, async (t) => {
      const { store } = await fixture(t);
      await put(store.memoryFile, index);
      for (const [rel, text] of notes) await putNote(store, text, rel);
      const before = await tree(store.dir);
      await assert.rejects(ensureStoreVersion(store));
      assert.deepEqual(await tree(store.dir), before);
    });
  }
});

test("migration: refuses external symlink notes/directories without reading or changing their targets", async (t) => {
  for (const directory of [false, true]) await t.test(directory ? "directory" : "file", async (t) => {
    const { root, store } = await fixture(t);
    const external = join(root, "external");
    await put(join(external, "a.md"), old());
    await put(store.memoryFile, indexed());
    if (directory) await symlink(external, store.notesDir);
    else { await mkdir(store.notesDir); await symlink(join(external, "a.md"), join(store.notesDir, "a.md")); }
    const before = await tree(root);
    await assert.rejects(ensureStoreVersion(store), /symlink/);
    assert.deepEqual(await tree(root), before);
  });
});

test("migration: old whole-note update recovery gets canonical metadata and exact current after-text", async (t) => {
  const { store } = await fixture(t);
  await put(store.memoryFile, indexed());
  const current = old("After\n");
  const path = await putNote(store, current);
  const rec = await record(store, { kind: "update", memoId: "abcdef01", noteRel: "notes/a.md", meta: meta(), before: old("Before\n"), after: current });
  await ensureStoreVersion(store);
  const migrated = JSON.parse(await readFile(rec, "utf8"));
  assert.equal(migrated.meta, meta());
  assert.equal(migrated.after, await readFile(path, "utf8"));
  assert.deepEqual(parseNote(migrated.before), { metadata: metadata("abcdef01", "Indexed description"), body: "Before\n" });
  const { dir } = await backup(store);
  assert.equal(JSON.parse(await readFile(join(dir, "files/recovery/12345678.json"), "utf8")).after, current);
});

test("migration: old conflicting update stays a conflict; header-only conflicts abort rather than disappear", async (t) => {
  const { store } = await fixture(t);
  await put(store.memoryFile, indexed());
  const path = await putNote(store, old("Later edit\n"));
  const rec = await record(store, { kind: "update", memoId: "abcdef01", noteRel: "notes/a.md", meta: meta(), before: old("Before\n"), after: old("After\n") });
  await ensureStoreVersion(store);
  assert.notEqual(JSON.parse(await readFile(rec, "utf8")).after, await readFile(path, "utf8"));
  const other = await fixture(t);
  await put(other.store.memoryFile, indexed());
  await putNote(other.store, old("After\n", "Manually changed heading"));
  await record(other.store, { kind: "update", memoId: "abcdef01", noteRel: "notes/a.md", meta: meta(), before: old("Before\n"), after: old("After\n") });
  const before = await tree(other.store.dir);
  await assert.rejects(ensureStoreVersion(other.store), /header conflict/);
  assert.deepEqual(await tree(other.store.dir), before);
});

test("migration: forgotten legacy note is snapshotted, not resurrected; deleted note updates still migrate", async (t) => {
  const { store } = await fixture(t);
  const facts = "<!-- keep exact -->\nFact  with spaces.  \n";
  await put(store.memoryFile, facts);
  const path = await putNote(store, old("Deleted body\n"));
  const deletion = await record(store, { entries: [
    { line: "Deleted fact", meta: meta("22222222") },
    { line: "#note [[notes/a.md]] Forgotten title", meta: meta() },
  ] });
  const update = await record(store, { kind: "update", memoId: "abcdef01", noteRel: "notes/a.md", meta: meta(), before: old("Before\n"), after: old("Deleted body\n") }, "87654321");
  await ensureStoreVersion(store);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal(await readFile(store.memoryFile, "utf8"), facts);
  const recovered = JSON.parse(await readFile(deletion, "utf8"));
  assert.equal(recovered.kind, "forget");
  assert.equal(recovered.entries.length, 2);
  assert.equal(recovered.entries[1].meta, meta());
  assert.deepEqual(recovered.notes, [{ rel: "notes/a.md", text: serializeNote(metadata("abcdef01", "Forgotten title"), "Deleted body\n") }]);
  assert.equal(JSON.parse(await readFile(update, "utf8")).after, recovered.notes[0].text);
  const { dir } = await backup(store);
  assert.equal(await readFile(join(dir, "files/notes/a.md"), "utf8"), old("Deleted body\n"));
});

test("migration: retry after recovery conversion or inactive-file removal is safe", async (t) => {
  for (const missingBody of [false, true]) await t.test(missingBody ? "already removed" : "still legacy", async (t) => {
    const { store } = await fixture(t);
    const snapshot = serializeNote(metadata("abcdef01", "Forgotten title"), "Deleted body\n");
    if (!missingBody) await putNote(store, old("Deleted body\n"));
    const deletion = await record(store, { kind: "forget", entries: [{ line: "#note [[notes/a.md]] Forgotten title", meta: meta() }], notes: [{ rel: "notes/a.md", text: snapshot }] });
    const update = await record(store, { kind: "update", memoId: "abcdef01", noteRel: "notes/a.md", meta: meta(), before: old("Before\n"), after: old("Deleted body\n") }, "87654321");
    await ensureStoreVersion(store);
    assert.equal(JSON.parse(await readFile(deletion, "utf8")).notes[0].text, snapshot);
    assert.equal(JSON.parse(await readFile(update, "utf8")).after, snapshot);
    await assert.rejects(readFile(join(store.notesDir, "a.md")), { code: "ENOENT" });
  });
});

test("migration: malformed/mismatched recovery and unsafe recovery paths abort before writes", async (t) => {
  for (const value of [
    { kind: "update", memoId: "22222222", noteRel: "notes/a.md", meta: meta(), before: old(), after: old("new") },
    { kind: "update", memoId: "abcdef01", noteRel: "notes/../outside.md", meta: meta(), before: old(), after: old("new") },
    { entries: [{ line: "#note [[notes/missing.md]] Missing", meta: meta() }] },
    { entries: [{ line: "#note [[notes/a.md]] A", meta: meta("22222222") }] },
    { kind: "update", memoId: "abcdef01", noteRel: "notes/a.md", meta: meta(), before: "---\nbad\n---\n", after: old() },
  ]) await t.test(JSON.stringify(value).slice(0, 80), async (t) => {
    const { store } = await fixture(t);
    await put(store.memoryFile, indexed());
    await putNote(store);
    await record(store, value);
    const before = await tree(store.dir);
    await assert.rejects(ensureStoreVersion(store));
    assert.deepEqual(await tree(store.dir), before);
  });
});

test("migration: write interruption retains backups, leaves version uncommitted, and resumes", async (t) => {
  if (process.getuid?.() === 0) { t.skip("permission-based fault injection requires a non-root user"); return; }
  const { store } = await fixture(t);
  await put(store.memoryFile, indexed());
  const path = await putNote(store, old("After\n"));
  const rec = await record(store, { kind: "update", memoId: "abcdef01", noteRel: "notes/a.md", meta: meta(), before: old("Before\n"), after: old("After\n") });
  await chmod(store.notesDir, 0o500); // Recovery can commit, but note replacement must fail.
  try { await assert.rejects(ensureStoreVersion(store), /EACCES/); }
  finally { await chmod(store.notesDir, 0o700); }
  await assert.rejects(readFile(join(store.dir, "pi-remember.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(store.dir, ".pi-remember-migration.lock")), { code: "ENOENT" });
  assert.ok(parseNote(JSON.parse(await readFile(rec, "utf8")).after));
  assert.equal(await readFile(path, "utf8"), old("After\n"));
  const { dir, manifest } = await backup(store);
  assert.equal(await readFile(join(dir, "files/notes/a.md"), "utf8"), old("After\n"));
  assert.equal(manifest.files.at(-1).rel, "pi-remember.json");
  await ensureStoreVersion(store);
  assert.equal(JSON.parse(await readFile(rec, "utf8")).after, await readFile(path, "utf8"));
  assert.equal((await readdir(join(store.dir, "migrations"))).length, 2);
});

test("migration: exclusive lock fails clearly without stealing, concurrent in-process calls share a run", async (t) => {
  const { store } = await fixture(t);
  const lock = join(store.dir, ".pi-remember-migration.lock");
  await writeFile(lock, "existing lock, do not steal");
  await assert.rejects(ensureStoreVersion(store), /lock already exists/);
  assert.equal(await readFile(lock, "utf8"), "existing lock, do not steal");
  await rm(lock);
  await put(store.memoryFile, indexed());
  await putNote(store);
  await Promise.all(Array.from({ length: 12 }, () => ensureStoreVersion(store)));
  assert.equal((await readdir(join(store.dir, "migrations"))).length, 1);
  await assert.rejects(readFile(lock), { code: "ENOENT" });
});
