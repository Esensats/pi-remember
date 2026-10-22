import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isNoteTimestamp, legacyNote, parseNote, serializeNote, type NoteMetadata } from "./notes.ts";
import type { MemoId, MemoryEntry, StorePaths } from "./store.ts";

export const CURRENT_VERSION = 1;
const VERSION_FILE = "pi-remember.json";
const LOCK_FILE = ".pi-remember-migration.lock";
const inFlight = new Map<string, Promise<void>>();

export class StoreMigrationError extends Error {
  constructor(message: string) { super(message); this.name = "StoreMigrationError"; }
}
function fail(message: string): never { throw new StoreMigrationError(`Memory migration: ${message}`); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function missing(error: unknown): boolean { return object(error) && error.code === "ENOENT"; }
function memoId(value: unknown): MemoId | undefined {
  return typeof value === "string" && /^[a-f0-9]{8}$/i.test(value) ? value.toLowerCase() as MemoId : undefined;
}
function canonical(metadata: NoteMetadata): string { return `<!-- ${metadata.created} [${metadata.id}] -->`; }
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }

interface Snapshot { rel: string; bytes: Buffer; text: string; mode: number; modified: string }
interface Reference { rel: string; title: string; meta?: string; id?: MemoId; created?: string }
interface NoteState { rel: string; metadata: NoteMetadata; text: string; source?: Snapshot; inactive: boolean }
interface Recovery { source: Snapshot; record: Record<string, unknown>; refs: Reference[]; snapshots: Map<string, string> }

/** Reject noncanonical paths instead of silently normalizing traversal or aliases. */
function safeRel(rel: string): string {
  if (!rel || isAbsolute(rel) || rel.includes("\\") || /[\x00-\x1f\x7f]/.test(rel) ||
      rel.split("/").some((part) => !part || part === "." || part === "..")) fail(`unsafe path: ${rel}`);
  return rel;
}
function noteRel(rel: string): string {
  safeRel(rel);
  if (!rel.startsWith("notes/") || !rel.endsWith(".md")) fail(`unsafe note reference: ${rel}`);
  return rel;
}
function metadataComment(meta?: string): { id?: MemoId; created?: string } {
  if (!meta) return {};
  const id = memoId(meta.match(/\[([^\]]+)\]/)?.[1]);
  const stamp = meta.match(/^<!--\s+(\d{4}-\S+)/)?.[1];
  if (stamp && !isNoteTimestamp(stamp)) fail(`invalid index metadata timestamp: ${stamp}`);
  return { id, created: stamp };
}
function reference(entry: MemoryEntry): Reference | null {
  if (!/^\s*#note\b/.test(entry.line)) return null;
  const match = /^\s*#note[ \t]+\[\[([^\]]+)\]\](?:[ \t]+(.*?))?[ \t]*$/.exec(entry.line);
  if (!match) fail(`malformed note reference: ${entry.line}`);
  const rel = noteRel(match[1]);
  const info = metadataComment(entry.meta);
  if (entry.meta?.includes("[") && !info.id) fail(`invalid memo ID for ${rel}`);
  return { rel, title: match[2]?.trim() ?? "", meta: entry.meta, ...info };
}

/** Preserve every unrelated byte, including blank lines and user comments. */
function indexPlan(text: string): { text: string; refs: Map<string, Reference>; factIds: Set<MemoId> } {
  const lines = [...text.matchAll(/[^\n]*\n|[^\n]+$/g)].map((m) => ({ raw: m[0], line: m[0].replace(/\r?\n$/, ""), start: m.index! }));
  const refs = new Map<string, Reference>();
  const ids = new Set<MemoId>(), factIds = new Set<MemoId>(), removed = new Set<number>();
  let pending: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) { pending = i; continue; }
    const meta = pending === undefined ? undefined : lines[pending].line.trim();
    const ref = reference({ line: lines[i].line, meta });
    const id = ref?.id ?? memoId(meta?.match(/\[([a-f0-9]{8})\]/i)?.[1]);
    if (id) {
      if (ids.has(id)) fail(`duplicate memo ID in MEMORY.md: ${id}`);
      ids.add(id);
      if (!ref) factIds.add(id);
    }
    if (ref) {
      if (refs.has(ref.rel)) fail(`duplicate note reference: ${ref.rel}`);
      refs.set(ref.rel, ref);
      removed.add(i);
      // Only managed metadata is ours to remove. A generic user comment is not.
      if (pending !== undefined && (ref.id || ref.created)) removed.add(pending);
    }
    pending = undefined;
  }
  return { text: lines.filter((_, i) => !removed.has(i)).map((line) => line.raw).join(""), refs, factIds };
}

/** All migration I/O is store-relative; symlinks (including internal aliases) are conservatively refused. */
class Files {
  readonly snapshots = new Map<string, Snapshot | null>();
  readonly root: string;
  constructor(root: string) { this.root = root; }

  async check(rel: string): Promise<boolean> {
    safeRel(rel);
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      const path = join(this.root, ...parts.slice(0, i + 1));
      let info;
      try { info = await lstat(path); } catch (error) { if (missing(error)) return false; throw error; }
      if (info.isSymbolicLink()) fail(`symlink is not safe for migration: ${rel}`);
      if (i < parts.length - 1 && !info.isDirectory()) fail(`not a directory: ${path}`);
    }
    return true;
  }

  async read(rel: string): Promise<Snapshot | null> {
    if (this.snapshots.has(rel)) return this.snapshots.get(rel)!;
    if (!await this.check(rel)) { this.snapshots.set(rel, null); return null; }
    if (!(await lstat(join(this.root, rel))).isFile()) fail(`not a regular file: ${rel}`);
    const handle = await open(join(this.root, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) fail(`not a regular file: ${rel}`);
      const bytes = await handle.readFile();
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { fail(`invalid UTF-8: ${rel}`); }
      const result = { rel, bytes, text, mode: info.mode & 0o7777, modified: info.mtime.toISOString() };
      this.snapshots.set(rel, result);
      return result;
    } finally { await handle.close(); }
  }

  async list(rel: string): Promise<string[]> {
    if (!await this.check(rel)) return [];
    if (!(await lstat(join(this.root, rel))).isDirectory()) fail(`not a directory: ${rel}`);
    return (await readdir(join(this.root, rel))).sort();
  }

  async notes(rel = "notes"): Promise<Snapshot[]> {
    const result: Snapshot[] = [];
    for (const name of await this.list(rel)) {
      const child = `${rel}/${name}`;
      await this.check(child);
      const info = await lstat(join(this.root, child));
      if (info.isDirectory()) result.push(...await this.notes(child));
      else if (name.endsWith(".md")) result.push((await this.read(child))!);
    }
    return result;
  }
}

async function version(files: Files): Promise<number> {
  const file = await files.read(VERSION_FILE);
  if (!file) return 0;
  let value: unknown;
  try { value = JSON.parse(file.text); } catch { fail(`malformed ${VERSION_FILE}: expected {"version": number}`); }
  if (!object(value) || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 0)
    fail(`invalid store version in ${VERSION_FILE}; expected a nonnegative safe integer`);
  if (value.version > CURRENT_VERSION) fail(`future store version ${value.version}; supported version is ${CURRENT_VERSION}`);
  return value.version;
}

function entries(value: unknown): MemoryEntry[] {
  if (!Array.isArray(value) || !value.every((entry) => object(entry) && typeof entry.line === "string" &&
      !/[\r\n]/.test(entry.line) && (entry.meta === undefined || (typeof entry.meta === "string" && !/[\r\n]/.test(entry.meta)))))
    fail("malformed recovery entries");
  return value as MemoryEntry[];
}

async function recoveries(files: Files, scope: StorePaths["scope"]): Promise<Recovery[]> {
  const result: Recovery[] = [];
  for (const name of await files.list("recovery")) {
    if (!name.endsWith(".json")) continue;
    const source = (await files.read(`recovery/${name}`))!;
    let record: unknown;
    try { record = JSON.parse(source.text); } catch { fail(`malformed recovery JSON: ${source.rel}`); }
    if (!object(record) || !memoId(record.id) || record.id !== basename(name, ".json") || record.scope !== scope ||
        typeof record.timestamp !== "string" || !isNoteTimestamp(record.timestamp)) fail(`invalid recovery record: ${source.rel}`);
    const refs: Reference[] = [], snapshots = new Map<string, string>();
    if (record.kind === "update") {
      if (!memoId(record.memoId) || typeof record.before !== "string" || typeof record.after !== "string" ||
          (record.noteRel !== undefined && typeof record.noteRel !== "string") ||
          (record.meta !== undefined && (typeof record.meta !== "string" || /[\r\n]/.test(record.meta))))
        fail(`invalid update recovery: ${source.rel}`);
      if (typeof record.noteRel === "string") noteRel(record.noteRel);
    } else {
      if (record.kind !== undefined && record.kind !== "forget") fail(`unknown recovery kind: ${source.rel}`);
      const seen = new Set<string>(), ids = new Set<MemoId>();
      for (const entry of entries(record.entries)) {
        const ref = reference(entry);
        const id = ref?.id ?? metadataComment(entry.meta).id;
        if (id && ids.has(id)) fail(`duplicate recovery memo ID: ${id}`);
        if (id) ids.add(id);
        if (ref) {
          if (seen.has(ref.rel)) fail(`duplicate recovery note reference: ${ref.rel}`);
          seen.add(ref.rel); refs.push(ref);
        }
      }
      if (record.notes !== undefined) {
        if (!Array.isArray(record.notes)) fail(`invalid recovery notes: ${source.rel}`);
        for (const note of record.notes) {
          if (!object(note) || typeof note.rel !== "string" || typeof note.text !== "string") fail(`invalid recovery note: ${source.rel}`);
          noteRel(note.rel);
          if (snapshots.has(note.rel)) fail(`duplicate recovery note: ${note.rel}`);
          if (!parseNote(note.text)) fail(`recovery note must have frontmatter: ${note.rel}`);
          snapshots.set(note.rel, note.text);
        }
        for (const ref of refs) if (!snapshots.has(ref.rel)) fail(`missing recovery note snapshot: ${ref.rel}`);
      }
    }
    result.push({ source, record, refs, snapshots });
  }
  return result;
}

/** Build and validate the ENTIRE plan before making even a backup directory. */
async function plan(files: Files, store: StorePaths, memoryRel: string): Promise<Map<string, string | null>> {
  const memory = await files.read(memoryRel);
  const index = indexPlan(memory?.text ?? "");
  const disk = await files.notes();
  const records = await recoveries(files, store.scope);
  const deletedRefs = new Map<string, Reference[]>(), saved = new Map<string, string>();
  for (const recovery of records) {
    for (const ref of recovery.refs) deletedRefs.set(ref.rel, [...deletedRefs.get(ref.rel) ?? [], ref]);
    for (const [rel, text] of recovery.snapshots) {
      if (saved.has(rel) && saved.get(rel) !== text) fail(`conflicting deletion snapshots for ${rel}`);
      saved.set(rel, text);
    }
  }
  const byPath = new Map(disk.map((file) => [file.rel, file]));
  for (const ref of index.refs.values()) if (!byPath.has(ref.rel)) fail(`dangling note reference: ${ref.rel}`);
  for (const rel of deletedRefs.keys()) if (!byPath.has(rel) && !saved.has(rel)) fail(`dangling deleted note reference: ${rel}`);

  const states = new Map<string, NoteState>();
  const ids = new Map<MemoId, string>([...index.factIds].map((id) => [id, memoryRel]));
  // Reserve all known IDs before generating any IDs for genuinely unindexed old notes.
  const reserved = new Set<MemoId>(index.factIds);
  for (const ref of [...index.refs.values(), ...[...deletedRefs.values()].flat()]) if (ref.id) reserved.add(ref.id);
  for (const source of disk) { const parsed = parseNote(source.text); if (parsed) reserved.add(parsed.metadata.id); }
  for (const text of saved.values()) reserved.add(parseNote(text)!.metadata.id);

  for (const rel of [...new Set([...byPath.keys(), ...saved.keys()])].sort()) {
    const source = byPath.get(rel);
    const raw = source?.text ?? saved.get(rel)!;
    const parsed = parseNote(raw);
    const ref = index.refs.get(rel) ?? deletedRefs.get(rel)?.[0];
    let metadata: NoteMetadata, text: string;
    if (parsed) { metadata = parsed.metadata; text = raw; }
    else {
      const old = legacyNote(raw);
      let id = ref?.id;
      const prior = saved.get(rel);
      const priorMetadata = prior ? parseNote(prior)!.metadata : undefined;
      if (!id) id = priorMetadata?.id;
      if (!id) {
        do { id = randomUUID().slice(0, 8) as MemoId; } while (reserved.has(id));
        reserved.add(id);
      }
      // Legacy notes did not record last-modified. Infer it from the original file mtime;
      // when no creation timestamp exists, infer creation from that same mtime too.
      metadata = priorMetadata ?? {
        id, description: ref?.title || old.description || raw.match(/^# ([^\r\n]+)/m)?.[1] || basename(rel, ".md"),
        created: ref?.created ?? old.created ?? source!.modified, modified: source!.modified,
      };
      text = serializeNote(metadata, old.body);
    }
    for (const associated of [index.refs.get(rel), ...deletedRefs.get(rel) ?? []]) {
      if (associated?.id && associated.id !== metadata.id) fail(`note ID/reference mismatch: ${rel}`);
      if (associated?.created && associated.created !== metadata.created) fail(`note creation/reference mismatch: ${rel}`);
    }
    const duplicate = ids.get(metadata.id);
    if (duplicate) fail(`duplicate memo ID ${metadata.id}: ${duplicate} and ${rel}`);
    ids.set(metadata.id, rel);
    const inactive = !index.refs.has(rel) && (deletedRefs.has(rel) || saved.has(rel));
    if (inactive && saved.has(rel) && saved.get(rel) !== text) fail(`deleted note changed since recovery snapshot: ${rel}`);
    states.set(rel, { rel, source, metadata, text, inactive });
  }

  const changes = new Map<string, string | null>();
  // Recovery conversions are deliberately applied before note/index edits. A retry can
  // use their snapshots and IDs even if an inactive note was already removed.
  for (const recovery of records) {
    const { record, source } = recovery;
    let next: Record<string, unknown>;
    if (record.kind === "update") {
      if (typeof record.noteRel !== "string") continue;
      const state = states.get(record.noteRel);
      if (!state) fail(`dangling update recovery note: ${record.noteRel}`);
      const meta = metadataComment(record.meta as string | undefined);
      if (memoId(record.memoId) !== state.metadata.id || meta.id !== state.metadata.id || meta.created !== state.metadata.created)
        fail(`update recovery identity mismatch: ${source.rel}`);
      const oldMeta = index.refs.get(state.rel)?.meta ?? deletedRefs.get(state.rel)?.[0]?.meta;
      if (oldMeta && record.meta !== oldMeta && record.meta !== canonical(state.metadata))
        fail(`update recovery metadata conflict: ${source.rel}`);
      const convert = (raw: string): string => {
        const parsed = parseNote(raw);
        if (parsed) {
          if (parsed.metadata.id !== state.metadata.id) fail(`update recovery content ID mismatch: ${source.rel}`);
          return raw; // Existing frontmatter bytes must retain exact conflict semantics.
        }
        return serializeNote(state.metadata, legacyNote(raw).body);
      };
      const before = convert(record.before as string), after = convert(record.after as string);
      if (record.before !== record.after && before === after) fail(`update differs only in a managed legacy header: ${source.rel}`);
      if (record.migrationLegacyAfterSha256 !== undefined &&
          (typeof record.migrationLegacyAfterSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.migrationLegacyAfterSha256)))
        fail(`invalid legacy update fingerprint: ${source.rel}`);
      // Retain the old byte identity across an interruption after recovery was
      // rewritten but before the note was replaced. Header edits must not vanish.
      const legacyAfterHash = !parseNote(record.after as string) ? digest(record.after as string) : record.migrationLegacyAfterSha256;
      if (state.source && !parseNote(state.source.text) && legacyAfterHash &&
          digest(state.source.text) !== legacyAfterHash && state.text === after)
        fail(`update recovery would hide a legacy header conflict: ${source.rel}`);
      next = { ...record, meta: canonical(state.metadata), before, after,
        ...(legacyAfterHash ? { migrationLegacyAfterSha256: legacyAfterHash } : {}) };
    } else {
      const snapshots = new Map(recovery.snapshots);
      const convertedEntries = entries(record.entries).map((entry) => {
        const ref = reference(entry);
        if (!ref) return entry;
        const state = states.get(ref.rel)!;
        const text = snapshots.get(ref.rel) ?? state.text;
        const metadata = parseNote(text)!.metadata;
        if (ref.id && ref.id !== metadata.id) fail(`deletion recovery ID mismatch: ${source.rel}`);
        snapshots.set(ref.rel, text);
        return { line: `#note [[${ref.rel}]] ${metadata.description}`, meta: canonical(metadata) };
      });
      for (const [rel, text] of snapshots) {
        if (!recovery.refs.some((ref) => ref.rel === rel)) {
          const metadata = parseNote(text)!.metadata;
          convertedEntries.push({ line: `#note [[${rel}]] ${metadata.description}`, meta: canonical(metadata) });
        }
      }
      const entryIds = new Set<MemoId>();
      for (const entry of convertedEntries) {
        const id = metadataComment(entry.meta).id;
        if (id && entryIds.has(id)) fail(`duplicate deletion recovery memo ID: ${id}`);
        if (id) entryIds.add(id);
      }
      next = { ...record, kind: "forget", entries: convertedEntries, notes: [...snapshots].map(([rel, text]) => ({ rel, text })) };
    }
    const text = JSON.stringify(next, null, 2) + "\n";
    if (text !== source.text) changes.set(source.rel, text);
  }
  for (const state of states.values()) {
    if (!state.source) continue;
    if (state.inactive) changes.set(state.rel, null);
    else if (state.text !== state.source.text) changes.set(state.rel, state.text);
  }
  if (memory && memory.text !== index.text) changes.set(memoryRel, index.text);
  changes.set(VERSION_FILE, JSON.stringify({ version: CURRENT_VERSION }, null, 2) + "\n");
  return changes;
}

async function newFile(path: string, content: string | Buffer, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try { await handle.writeFile(content); await handle.chmod(mode); await handle.sync(); }
  finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function apply(files: Files, changes: Map<string, string | null>): Promise<void> {
  await files.check("migrations");
  await mkdir(join(files.root, "migrations"), { recursive: true, mode: 0o700 });
  const backupRel = `migrations/v0-to-v1-${randomUUID()}`;
  await mkdir(join(files.root, backupRel), { mode: 0o700 });
  const manifest = [];
  const backupDirs = new Set([files.root, join(files.root, "migrations"), join(files.root, backupRel)]);
  // Back up ALL affected originals before modifying ANY originals. Every run gets
  // its own immutable (exclusive-created) backup set, including on partial retries.
  for (const [rel, text] of changes) {
    const source = files.snapshots.get(rel);
    const backup = source ? `files/${rel}` : null;
    if (source) {
      const target = join(files.root, backupRel, backup!);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await newFile(target, source.bytes, 0o400);
      for (let dir = dirname(target); dir.startsWith(join(files.root, backupRel) + sep); dir = dirname(dir)) backupDirs.add(dir);
    }
    manifest.push({ rel, backup, existed: !!source, mode: source?.mode ?? null,
      modified: source?.modified ?? null, action: text === null ? "remove" : "replace" });
  }
  await newFile(join(files.root, backupRel, "manifest.json"), JSON.stringify({
    fromVersion: 0, toVersion: CURRENT_VERSION, timestamp: new Date().toISOString(),
    inference: "Legacy modified dates use original filesystem mtime; creation falls back to mtime when index/generated timestamps are absent.",
    files: manifest,
  }, null, 2) + "\n", 0o400);
  for (const dir of [...backupDirs].sort((a, b) => b.length - a.length)) await syncDirectory(dir);

  // Detect edits during planning/backups instead of overwriting them. This is not a
  // substitute for the caller's ordinary mutation queue; the lock serializes migrators.
  const verify = new Files(files.root);
  for (const [rel, original] of files.snapshots) {
    const current = await verify.read(rel);
    if ((original === null) !== (current === null) || (original && current &&
        (!original.bytes.equals(current.bytes) || original.mode !== current.mode || original.modified !== current.modified)))
      fail(`file changed while preparing migration: ${rel}; backups retained`);
  }
  for (const [rel, text] of changes) {
    await files.check(rel);
    const path = join(files.root, rel);
    if (text === null) { await unlink(path); await syncDirectory(dirname(path)); continue; }
    const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await newFile(temp, text, files.snapshots.get(rel)?.mode ?? 0o600);
      await rename(temp, path);
      await syncDirectory(dirname(path));
    } finally {
      try { await unlink(temp); } catch (error) { if (!missing(error)) throw error; }
    }
  }
}

async function migrate(root: string, store: StorePaths): Promise<void> {
  if (await version(new Files(root)) === CURRENT_VERSION) return;
  const lock = join(root, LOCK_FILE);
  let handle;
  try { handle = await open(lock, "wx", 0o600); }
  catch (error) {
    if (object(error) && error.code === "EEXIST") fail(`migration lock already exists: ${lock}. Another process may be migrating; inspect it manually (locks are never stolen).`);
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }) + "\n");
    const files = new Files(root);
    if (await version(files) === CURRENT_VERSION) return;
    const configuredRoot = resolve(store.dir);
    const configured = (path: string): string => {
      const rel = relative(configuredRoot, resolve(path)).split(sep).join("/");
      return safeRel(rel);
    };
    if (configured(store.notesDir) !== "notes" || configured(store.recoveryDir) !== "recovery")
      fail("expected notes/ and recovery/ directories inside the store");
    const changes = await plan(files, store, configured(store.memoryFile));
    await apply(files, changes);
  } finally {
    try { await handle.close(); } finally { await unlink(lock); }
  }
}

/** Read-only guard for optional context: never inject a legacy, invalid or future store. */
export async function assertCurrentStoreVersion(store: StorePaths): Promise<void> {
  let root: string;
  try { root = await realpath(store.dir); }
  catch (error) { if (missing(error)) return; throw error; }
  if (await version(new Files(root)) !== CURRENT_VERSION) fail("store has not been migrated; context omitted");
}

/** No missing-store creation, no permanent cache: every completed call rechecks the version. */
export async function ensureStoreVersion(store: StorePaths): Promise<void> {
  let root: string;
  try { root = await realpath(store.dir); }
  catch (error) { if (missing(error)) return; throw error; }
  if (!(await lstat(root)).isDirectory()) fail(`store is not a directory: ${store.dir}`);
  const existing = inFlight.get(root);
  if (existing) return existing;
  const operation = migrate(root, store);
  inFlight.set(root, operation);
  try { await operation; } finally { if (inFlight.get(root) === operation) inFlight.delete(root); }
}
