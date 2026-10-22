import { open } from "node:fs/promises";
import type { MemoId } from "./store.ts";

export interface NoteMetadata {
  description: string;
  id: MemoId;
  created: string;
  modified: string;
}

/** Maximum UTF-8 header size, including the opening/closing delimiters. */
const HEADER_BYTES = 16 * 1024;

export class InvalidNoteError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidNoteError"; }
}

/** ISO timestamps only, with real calendar dates (Date.parse alone accepts February 30). */
export function isNoteTimestamp(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const [, year, month, day, hour, minute, second, zone] = m;
  const y = Number(year), mo = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1] &&
    Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 &&
    (zone === "Z" || (Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4)) < 60)) &&
    Number.isFinite(Date.parse(value));
}

function invalid(message: string): never { throw new InvalidNoteError(`Invalid note frontmatter: ${message}`); }

function validate(metadata: NoteMetadata): NoteMetadata {
  if (typeof metadata.description !== "string" || !metadata.description.trim() || /[\x00-\x1f\x7f]/.test(metadata.description))
    invalid("description must be a nonempty single-line string");
  if (typeof metadata.id !== "string" || !/^[a-f0-9]{8}$/i.test(metadata.id)) invalid("memory-id must be eight hexadecimal characters");
  if (typeof metadata.created !== "string" || !isNoteTimestamp(metadata.created)) invalid("invalid created-date ISO timestamp");
  if (typeof metadata.modified !== "string" || !isNoteTimestamp(metadata.modified)) invalid("invalid last-modified-date ISO timestamp");
  return { ...metadata, id: metadata.id.toLowerCase() as MemoId };
}

/** A deliberately small YAML subset: one scalar per line, no tags, aliases or multiline values. */
function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const match = /^"(?:[^"\\\r\n]|\\.)*"/.exec(value);
    if (!match || !/^(?:\s+#.*)?\s*$/.test(value.slice(match[0].length))) invalid("malformed double-quoted scalar");
    try { return JSON.parse(match[0]) as string; } catch { invalid("unsupported double-quoted escape (use JSON escapes)"); }
  }
  if (value.startsWith("'")) {
    const match = /^'(?:[^']|'')*'/.exec(value);
    if (!match || !/^(?:\s+#.*)?\s*$/.test(value.slice(match[0].length))) invalid("malformed single-quoted scalar");
    return match[0].slice(1, -1).replace(/''/g, "'");
  }
  const plain = value.replace(/\s+#.*$/, "").trimEnd();
  if (!plain || /^[!&*|>{}\[\],@`#%]/.test(plain) || /^[-?:](?:\s|$)/.test(plain) ||
      /:\s/.test(plain) || /^(?:null|~|true|false)$/i.test(plain))
    invalid("unsupported plain scalar; quote the value");
  return plain;
}

/** null means genuinely legacy text; a started but invalid header always throws. Body bytes are untouched. */
export function parseNote(text: string): { metadata: NoteMetadata; body: string } | null {
  const start = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!start) return null;
  const remainder = text.slice(start[0].length);
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(remainder);
  if (!close) invalid("missing closing delimiter (or header exceeds 16 KiB)");
  const end = start[0].length + close.index + close[0].length;
  if (Buffer.byteLength(text.slice(0, end), "utf8") > HEADER_BYTES) invalid("header exceeds 16 KiB");
  const fields = new Map<string, string>();
  const names = new Set(["description", "memory-id", "created-date", "last-modified-date"]);
  for (const line of remainder.slice(0, close.index).split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^([a-z-]+):[ \t]*(.*)$/.exec(line);
    if (!match || !names.has(match[1])) invalid(`unsupported field: ${line}`);
    if (fields.has(match[1])) invalid(`duplicate field: ${match[1]}`);
    fields.set(match[1], scalar(match[2]));
  }
  if (fields.size !== 4) invalid("expected description, memory-id, created-date and last-modified-date");
  const metadata = validate({ description: fields.get("description")!, id: fields.get("memory-id")! as MemoId,
    created: fields.get("created-date")!, modified: fields.get("last-modified-date")! });
  return { metadata, body: text.slice(end) };
}

export function serializeNote(metadata: NoteMetadata, body: string): string {
  const m = validate(metadata);
  const header = `---\ndescription: ${JSON.stringify(m.description)}\nmemory-id: ${JSON.stringify(m.id)}\ncreated-date: ${JSON.stringify(m.created)}\nlast-modified-date: ${JSON.stringify(m.modified)}\n---\n`;
  if (Buffer.byteLength(header, "utf8") > HEADER_BYTES) invalid("header exceeds 16 KiB");
  return header + body;
}

/** Stop at the header in small chunks; cap reads at 16 KiB plus one lookahead byte. */
export async function readNoteHeader(path: string): Promise<NoteMetadata | null> {
  const file = await open(path, "r");
  try {
    // Lookahead prevents a truncated "---not-a-delimiter" at the bound from
    // masquerading as a valid closing delimiter at end of file.
    const buffer = Buffer.alloc(HEADER_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, Math.min(512, buffer.length - used), used);
      if (!bytesRead) break;
      used += bytesRead;
      const prefix = buffer.subarray(0, used).toString("utf8");
      const start = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.exec(prefix);
      if (!start) {
        if (used < 512 && !prefix.includes("\n")) continue; // A short read may split the opening delimiter/BOM.
        return null;
      }
      // Require a newline while still streaming: a chunk ending in "---"
      // could be followed by non-delimiter text in the next chunk.
      if (/^---[ \t]*\r?\n/m.test(prefix.slice(start[0].length))) {
        return parseNote(prefix)!.metadata;
      }
    }
    return parseNote(buffer.subarray(0, used).toString("utf8"))?.metadata ?? null;
  } finally { await file.close(); }
}

/** Strip only pi-remember's generated marker, its immediate H1 and one generated blank line. */
export function legacyNote(text: string): { description?: string; created?: string; body: string } {
  if (!/^(?:\uFEFF)?<!-- pi-remember note:/.test(text)) return { body: text };
  const marker = /^(?:\uFEFF)?<!-- pi-remember note: ([^\r\n]+) -->(?:\r?\n|$)/.exec(text);
  if (!marker || !isNoteTimestamp(marker[1])) throw new InvalidNoteError("Malformed generated pi-remember note marker");
  let body = text.slice(marker[0].length);
  const heading = /^# ([^\r\n]*)(?:\r?\n|$)/.exec(body);
  if (heading) body = body.slice(heading[0].length).replace(/^\r?\n/, "");
  return { ...(heading ? { description: heading[1] } : {}), created: marker[1], body };
}
