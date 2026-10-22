import { strict as assert } from "node:assert";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { parseNote, serializeNote } from "../notes.ts";
import { searchStores } from "../search.ts";
import {
  entryId, forgetEntries, parseEntries, parseMemoId, readCatalogue, readMemo, readNotes,
  resolveStores, restoreEntry, updateMemo, writeNote,
} from "../store.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-remember-frontmatter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = resolveStores(join(root, "project"), join(root, "global"), ".pi");
  return { root, stores, local: stores.local, global: stores.global };
}
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function absent(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

// Fixed clocks make date boundaries and timestamp/no-op assertions deterministic.
test("frontmatter: optional explicit slug always receives the UTC creation date, without an automatic H1", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-12-31T20:30:00-04:00") });
  const { stores, local } = await fixture(t);
  const written = await writeNote(local, '  Kiln: "safety" # handbook  ', "  Plain body\n\n## User section\nKeep this.  ", "ceramic-safety");
  assert.equal(written.duplicate, false);
  assert.equal(written.noteRel, "notes/2031-01-01-ceramic-safety.md");
  assert.ok(written.notePath);
  assert.ok(written.id);
  const raw = await readFile(written.notePath, "utf8");
  assert.deepEqual(parseNote(raw), {
    metadata: { description: 'Kiln: "safety" # handbook', id: written.id,
      created: "2031-01-01T00:30:00.000Z", modified: "2031-01-01T00:30:00.000Z" },
    body: "Plain body\n\n## User section\nKeep this.\n",
  });
  assert.doesNotMatch(raw, /^# /m);
  await absent(local.memoryFile);
  const read = await readMemo(stores, written.id, ["local"]);
  assert.equal(read.status, "found");
  if (read.status !== "found") return;
  assert.equal(read.noteRel, written.noteRel);
  assert.equal(read.noteText, raw);
  assert.equal(entryId(read.entry), written.id);
  const fallback = await writeNote(local, "Basalt optics reference", "# Deliberate user heading\n\nDetails.");
  assert.equal(fallback.noteRel, "notes/2031-01-01-basalt-optics-reference.md");
  assert.equal(parseNote(await readFile(fallback.notePath!, "utf8"))!.body, "# Deliberate user heading\n\nDetails.\n");
  await absent(local.memoryFile);
});

test("frontmatter: invalid explicit slugs fail before any directory or file is created", async t => {
  const { root, local } = await fixture(t);
  for (const slug of ["", " ", "../escape", "notes/topic", "/absolute", "topic.md", "a\\b", "-leading", "trailing-", "two--parts", "a_b", "a\nb", "x".repeat(81)]) {
    await assert.rejects(writeNote(local, "Valid description", "Valid body", slug), { name: "InvalidNoteSlugError" }, slug);
    assert.deepEqual(await readdir(root), [], slug);
  }
});

test("frontmatter: explicit slug collisions use numbered suffixes and never overwrite orphan or live note bytes", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2031-01-01T00:30:00Z") });
  const { local } = await fixture(t);
  const orphan = join(local.notesDir, "2031-01-01-shared-slug.md");
  await put(orphan, "Unindexed historical bytes\r\n");
  const first = await writeNote(local, "Copper thermal protocol", "First content", "shared-slug");
  const firstBytes = await readFile(first.notePath!);
  const second = await writeNote(local, "Violet optical reference", "Second content", "shared-slug");
  assert.equal(first.noteRel, "notes/2031-01-01-shared-slug-2.md");
  assert.equal(second.noteRel, "notes/2031-01-01-shared-slug-3.md");
  assert.notEqual(first.id, second.id);
  assert.equal(await readFile(orphan, "utf8"), "Unindexed historical bytes\r\n");
  assert.deepEqual(await readFile(first.notePath!), firstBytes);
  assert.equal(parseNote(await readFile(second.notePath!, "utf8"))!.body, "Second content\n");
  const files = await readdir(local.notesDir);
  const duplicate = await writeNote(local, "Copper thermal protocol", "Never overwrite", "unused-slug");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.noteRel, first.noteRel);
  assert.deepEqual(await readdir(local.notesDir), files);
  assert.deepEqual(await readFile(first.notePath!), firstBytes);
  await absent(local.memoryFile);
});

test("frontmatter: update advances only modified-date; no-ops retain exact bytes, timestamps and recovery state", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2031-01-01T00:30:00Z") });
  const { stores, global } = await fixture(t);
  const written = await writeNote(global, "Immutable note identity", "# User heading\n\nOriginal details", "stable-path");
  const path = written.notePath!;
  const original = await readFile(path, "utf8");
  const initial = parseNote(original)!;
  const initialStat = await lstat(path);
  t.mock.timers.tick(5000);
  assert.equal((await updateMemo(global, written.id!, " \n# User heading\n\nOriginal details\n ")).status, "unchanged");
  assert.equal(await readFile(path, "utf8"), original);
  const noOpStat = await lstat(path);
  assert.equal(noOpStat.ino, initialStat.ino);
  assert.equal(noOpStat.mtimeMs, initialStat.mtimeMs);
  assert.equal(noOpStat.ctimeMs, initialStat.ctimeMs);
  await absent(global.recoveryDir);
  const result = await updateMemo(global, written.id!, "Changed details\n\n## New user section");
  assert.equal(result.status, "updated");
  if (result.status !== "updated") return;
  const changedText = await readFile(path, "utf8");
  const changed = parseNote(changedText)!;
  assert.deepEqual(changed.metadata, { ...initial.metadata, modified: "2031-01-01T00:30:05.000Z" });
  assert.equal(changed.body, "Changed details\n\n## New user section\n");
  const found = await readMemo(stores, written.id!, ["global"]);
  assert.equal(found.status, "found");
  if (found.status === "found") {
    assert.equal(found.notePath, path);
    assert.equal(found.noteRel, written.noteRel);
    assert.equal(found.noteText, changedText);
    assert.equal(found.entry.line, written.indexLine);
  }
  const recoveryPath = join(global.recoveryDir, `${result.recoveryId}.json`);
  const recoveryBytes = await readFile(recoveryPath);
  const record = JSON.parse(recoveryBytes.toString());
  assert.equal(record.before, original);
  assert.equal(record.after, changedText);
  const changedStat = await lstat(path);
  t.mock.timers.tick(60000);
  assert.equal((await updateMemo(global, written.id!, ` \n${changed.body}\t`)).status, "unchanged");
  assert.equal(await readFile(path, "utf8"), changedText);
  assert.equal((await lstat(path)).mtimeMs, changedStat.mtimeMs);
  assert.equal((await lstat(path)).ino, changedStat.ino);
  assert.deepEqual(await readdir(global.recoveryDir), [`${result.recoveryId}.json`]);
  assert.deepEqual(await readFile(recoveryPath), recoveryBytes);
  assert.equal((await restoreEntry(stores, result.recoveryId, undefined, ["global"]))?.status, "restored");
  assert.equal(await readFile(path, "utf8"), original, "undo recovers original metadata dates and body bytes");
  await absent(global.memoryFile);
});

test("frontmatter: forgetting a note-only global store removes the file, catalogue and search hit, and undo restores exact bytes", async t => {
  const { stores, global } = await fixture(t);
  const written = await writeNote(global, "Zirconium workshop reference", "The kiln uses mullite shelves.");
  const original = await readFile(written.notePath!, "utf8");
  assert.equal((await searchStores(stores, "mullite", ["global"])).length, 1);
  const forgotten = await forgetEntries(global, written.id!);
  assert.equal(forgotten.removed.length, 1);
  assert.ok(forgotten.recoveryId);
  await absent(written.notePath!);
  assert.equal(await readCatalogue(global), "");
  assert.equal((await readMemo(stores, written.id!, ["global"])).status, "error");
  for (const query of ["mullite", "zirconium"]) assert.deepEqual(await searchStores(stores, query, ["global"]), []);
  const recordPath = join(global.recoveryDir, `${forgotten.recoveryId}.json`);
  assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")).notes, [{ rel: written.noteRel, text: original, mode: 0o600 }]);
  // Later user files at the old path must never be overwritten by deletion undo.
  await put(written.notePath!, "Manual replacement must survive\r\n");
  assert.equal((await restoreEntry(stores, forgotten.recoveryId, undefined, ["global"]))?.status, "error");
  assert.equal(await readFile(written.notePath!, "utf8"), "Manual replacement must survive\r\n");
  await lstat(recordPath);
  await rm(written.notePath!);
  assert.equal((await restoreEntry(stores, forgotten.recoveryId, undefined, ["global"]))?.status, "restored");
  assert.equal(await readFile(written.notePath!, "utf8"), original);
  assert.equal((await searchStores(stores, "mullite", ["global"]))[0]?.id, written.id);
  assert.equal(parseEntries(await readCatalogue(global)).length, 1);
  await absent(global.memoryFile);
  await absent(recordPath);
});

test("frontmatter: readNotes derives metadata only, recursively and without following escaped note paths", async t => {
  const { root, stores, local, global } = await fixture(t);
  const metadata = { description: "Header-only catalogue", id: parseMemoId("abcdef01")!,
    created: "2024-01-01T00:00:00Z", modified: "2025-01-01T00:00:00Z" };
  const body = "PRIVATE_BODY_SENTINEL\n" + "x".repeat(2 * 1024 * 1024);
  const path = join(local.notesDir, "nested", "inside.md");
  await put(path, serializeNote(metadata, body));
  await put(join(local.notesDir, "legacy.md"), "Legacy body has no metadata\n");
  await put(join(local.notesDir, "ignored.txt"), "---\nNot a valid note header\n");
  const outside = join(root, "external", "outside.md");
  await put(outside, serializeNote({ ...metadata, id: parseMemoId("deadbeef")! }, "External private body"));
  await symlink(outside, join(local.notesDir, "escape.md"));
  await symlink(dirname(outside), join(local.notesDir, "escape-directory"));
  const records = await readNotes(local);
  assert.deepEqual(records, [{ metadata, path, rel: "notes/nested/inside.md",
    entry: { meta: "<!-- 2024-01-01T00:00:00Z [abcdef01] -->", line: "#note [[notes/nested/inside.md]] Header-only catalogue" } }]);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_BODY_SENTINEL|External private body/);
  const catalogue = await readCatalogue(local);
  assert.match(catalogue, /Header-only catalogue/);
  assert.doesNotMatch(catalogue, /PRIVATE_BODY_SENTINEL|deadbeef|legacy\.md|escape/);
  assert.equal((await readMemo(stores, "deadbeef", ["local"])).status, "error");
  await mkdir(global.dir);
  await symlink(dirname(outside), global.notesDir);
  assert.deepEqual(await readNotes(global), []);
  assert.equal(await readCatalogue(global), "");
  await absent(local.memoryFile);
  await absent(global.memoryFile);
});

test("frontmatter: raw legacy readMemo is observational and a new writer leaves the old index unchanged", async t => {
  const { stores, local } = await fixture(t);
  const index = "<!-- 2024-01-01T00:00:00Z [1234abcd] -->\r\n#note [[notes/old.md]] Legacy furnace guide\r\n";
  const body = "<!-- pi-remember note: 2024-01-01T00:00:00Z -->\r\n# Old generated title\r\n\r\nLegacy bytes\r\n";
  await put(local.memoryFile, index);
  await put(join(local.notesDir, "old.md"), body);
  const before = await lstat(local.memoryFile);
  const found = await readMemo(stores, "1234abcd", ["local"]);
  assert.equal(found.status, "found");
  if (found.status === "found") assert.equal(found.noteText, body);
  assert.equal(await readFile(local.memoryFile, "utf8"), index);
  assert.equal((await lstat(local.memoryFile)).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(join(local.notesDir, "old.md"), "utf8"), body);
  await absent(join(local.dir, "pi-remember.json"));
  await absent(join(local.dir, "migrations"));
  const written = await writeNote(local, "Quartz optics protocol", "New standalone body");
  assert.ok(parseNote(await readFile(written.notePath!, "utf8")));
  assert.equal(await readFile(local.memoryFile, "utf8"), index);
  assert.equal(parseEntries(await readCatalogue(local)).length, 2);
  await absent(join(local.dir, "pi-remember.json"));
});
