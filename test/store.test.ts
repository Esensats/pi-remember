import { strict as assert } from "node:assert";
import { parseNote } from "../notes.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  appendEntry,
  findDuplicates,
  findSimilar,
  forgetEntries,
  normalizeForCompare,
  parseEntries,
  readMemoryText,
  readCatalogue,
  resolveNotePath,
  restoreEntry,
  resolveStores,
  serializeEntries,
  slugifyTitle,
  statMemory,
  writeNote,
} from "../store.ts";

test("parseEntries: meta + facts, skips blanks", () => {
  const text = "<!-- 2026-01-01T00:00:00Z [abcd1234] -->\n#fact First line\n\n\n#fact Second line\n";
  const entries = parseEntries(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].meta, "<!-- 2026-01-01T00:00:00Z [abcd1234] -->");
  assert.equal(entries[0].line, "#fact First line");
  assert.equal(entries[1].meta, undefined);
});

test("serializeEntries roundtrips", () => {
  const entries = parseEntries("<!-- m1 -->\nline one\n\nline two\n");
  const ser = serializeEntries(entries);
  const again = parseEntries(ser);
  assert.deepEqual(again, entries);
});

test("normalizeForCompare strips tags and links", () => {
  assert.equal(normalizeForCompare("#preference [[pm]] Use pnpm always."), "use pnpm always");
  assert.equal(normalizeForCompare("Use   PNP-m!"), "use pnp m");
});

test("findDuplicates: exact, containment both ways", () => {
  const existing = parseEntries("#preference Always use pnpm in this repo.");
  assert.equal(findDuplicates(existing, "always use pnpm in this repo").length, 1);
  assert.equal(findDuplicates(existing, "Always use pnpm in this repo, never npm.").length, 1);
  assert.equal(findDuplicates(existing, "Use yarn").length, 0);
});

test("findSimilar: containment with >=50% overlap, excludes exact", () => {
  const existing = parseEntries(
    "#note [[notes/x.md]] pi.dev catalog staleness: symptoms + fixes\nUser prefers dark mode in terminals.",
  );
  // same fact family, slightly rephrased -> similar
  assert.equal(
    findSimilar(existing, "pi.dev catalog staleness: new model missing (glm-5.3-flash case)").length,
    1,
  );
  // exact match -> not "similar" (dedupe handles it)
  assert.equal(findSimilar(existing, "pi.dev catalog staleness: symptoms + fixes").length, 0);
  // unrelated -> no hit
  assert.equal(findSimilar(existing, "Repository uses trunk-based development").length, 0);
  // too-short containment -> no hit
  assert.equal(findSimilar(existing, "dark").length, 0);
});

test("append/read/forget/restore lifecycle in tmpdir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remember-"));
  const stores = resolveStores(dir, join(dir, "global-mem"), ".pi");
  try {
    const r1 = await appendEntry(stores.local, "#preference Use pnpm always.");
    assert.equal(r1.duplicate, false);

    const dup = await appendEntry(stores.local, "use pnpm always");
    assert.equal(dup.duplicate, true);

    const r2 = await appendEntry(stores.global, "#fact User is on Arch Linux.");
    assert.equal(r2.duplicate, false);

    const localText = await readMemoryText(stores.local);
    assert.match(localText, /pnpm/);
    assert.match(localText, /<!-- /);

    const stat = await statMemory(stores.local);
    assert.equal(stat.entries, 1);
    assert.equal(stat.exists, true);

    const forget = await forgetEntries(stores.local, "pnpm");
    assert.equal(forget.removed.length, 1);
    assert.ok(forget.recoveryId);
    assert.equal(parseEntries(await readMemoryText(stores.local)).length, 0);

    // recovery file exists
    const rec = JSON.parse(
      await readFile(join(stores.local.recoveryDir, `${forget.recoveryId}.json`), "utf8"),
    ) as { scope: string; entries: { line: string }[] };
    assert.equal(rec.scope, "local");
    assert.equal(rec.entries[0].line, "#preference Use pnpm always.");

    const restored = await restoreEntry(stores, forget.recoveryId);
    assert.ok(restored);
    assert.equal(restored.status, "restored");
    assert.ok(restored.status === "restored");
    assert.equal(restored.entries.length, 1);
    assert.equal(parseEntries(await readMemoryText(stores.local)).length, 1);

    // restore unknown id -> null
    assert.equal(await restoreEntry(stores, "nope"), null);

    // forget with no match
    const none = await forgetEntries(stores.local, "zzz-nothing");
    assert.equal(none.removed.length, 0);
    assert.equal(none.recoveryId, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendEntry collapses whitespace to one line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remember-ws-"));
  const stores = resolveStores(dir, join(dir, "global-mem"), ".pi");
  try {
    await appendEntry(stores.local, "line one\nline two\n\n");
    const text = await readMemoryText(stores.local);
    assert.match(text, /line one line two/);
    assert.equal(parseEntries(text).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("slugifyTitle normalizes and caps", () => {
  assert.equal(slugifyTitle("Pi.dev model catalog: symptoms + fixes!"), "pi-dev-model-catalog-symptoms-fixes");
  assert.equal(slugifyTitle("  "), "note");
  assert.ok(slugifyTitle("x".repeat(200)).length <= 48);
});

test("writeNote creates one standalone note and returns duplicates without writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remember-note-"));
  const stores = resolveStores(dir, join(dir, "global-mem"), ".pi");
  try {
    const r1 = await writeNote(stores.local, "Build system quirks", "# Build\n\nUse make -j4.\n");
    assert.equal(r1.duplicate, false);
    assert.match(r1.noteRel, /^notes\/\d{4}-\d{2}-\d{2}-build-system-quirks\.md$/);
    assert.match(r1.indexLine, /#note \[\[notes\//);

    assert.ok(r1.notePath);
    const noteText = await readFile(r1.notePath, "utf8");
    const parsed = parseNote(noteText);
    assert.ok(parsed);
    assert.equal(parsed.metadata.description, "Build system quirks");
    assert.equal(parsed.metadata.id, r1.id);
    assert.equal(parsed.body, "# Build\n\nUse make -j4.\n");
    assert.doesNotMatch(parsed.body, /# Build system quirks/);
    await assert.rejects(readFile(stores.local.memoryFile), { code: "ENOENT" });

    const catalogue = parseEntries(await readCatalogue(stores.local));
    assert.equal(catalogue.length, 1);
    assert.equal(catalogue[0].line, r1.indexLine);

    // Same title again -> original reference; no new file or overwrite.
    const r2 = await writeNote(stores.local, "Build system quirks", "different");
    assert.equal(r2.duplicate, true);
    assert.equal(r1.noteRel, r2.noteRel);
    assert.equal(await readFile(r1.notePath, "utf8"), noteText);
    assert.equal(parseEntries(await readCatalogue(stores.local)).length, 1);
    await assert.rejects(readFile(stores.local.memoryFile), { code: "ENOENT" });

    const stat = await statMemory(stores.local);
    assert.equal(stat.notesCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveNotePath: relative ok, absolute inside ok, traversal rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remember-path-"));
  const stores = resolveStores(dir, join(dir, "global-mem"), ".pi");
  try {
    await mkdir(stores.global.notesDir, { recursive: true });
    await writeFile(join(stores.global.notesDir, "foo.md"), "Existing note\n");
    const rel = resolveNotePath(stores, "notes/foo.md");
    assert.equal(rel.status, "found");
    assert.ok(rel.status === "found");
    assert.equal(rel.store.scope, "global");
    assert.equal(rel.rel, "notes/foo.md");

    const abs = resolveNotePath(stores, rel.absPath);
    assert.equal(abs.status, "found");

    assert.equal(resolveNotePath(stores, "../../etc/passwd").status, "error");
    assert.equal(resolveNotePath(stores, "/etc/passwd").status, "error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
