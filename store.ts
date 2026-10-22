import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { chmod, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, isAbsolute, relative, resolve, sep } from "node:path";
import { parseNote, readNoteHeader, serializeNote, type NoteMetadata } from "./notes.ts";
export type { NoteMetadata } from "./notes.ts";

export type Scope = "global" | "local";
export type MemoId = string & { readonly __memoId: unique symbol };

export function parseMemoId(input: string): MemoId | null {
  return /^[a-f0-9]{8}$/i.test(input) ? input.toLowerCase() as MemoId : null;
}

export function entryId(entry: MemoryEntry): MemoId | null {
  const match = entry.meta?.match(/\[([a-f0-9]{8})\]/i);
  return match ? parseMemoId(match[1]) : null;
}

export function noteReference(entry: MemoryEntry): string | null {
  return entry.line.match(/^#note\s+\[\[([^\]]+)\]\]/)?.[1] ?? null;
}

/** Atomic replacement, retaining permissions and following existing symlinks. */
async function replaceFile(path: string, content: string): Promise<void> {
  const target = realpathSync(path);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const mode = (await stat(target)).mode & 0o7777;
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await chmod(temporary, mode); // Creation mode alone is reduced by the process umask.
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Publish a complete file atomically without ever overwriting an existing pathname. */
async function createFileExclusive(path: string, content: string, mode = 0o600): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await chmod(temporary, mode);
    await link(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Check existing store-relative components without following links or creating directories. */
function assertNoRedirect(store: StorePaths, path: string): void {
  const rel = relative(resolve(store.dir), resolve(path));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new MemoryConflictError("Memory path is outside its store; refusing to use it.");
  }
  let current = store.dir;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new MemoryConflictError("Memory path contains a symlink; refusing to use it.");
      }
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

/** Notes/recovery may not be redirected through a symlink, even inside a versioned store. */
async function ensureOwnedDirectory(store: StorePaths, path: string, mode: number): Promise<void> {
  assertNoRedirect(store, path);
  await mkdir(path, { recursive: true, mode });
  assertNoRedirect(store, path);
}

export interface StorePaths {
  scope: Scope;
  dir: string;
  memoryFile: string;
  recoveryDir: string;
  notesDir: string;
}

export interface MemoryEntry {
  /** The `<!-- ... -->` comment line directly above this entry, if any. */
  meta?: string;
  /** Raw fact line (no trailing whitespace). */
  line: string;
}

export function resolveStores(
  cwd: string,
  globalDir: string,
  configDirName: string,
): Record<Scope, StorePaths> {
  const localDir = join(cwd, configDirName, "memory");
  return {
    global: {
      scope: "global",
      dir: globalDir,
      memoryFile: join(globalDir, "MEMORY.md"),
      recoveryDir: join(globalDir, "recovery"),
      notesDir: join(globalDir, "notes"),
    },
    local: {
      scope: "local",
      dir: localDir,
      memoryFile: join(localDir, "MEMORY.md"),
      recoveryDir: join(localDir, "recovery"),
      notesDir: join(localDir, "notes"),
    },
  };
}

/** Split raw MEMORY.md text into fact entries with their metadata comments. */
export function parseEntries(text: string): MemoryEntry[] {
  return entrySpans(text).map(({ entry }) => entry);
}

/** Locate entry lines so targeted changes preserve all unrelated bytes. */
function entrySpans(text: string): { entry: MemoryEntry; start: number; end: number }[] {
  const entries: { entry: MemoryEntry; start: number; end: number }[] = [];
  let pendingMeta: string | undefined;
  let start = 0;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) {
      pendingMeta = trimmed;
    } else if (trimmed.length > 0) {
      entries.push({ entry: { meta: pendingMeta, line: raw.replace(/\s+$/, "") }, start, end: start + raw.length });
      pendingMeta = undefined;
    }
    start += raw.length + (text.slice(start + raw.length, start + raw.length + 2) === "\r\n" ? 2 : 1);
  }
  return entries;
}

export function serializeEntries(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  return (
    entries.map((e) => `${e.meta ? `${e.meta}\n` : ""}${e.line}`).join("\n\n") + "\n"
  );
}

/** Normalize for dedupe: strip metadata/tags/links, lowercase, collapse whitespace. */
export function normalizeForCompare(line: string): string {
  return line
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/#[\w-]+/g, " ")
    .replace(/\[\[[\w\-/:.]+]]/g, " ")
    .toLowerCase()
    .replace(/[^\w]+/g, " ")
    .trim();
}

/** Existing entries that equal, contain, or are contained by the candidate. */
export function findDuplicates(existing: MemoryEntry[], candidate: string): MemoryEntry[] {
  const c = normalizeForCompare(candidate);
  if (c.length === 0) return [];
  return existing.filter((e) => {
    const n = normalizeForCompare(e.line);
    if (n.length === 0) return false;
    return n === c || n.includes(c) || c.includes(n);
  });
}

/**
 * Similar-but-not-identical entries for cross-scope warnings: either
 * normalized string containment with >=50% overlap, or token containment
 * (>=50% of the shorter entry's tokens appear in the other). Very short
 * entries are skipped — exact matches are handled by findDuplicates.
 */
export function findSimilar(existing: MemoryEntry[], candidate: string): MemoryEntry[] {
  const c = normalizeForCompare(candidate);
  if (c.length < 10) return [];
  const cTokens = new Set(c.split(" "));
  return existing.filter((e) => {
    const n = normalizeForCompare(e.line);
    if (n.length < 10 || n === c) return false;
    const shorter = Math.min(n.length, c.length);
    const longer = Math.max(n.length, c.length);
    if (shorter / longer >= 0.5 && (n.includes(c) || c.includes(n))) return true;
    const nTokens = new Set(n.split(" "));
    let inter = 0;
    for (const t of cTokens) if (nTokens.has(t)) inter++;
    return inter / Math.min(cTokens.size, nTokens.size) >= 0.5;
  });
}

export async function readMemoryText(store: StorePaths): Promise<string> {
  if (!existsSync(store.memoryFile)) return "";
  return readFile(store.memoryFile, "utf8");
}

export interface NoteRecord {
  entry: MemoryEntry;
  rel: string;
  path: string;
  metadata: NoteMetadata;
}

export function noteEntry(rel: string, metadata: NoteMetadata): MemoryEntry {
  return { meta: `<!-- ${metadata.created} [${metadata.id}] -->`, line: `#note [[${rel}]] ${metadata.description}` };
}

/** Discover only note metadata. Bodies are read only by explicit reads, updates and search. */
export async function readNotes(store: StorePaths): Promise<NoteRecord[]> {
  if (!existsSync(store.notesDir)) return [];
  const notes: NoteRecord[] = [];
  const stores = { local: store, global: store };
  async function walk(directory: string): Promise<void> {
    for (const child of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, child.name);
      // Do not traverse symlink directories. resolveNotePath also excludes escaped files.
      if (child.isDirectory()) await walk(path);
      else if (child.isFile() && child.name.endsWith(".md")) {
        const rel = relative(store.dir, path).split(sep).join("/");
        const resolved = resolveNotePath(stores, rel, [store.scope]);
        if (resolved.status === "error" || !resolved.absPath.startsWith(realpathSync(store.notesDir) + sep)) continue;
        const metadata = await readNoteHeader(resolved.absPath);
        if (metadata) notes.push({ entry: noteEntry(rel, metadata), rel, path: resolved.absPath, metadata });
      }
    }
  }
  // An externally linked notes directory is not part of this store.
  if (lstatSync(store.notesDir).isSymbolicLink() || !realpathSync(store.notesDir).startsWith(realpathSync(store.dir) + sep)) return [];
  await walk(store.notesDir);
  return notes;
}

/** A derived catalogue, never persisted back into MEMORY.md. */
export async function readCatalogue(store: StorePaths): Promise<string> {
  const facts = await readMemoryText(store);
  const refs = new Set(parseEntries(facts).map(noteReference).filter((rel) => rel !== null));
  const notes = (await readNotes(store)).filter((note) => !refs.has(note.rel));
  const catalogue = serializeEntries(notes.map((note) => ({ ...note.entry,
    meta: `<!-- ${note.metadata.created} [${note.metadata.id}] modified ${note.metadata.modified} -->` })));
  return facts + (facts && catalogue && !facts.endsWith("\n") ? "\n" : "") + catalogue;
}

export interface AppendResult {
  duplicate: boolean;
  line: string;
  existing?: MemoryEntry[];
  id?: MemoId;
}

/** Append a fact line with a metadata comment. Refuses duplicates. */
export async function appendEntry(store: StorePaths, content: string): Promise<AppendResult> {
  await mkdir(store.dir, { recursive: true });
  const existing = parseEntries(await readCatalogue(store));
  const dups = findDuplicates(existing, content);
  if (dups.length > 0) {
    return { duplicate: true, line: "", existing: dups };
  }
  const line = content.replace(/\s+/g, " ").trim();
  if (line.length === 0) return { duplicate: false, line: "" };
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const id = parseMemoId(randomUUID().slice(0, 8))!;
  const meta = `<!-- ${stamp} [${id}] -->`;
  const chunk = `\n${meta}\n${line}\n`;
  await writeFile(store.memoryFile, chunk, { encoding: "utf8", flag: "a" });
  return { duplicate: false, line, id };
}

export interface ForgetResult {
  removed: MemoryEntry[];
  recoveryId: string | null;
}

/** Remove entries whose line or meta contains the query (case-insensitive). */
export async function forgetEntries(
  store: StorePaths, query: string,
  queue: MutationQueue = async (_path, operation) => operation(),
): Promise<ForgetResult> {
  const text = await readMemoryText(store);
  const entries = parseEntries(text);
  const q = query.toLowerCase();
  if (!q.trim()) return { removed: [], recoveryId: null };
  const removed: MemoryEntry[] = [];
  const kept: MemoryEntry[] = [];
  const notes = (await readNotes(store)).filter((note) =>
    note.entry.line.toLowerCase().includes(q) || note.entry.meta!.toLowerCase().includes(q));
  for (const e of entries) {
    if (e.line.toLowerCase().includes(q) || (e.meta ?? "").toLowerCase().includes(q)) {
      removed.push(e);
    } else {
      kept.push(e);
    }
  }
  const indexed = new Set(removed.map(noteReference));
  removed.push(...notes.filter((note) => !indexed.has(note.rel)).map((note) => note.entry));
  if (removed.length === 0) return { removed, recoveryId: null };
  // Share ordinary edit/write queues: capture the latest body and delete it while
  // holding every selected note lock, always in deterministic path order.
  const locked = [...notes].sort((a, b) => a.path.localeCompare(b.path));
  async function forgetLocked(index: number): Promise<ForgetResult> {
    if (index < locked.length) return queue(locked[index].path, () => forgetLocked(index + 1));
    const snapshots = await Promise.all(notes.map(async (note) => {
      if (lstatSync(note.path).isSymbolicLink()) throw new MemoryConflictError("Selected note became a symlink; retry after inspecting it.");
      const text = await readFile(note.path, "utf8");
      const parsed = parseNote(text);
      if (!parsed || parsed.metadata.id !== note.metadata.id) throw new MemoryConflictError("Selected note identity changed; read it again before forgetting it.");
      return { rel: note.rel, text, mode: (await stat(note.path)).mode & 0o777 };
    }));
    const noteRels = new Set(notes.map((note) => note.rel));
    const deletedEntries = [...removed.filter((entry) => !noteRels.has(noteReference(entry) ?? "")),
      ...snapshots.map((note) => noteEntry(note.rel, parseNote(note.text)!.metadata))];
    await ensureOwnedDirectory(store, store.recoveryDir, 0o700);
    const id = randomUUID().slice(0, 8);
    const record = { id, scope: store.scope, timestamp: new Date().toISOString(), kind: "forget",
      entries: deletedEntries, notes: snapshots };
    await createFileExclusive(join(store.recoveryDir, `${id}.json`), JSON.stringify(record, null, 2));
    if (entries.some((entry) => removed.includes(entry))) await replaceFile(store.memoryFile, serializeEntries(kept));
    for (const note of notes) await rm(note.path);
    return { removed: deletedEntries, recoveryId: id };
  }
  return forgetLocked(0);
}

export type RestoreResult =
  | { status: "restored"; scope: Scope; entries: MemoryEntry[] }
  | { status: "error"; message: string };

type MutationQueue = <T>(path: string, operation: () => Promise<T>) => Promise<T>;

class InvalidRecoveryRecordError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidRecoveryRecordError"; }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  return isObject(value) && typeof value.line === "string" && !/[\r\n]/.test(value.line) &&
    (value.meta === undefined || (typeof value.meta === "string" && !/[\r\n]/.test(value.meta)));
}

/** Restore old deletion records or undo targeted updates, without overwriting later changes. */
export async function restoreEntry(
  stores: Record<Scope, StorePaths>,
  recoveryId: string,
  queue: MutationQueue = async (_path, operation) => operation(),
  scopes: readonly Scope[] = ["global", "local"],
  validateStore?: (store: StorePaths) => string | null,
  prepareStore?: (store: StorePaths) => Promise<void>,
): Promise<RestoreResult | null> {
  const parsedId = parseMemoId(recoveryId);
  if (!parsedId) return null;
  const matches = scopes.filter((scope) => {
    const file = join(stores[scope].recoveryDir, `${parsedId}.json`);
    assertNoRedirect(stores[scope], file);
    return existsSync(file);
  });
  if (matches.length === 0) return null;
  if (matches.length > 1) return { status: "error", message: "Ambiguous recovery ID across scopes; no changes made." };
  const scope = matches[0];
  const store = stores[scope];
  return queue(store.memoryFile, async () => {
    const error = validateStore?.(store);
    if (error) return { status: "error", message: error };
    const file = join(store.recoveryDir, `${parsedId}.json`);
    assertNoRedirect(store, file);
    // A queued sibling restore may already have consumed this record.
    if (!existsSync(file)) return null;
    const readRecord = async (): Promise<Record<string, unknown>> => {
      assertNoRedirect(store, file);
      let record: unknown;
      try { record = JSON.parse(await readFile(file, "utf8")); }
      catch (cause) { throw new InvalidRecoveryRecordError(`Cannot read recovery record: ${String(cause)}`); }
      if (!isObject(record) || record.id !== parsedId || record.scope !== scope) {
        throw new InvalidRecoveryRecordError("Recovery record ID/scope mismatch or invalid record.");
      }
      return record;
    };
    let record = await readRecord();
    // Preflight every recovered reference before preparation can mutate the store,
    // including legacy deletion records that contain references but no snapshots.
    try {
      if (typeof record.noteRel === "string") recoveryNoteTarget(store, record.noteRel);
      if (Array.isArray(record.entries)) {
        for (const entry of record.entries) {
          const rel = isMemoryEntry(entry) ? noteReference(entry) : null;
          if (rel !== null) recoveryNoteTarget(store, rel);
        }
      }
      if (Array.isArray(record.notes)) {
        for (const note of record.notes) {
          if (isObject(note) && typeof note.rel === "string") recoveryNoteTarget(store, note.rel);
        }
      }
    } catch (cause) { return { status: "error", message: String(cause) }; }
    try { await prepareStore?.(store); }
    catch (cause) { return { status: "error", message: String(cause) }; }
    // Migration may have rewritten the recovery record along with its note paths.
    if (prepareStore) record = await readRecord();
    if (record.kind === "update") {
      if (typeof record.memoId !== "string" || !parseMemoId(record.memoId) ||
          typeof record.before !== "string" || typeof record.after !== "string" ||
          (record.meta !== undefined && typeof record.meta !== "string") ||
          (record.noteRel !== undefined && typeof record.noteRel !== "string")) {
        throw new InvalidRecoveryRecordError("Invalid update recovery record.");
      }
      try { if (typeof record.noteRel === "string") recoveryNoteTarget(store, record.noteRel); }
      catch (cause) { return { status: "error", message: String(cause) }; }
      const memo = await readMemo(stores, record.memoId, [scope]);
      if (memo.status === "error") return memo;
      if (memo.entry.meta !== record.meta || memo.noteRel !== record.noteRel) {
        return { status: "error", message: "Memo identity/reference changed since the update; recovery retained." };
      }
      if (!memo.notePath && (/[\r\n]/.test(record.before) || /[\r\n]/.test(record.after))) {
        throw new InvalidRecoveryRecordError("Invalid fact recovery content.");
      }
      const before = record.before;
      const after = record.after;
      const restore = async (): Promise<RestoreResult> => {
        assertNoRedirect(store, file);
        if (memo.noteRel !== undefined) recoveryNoteTarget(store, memo.noteRel);
        if (memo.notePath) assertNoRedirect(store, memo.notePath);
        const current = memo.notePath ? await readFile(memo.notePath, "utf8") : memo.text.slice(memo.start, memo.end);
        if (current !== after) return { status: "error", message: "Memo changed since the update; refusing to overwrite later edits. Recovery retained." };
        await replaceFile(memo.notePath ?? store.memoryFile, memo.notePath ? before :
          memo.text.slice(0, memo.start) + before + memo.text.slice(memo.end));
        await rm(file);
        return { status: "restored", scope, entries: [memo.notePath ? memo.entry : { ...memo.entry, line: before.replace(/\s+$/, "") }] };
      };
      return memo.notePath ? queue(memo.notePath, restore) : restore();
    }
    if ((record.kind !== undefined && record.kind !== "forget") ||
        !Array.isArray(record.entries) || !record.entries.every(isMemoryEntry)) {
      throw new InvalidRecoveryRecordError("Invalid deletion recovery record.");
    }
    const text = await readMemoryText(store);
    const current = parseEntries(await readCatalogue(store));
    const entries = record.entries;
    const notes: { rel: string; text: string; path: string; mode: number }[] = [];
    if (record.notes !== undefined) {
      if (!Array.isArray(record.notes)) throw new InvalidRecoveryRecordError("Invalid deletion note snapshots.");
      const paths = new Set<string>();
      for (const value of record.notes) {
        if (!isObject(value) || typeof value.rel !== "string" || typeof value.text !== "string" ||
            (value.mode !== undefined && (typeof value.mode !== "number" || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777))) {
          throw new InvalidRecoveryRecordError("Invalid deletion note snapshot.");
        }
        const path = recoveryNoteTarget(store, value.rel);
        const parsed = parseNote(value.text);
        if (!parsed || paths.has(path) || !entries.some((entry) =>
          noteReference(entry) === value.rel && entryId(entry) === parsed.metadata.id)) {
          throw new InvalidRecoveryRecordError("Missing, duplicate or mismatched recovered note metadata.");
        }
        paths.add(path);
        if (existsSync(path)) return { status: "error", message: "A recovered note path already exists; recovery retained." };
        notes.push({ rel: value.rel, text: value.text, path, mode: typeof value.mode === "number" ? value.mode : 0o600 });
      }
      if (entries.some((entry) => noteReference(entry) && !notes.some((note) => note.rel === noteReference(entry)))) {
        throw new InvalidRecoveryRecordError("Missing recovered note snapshot.");
      }
    }
    const ids = entries.map(entryId).filter((id) => id !== null);
    if (new Set(ids).size !== ids.length) {
      return { status: "error", message: "Recovery record contains duplicate memo IDs; recovery retained." };
    }
    if (entries.some((entry) => current.some((existing) =>
      (entryId(entry) !== null && entryId(entry) === entryId(existing)) || entry.line === existing.line))) {
      return { status: "error", message: "A recovered entry already exists; refusing to duplicate or overwrite it. Recovery retained." };
    }
    const facts = record.notes === undefined ? entries : entries.filter((entry) => !noteReference(entry));
    const body = `${text}${text && !text.endsWith("\n") ? "\n" : ""}${serializeEntries(facts)}`;
    const created: string[] = [];
    assertNoRedirect(store, file);
    for (const entry of entries) {
      const rel = noteReference(entry);
      if (rel !== null) recoveryNoteTarget(store, rel);
    }
    try {
      for (const note of notes) {
        recoveryNoteTarget(store, note.rel);
        await mkdir(resolve(note.path, ".."), { recursive: true });
        // Check again after directory creation, before exclusive file creation.
        recoveryNoteTarget(store, note.rel);
        await createFileExclusive(note.path, note.text, note.mode);
        created.push(note.path);
      }
      if (facts.length) {
        if (existsSync(store.memoryFile)) await replaceFile(store.memoryFile, body);
        else await writeFile(store.memoryFile, body, { flag: "wx" });
      }
    } catch (error) {
      for (const path of created) await rm(path, { force: true });
      throw error;
    }
    await rm(file);
    return { status: "restored", scope, entries };
  });
}

/** Check every existing ancestor, including dangling symlinks, before recovery creates anything. */
function recoveryNoteTarget(store: StorePaths, rel: string): string {
  if (!/^notes\/.+\.md$/.test(rel) || rel.includes("\\") || /[\x00-\x1f\x7f]/.test(rel) ||
      rel.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new InvalidRecoveryRecordError("Unsafe recovered note path.");
  }
  const path = join(store.dir, rel);
  assertNoRedirect(store, path);
  return path;
}

export interface MemoryStat {
  scope: Scope;
  path: string;
  exists: boolean;
  bytes: number;
  entries: number;
  recoveryCount: number;
  notesCount: number;
}

export async function statMemory(store: StorePaths): Promise<MemoryStat> {
  const text = await readMemoryText(store);
  let recoveryCount = 0;
  if (existsSync(store.recoveryDir)) {
    recoveryCount = (await readdir(store.recoveryDir)).filter((f) => f.endsWith(".json"))
      .length;
  }
  const notesCount = (await readNotes(store)).length;
  return {
    scope: store.scope,
    path: store.memoryFile,
    exists: existsSync(store.memoryFile) || notesCount > 0,
    bytes: Buffer.byteLength(text, "utf8"),
    entries: parseEntries(text).length,
    recoveryCount,
    notesCount,
  };
}

// ---------------------------------------------------------------------------
// Notes (frontmatter is authoritative; references are derived on demand)
// ---------------------------------------------------------------------------

export function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .slice(0, 48)
      .replace(/^-+|-+$/g, "") || "note"
  );
}

export interface NoteResult {
  indexLine: string;
  notePath?: string;
  noteRel?: string;
  duplicate: boolean;
  existing?: MemoryEntry[];
  id?: MemoId;
}

/** Model-chosen basename only; the UTC creation date is always prepended. */
export function validNoteSlug(slug: string): boolean {
  return slug.length <= 80 && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(slug);
}

/** Write a standalone frontmatter note; never append its metadata to MEMORY.md. */
export async function writeNote(
  store: StorePaths,
  title: string,
  content: string,
  slug?: string,
): Promise<NoteResult> {
  if (slug !== undefined && !validNoteSlug(slug)) throw new InvalidNoteSlugError();
  const existingEntries = parseEntries(await readCatalogue(store));
  const duplicates = findDuplicates(existingEntries, `#note [[notes/new.md]] ${title.trim()}`);
  if (duplicates.length > 0) {
    const existing = duplicates[0];
    const noteRel = noteReference(existing) ?? undefined;
    return { duplicate: true, existing: duplicates, indexLine: existing.line, noteRel, id: entryId(existing) ?? undefined };
  }
  await ensureOwnedDirectory(store, store.notesDir, 0o700);
  const stamp = new Date().toISOString();
  const base = `${stamp.slice(0, 10)}-${slug ?? slugifyTitle(title)}`;
  const ids = new Set(existingEntries.map(entryId));
  let id: MemoId;
  do { id = parseMemoId(randomUUID().slice(0, 8))!; } while (ids.has(id));
  const metadata: NoteMetadata = { description: title.trim(), id, created: stamp, modified: stamp };
  const body = serializeNote(metadata, `${content.trim()}\n`);
  for (let suffix = 1; ; suffix++) {
    const rel = `notes/${base}${suffix === 1 ? "" : `-${suffix}`}.md`;
    const abs = join(store.dir, rel);
    try { await createFileExclusive(abs, body); }
    catch (error) {
      if (isObject(error) && error.code === "EEXIST") continue;
      throw error;
    }
    return { indexLine: noteEntry(rel, metadata).line, notePath: abs, noteRel: rel, duplicate: false, id };
  }
}

class MemoryConflictError extends Error {
  constructor(message: string) { super(message); this.name = "MemoryConflictError"; }
}

class InvalidNoteSlugError extends Error {
  constructor() { super("Invalid note slug: use 1–80 letters/digits separated by hyphens, without a date, extension or path."); this.name = "InvalidNoteSlugError"; }
}

export type NoteResolution =
  | { status: "found"; store: StorePaths; absPath: string; rel: string }
  | { status: "error"; message: string };

/** Resolve existing scoped paths; reject traversal and symlinks outside a store. */
export function resolveNotePath(
  stores: Record<Scope, StorePaths>,
  input: string,
  scopes: Scope[] = ["global", "local"],
): NoteResolution {
  const matches: Extract<NoteResolution, { status: "found" }>[] = [];
  for (const scope of scopes) {
    const store = stores[scope];
    const dir = resolve(store.dir);
    const abs = isAbsolute(input) ? resolve(input) : resolve(dir, input);
    if (!abs.startsWith(dir + sep) || !existsSync(abs)) continue;
    const actual = realpathSync(abs);
    if (!actual.startsWith(realpathSync(dir) + sep) || !statSync(actual).isFile()) continue;
    matches.push({ status: "found", store, absPath: actual, rel: relative(dir, abs) });
  }
  if (matches.length === 1) return matches[0];
  return { status: "error", message: matches.length > 1
    ? `Ambiguous note path: ${input}. Specify scope 'local' or 'global'.`
    : `Note not found or outside the selected memory scope(s): ${input}.` };
}

export type MemoLookup =
  | { status: "found"; store: StorePaths; entry: MemoryEntry; text: string; start: number; end: number;
      noteRel?: string; notePath?: string; noteText?: string }
  | { status: "error"; message: string };

/** Exact metadata ID lookup. Existing notes retain their index entry's ID. */
export async function readMemo(
  stores: Record<Scope, StorePaths>,
  input: string,
  scopes: Scope[] = ["global", "local"],
): Promise<MemoLookup> {
  const id = parseMemoId(input);
  if (!id) return { status: "error", message: "Invalid memo ID: expected exactly eight hexadecimal characters." };
  const matches: Extract<MemoLookup, { status: "found" }>[] = [];
  for (const scope of scopes) {
    const store = stores[scope];
    const text = await readMemoryText(store);
    const spans = entrySpans(text);
    for (const span of spans) {
      if (entryId(span.entry) === id) matches.push({ status: "found", store, text, ...span });
    }
    const refs = new Set(spans.map((span) => noteReference(span.entry)));
    for (const note of await readNotes(store)) {
      if (note.metadata.id === id && !refs.has(note.rel)) matches.push({ status: "found", store, entry: note.entry,
        text, start: 0, end: 0, noteRel: note.rel, notePath: note.path, noteText: await readFile(note.path, "utf8") });
    }
  }
  if (matches.length !== 1) return { status: "error", message: matches.length === 0
    ? `Memo not found: ${id}.`
    : `Ambiguous memo ID: ${id}. Specify scope; duplicate IDs within a scope must be resolved manually.` };
  const memo = matches[0];
  if (memo.notePath) return memo;
  const noteRel = noteReference(memo.entry);
  if (noteRel === null) return memo;
  if (!/^notes\/.+\.md$/.test(noteRel)) return { status: "error", message: `Unsafe note reference for memo ${id}.` };
  const resolved = resolveNotePath(stores, noteRel, [memo.store.scope]);
  if (resolved.status === "error") return resolved;
  if (!resolved.absPath.startsWith(realpathSync(memo.store.notesDir) + sep) ||
      (existsSync(memo.store.memoryFile) && resolved.absPath === realpathSync(memo.store.memoryFile))) {
    return { status: "error", message: `Note reference for memo ${id} points outside the notes directory.` };
  }
  return { ...memo, noteRel, notePath: resolved.absPath, noteText: await readFile(resolved.absPath, "utf8") };
}

export type UpdateResult =
  | { status: "updated"; entry: MemoryEntry; recoveryId: string }
  | { status: "unchanged"; entry: MemoryEntry }
  | { status: "error"; message: string };

/** Called under the scope's memory-file mutation queue by the extension. */
export async function updateMemo(
  store: StorePaths, id: string, content: string,
  queue: MutationQueue = async (_path, operation) => operation(),
): Promise<UpdateResult> {
  if (!content.trim()) return { status: "error", message: "Empty content — nothing updated." };
  const memo = await readMemo({ local: store, global: store }, id, [store.scope]);
  if (memo.status === "error") return memo;
  let before: string;
  let after: string;
  if (memo.noteText !== undefined) {
    before = memo.noteText;
    const parsed = parseNote(before);
    if (parsed) {
      if (parsed.body.trim() === content.trim()) return { status: "unchanged", entry: memo.entry };
      after = serializeNote({ ...parsed.metadata, modified: new Date().toISOString() }, `${content.trim()}\n`);
    } else {
      // Legacy low-level callers remain supported; extension entrypoints migrate first.
      const prefix = before.match(/^(?:<!-- pi-remember note: [^\r\n]* -->\r?\n)?# [^\r\n]*\r?\n(?:\r?\n)?/)?.[0] ?? "";
      if (before.slice(prefix.length).trim() === content.trim()) return { status: "unchanged", entry: memo.entry };
      after = `${prefix}${content.trim()}\n`;
    }
  } else {
    after = content.replace(/\s+/g, " ").trim();
    if (after.length > 300) return { status: "error", message: "Fact exceeds 300 characters. Use a detailed note instead." };
    if (noteReference({ line: after })) return { status: "error", message: "Cannot turn a fact into a note reference using memory_update." };
    if (after.startsWith("<!--") && after.endsWith("-->")) {
      return { status: "error", message: "A fact cannot be replaced with a metadata comment." };
    }
    before = memo.text.slice(memo.start, memo.end);
    if (memo.entry.line === after) return { status: "unchanged", entry: memo.entry };
  }
  const apply = async (): Promise<UpdateResult> => {
    // Ordinary file edits use this queue too. Do not overwrite a newer note body.
    if (memo.notePath && await readFile(memo.notePath, "utf8") !== before) {
      return { status: "error", message: "Note changed while preparing the update; read it again before retrying." };
    }
    const recoveryId = randomUUID().slice(0, 8);
    await ensureOwnedDirectory(store, store.recoveryDir, 0o700);
    const record = { kind: "update", id: recoveryId, scope: store.scope, timestamp: new Date().toISOString(),
      memoId: parseMemoId(id), before, after, meta: memo.entry.meta, noteRel: memo.noteRel };
    await createFileExclusive(join(store.recoveryDir, `${recoveryId}.json`), JSON.stringify(record, null, 2));
    await replaceFile(memo.notePath ?? store.memoryFile, memo.notePath ? after :
      memo.text.slice(0, memo.start) + after + memo.text.slice(memo.end));
    return { status: "updated", entry: memo.notePath ? memo.entry : { ...memo.entry, line: after }, recoveryId };
  };
  return memo.notePath ? queue(memo.notePath, apply) : apply();
}
