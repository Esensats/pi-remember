import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { sep } from "node:path";
import {
  entryId, noteReference, parseEntries, readMemoryText, readNotes, resolveNotePath,
  type MemoId, type Scope, type StorePaths,
} from "./store.ts";

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "is", "are", "and", "or", "for", "on",
  "with", "as", "at", "by", "it", "its", "this", "that", "these", "those",
  "be", "was", "were", "been", "do", "does", "did", "i", "we", "you", "he",
  "she", "they", "my", "your", "our", "their", "should", "would", "could",
  "can", "will", "not", "no", "yes", "if", "then", "than", "so", "but",
  "from", "into", "about", "what", "when", "where", "which", "who", "how",
]);

export interface SearchHit {
  scope: Scope;
  file: string;
  line: string;
  meta?: string;
  id?: MemoId;
  score: number;
  /** Matching body lines in the note; at least 1 for description-only hits. */
  matchLines: number;
}

const normalize = (text: string): string => text.normalize("NFKC").toLowerCase();
const words = (text: string): string[] => normalize(text).match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];

export function tokenize(query: string): string[] {
  return words(query).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

interface Query {
  tokens: string[];
  phrases: string[][];
}

function parseQuery(query: string): Query {
  const tokens = [...new Set(tokenize(query))];
  // Quotes request a phrase boost, not a hard filter. Preserve stopwords and
  // token boundaries in phrases ("proxy in docker" != "proxy docker").
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map((m) => words(m[1]));
  const phrases = (quoted.length ? quoted : [words(query)])
    .filter((p) => new Set(p.filter((word) => tokens.includes(word))).size > 1);
  return { tokens, phrases };
}

function hasPhrase(tokens: string[], phrase: string[]): boolean {
  return tokens.some((_, i) => phrase.every((word, j) => tokens[i + j] === word));
}

/** Never index managed YAML, including an incomplete frontmatter block. */
function stripFrontmatter(text: string): string {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
    // Fail closed on incomplete frontmatter instead of exposing IDs/dates.
    text = end < 0 ? "" : lines.slice(end + 1).join("\n");
  } else text = clean;
  return text;
}

function bodyText(text: string): string {
  return stripFrontmatter(text).replace(/<!--[\s\S]*?-->/g, " ");
}

function markupTokens(text: string): string[] {
  return [...text.matchAll(/#[\p{L}\p{N}][\p{L}\p{N}\p{M}_-]*|\[\[([^\]]+)\]\]/gu)]
    .flatMap((m) => tokenize(m[1] ?? m[0]));
}

function frequencies(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

interface SearchDocument {
  scope: Scope;
  file: string;
  description: string;
  body: string;
  meta?: string;
  id?: MemoId;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A small, query-local BM25F corpus: no dependencies or persistent index. */
function rank(documents: SearchDocument[], query: Query): SearchHit[] {
  if (!query.tokens.length || !documents.length) return [];
  const prepared = documents.map((document) => {
    const description = tokenize(document.description);
    const body = tokenize(document.body);
    const markup = markupTokens(`${document.description}\n${document.body}\n${document.meta ?? ""}`);
    return {
      document, description, body,
      descFreq: frequencies(description), bodyFreq: frequencies(body), tagFreq: frequencies(markup),
      phraseFields: [words(document.description), words(document.body)],
    };
  });
  const avgBody = prepared.reduce((sum, p) => sum + p.body.length, 0) / prepared.length || 1;
  const avgDesc = prepared.reduce((sum, p) => sum + p.description.length, 0) / prepared.length || 1;
  const idf = new Map(query.tokens.map((token) => {
    const df = prepared.filter((p) => p.descFreq.has(token) || p.bodyFreq.has(token) || p.tagFreq.has(token)).length;
    return [token, Math.log(1 + (prepared.length - df + 0.5) / (df + 0.5))];
  }));
  const hits: SearchHit[] = [];
  for (const p of prepared) {
    let lexical = 0;
    let matched = 0;
    for (const token of query.tokens) {
      // Separate field normalization prevents a long body diluting a good title.
      const tf = (p.bodyFreq.get(token) ?? 0) / (0.25 + 0.75 * p.body.length / avgBody)
        + 5 * (p.descFreq.get(token) ?? 0) / (0.7 + 0.3 * p.description.length / avgDesc)
        + 2 * (p.tagFreq.get(token) ?? 0);
      if (tf === 0) continue;
      matched++;
      lexical += idf.get(token)! * (2.2 * tf / (1.2 + tf));
    }
    if (!matched) continue;
    const coverage = matched / query.tokens.length;
    const phraseBonus = query.phrases.some((phrase) => p.phraseFields.some((field) => hasPhrase(field, phrase))) ? 1.5 : 0;
    const { document } = p;
    hits.push({
      scope: document.scope, file: document.file, meta: document.meta, id: document.id,
      line: bestPassage(document.body, document.description, query),
      score: lexical * (0.2 + 0.8 * coverage ** 2) + 2 * coverage + phraseBonus * coverage,
      matchLines: Math.max(1, document.body.split(/\r?\n/)
        .filter((line) => tokenize(line).some((token) => query.tokens.includes(token))).length),
    });
  }
  return hits.sort((a, b) => b.score - a.score || b.matchLines - a.matchLines
    || compareText(a.scope, b.scope) || compareText(a.file, b.file) || compareText(a.line, b.line));
}

/** Choose a bounded token window, including matches deep inside a long line. */
function bestPassage(body: string, description: string, query: Query): string {
  const source = body.trim();
  const spans = [...source.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)];
  const matches = spans.flatMap((span, i) => query.tokens.includes(normalize(span[0])) ? [i] : []);
  if (!matches.length) return clip(description || source);
  let best = "";
  let bestScore = -Infinity;
  for (const i of matches) {
    const first = Math.max(0, i - 8);
    const start = spans[first].index!;
    const maxEnd = start + 280;
    let last = first;
    while (last + 1 < spans.length && last - first < 39
      && spans[last + 1].index! + spans[last + 1][0].length <= maxEnd) last++;
    const end = spans[last].index! + spans[last][0].length;
    const passage = source.slice(start, end);
    const tokens = tokenize(passage);
    const coverage = query.tokens.filter((token) => tokens.includes(token)).length;
    const count = tokens.filter((token) => query.tokens.includes(token)).length;
    const phrase = query.phrases.some((p) => hasPhrase(words(passage), p)) ? 3 : 0;
    const score = 10 * coverage + phrase + count / (count + 1) + count / Math.max(1, tokens.length);
    if (score > bestScore) {
      bestScore = score;
      best = `${start ? "… " : ""}${passage.replace(/\s+/g, " ")}${end < source.length ? " …" : ""}`;
    }
  }
  return best;
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= 280 ? clean : `${clean.slice(0, 277).replace(/\s+\S*$/, "")} …`;
}

/** Compatible single-entry helper, now using exact tokens and saturated TF. */
export function scoreLine(line: string, meta: string | undefined, tokens: string[], fullQuery: string): number {
  return rank([{ scope: "local", file: "", description: line, body: "", meta }], {
    tokens: [...new Set(tokens.flatMap(tokenize))], phrases: parseQuery(fullQuery).phrases,
  })[0]?.score ?? 0;
}

export function searchInText(scope: Scope, file: string, text: string, query: string): SearchHit[] {
  const isIndex = /(?:^|[/\\])MEMORY\.md$/.test(file);
  return rank(parseEntries(stripFrontmatter(text)).map((entry) => ({
    scope, file, description: entry.line, body: "", meta: entry.meta,
    id: isIndex ? entryId(entry) ?? undefined : undefined,
  })), parseQuery(query));
}

function referenceDescription(line: string): string {
  return line.replace(/^#note\s+\[\[[^\]]+\]\]\s*/, "");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function searchStores(
  stores: Record<Scope, StorePaths>, query: string, scopes: Scope[], limit = 20,
): Promise<SearchHit[]> {
  const parsed = parseQuery(query);
  if (!parsed.tokens.length || !Number.isFinite(limit) || limit <= 0) return [];
  const documents: SearchDocument[] = [];
  for (const scope of new Set(scopes)) {
    const store = stores[scope];
    const entries = parseEntries(await readMemoryText(store));
    // readNotes supplies metadata only; body I/O belongs to search, not injection.
    const records = await readNotes(store);
    const byRel = new Map(records.map((record) => [record.rel, record]));
    const files = new Set(byRel.keys());
    const notesRoot = existsSync(store.notesDir) ? realpathSync(store.notesDir) + sep : undefined;
    if (notesRoot) {
      for (const file of await readdir(store.notesDir)) if (file.endsWith(".md")) files.add(`notes/${file}`);
    }
    for (const entry of entries) {
      const rel = noteReference(entry);
      if (rel && /^notes\/.+\.md$/.test(rel)) files.add(rel);
    }
    const loaded = new Set<string>();
    for (const file of [...files].sort(compareText)) {
      const resolved = resolveNotePath(stores, file, [scope]);
      if (resolved.status === "error" || !notesRoot || !resolved.absPath.startsWith(notesRoot)) continue;
      let text: string;
      try { text = await readFile(resolved.absPath, "utf8"); }
      catch (error) { if (isMissing(error)) continue; throw error; }
      const record = byRel.get(file);
      const references = entries.filter((entry) => noteReference(entry) === file);
      const body = bodyText(text);
      documents.push({
        scope, file, body,
        description: record?.metadata.description ?? references.map((entry) => referenceDescription(entry.line)).join("\n"),
        id: record?.metadata.id ?? (references.length === 1 ? entryId(references[0]) ?? undefined : undefined),
        meta: record?.entry.meta ?? (references.length === 1 ? references[0].meta : undefined),
      });
      loaded.add(file);
    }
    for (const entry of entries) {
      const rel = noteReference(entry);
      if (rel && loaded.has(rel)) continue; // Merge description and body, never two hits for one note.
      documents.push({
        scope, file: "MEMORY.md", description: rel ? referenceDescription(entry.line) : entry.line,
        body: "", meta: entry.meta, id: entryId(entry) ?? undefined,
      });
    }
  }
  return rank(documents, parsed).slice(0, Math.floor(limit));
}
