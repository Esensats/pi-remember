import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, truncateTail, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  appendEntry,
  entryId,
  findSimilar,
  forgetEntries,
  parseEntries,
  readCatalogue,
  readMemo,
  resolveNotePath,
  restoreEntry,
  resolveStores,
  statMemory,
  updateMemo,
  validNoteSlug,
  writeNote,
  type MemoryEntry,
  type Scope,
  type StorePaths,
} from "./store.ts";
import { searchStores } from "./search.ts";
import { assertCurrentStoreVersion, ensureStoreVersion } from "./migration.ts";
import { buildSnapshot, type Snapshot } from "./inject.ts";
import { buildSummaryPrompt, gatherConversationText, parseFacts } from "./summary.ts";
import { registerMemoryCommand } from "./command.ts";
import { initializeMemory, resolveWorkspaceStores, workspaceAccessError } from "./workspace.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Config {
  globalDir: string;
  injectCharsGlobal: number;
  injectCharsLocal: number;
  exitSummary: boolean;
  exitSummaryModel?: string;
  exitSummaryScope: "auto" | "global" | "local";
  exitSummaryTimeoutMs: number;
}

function truthy(v: string | undefined): boolean {
  return !!v && ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function loadConfig(): Config {
  const scope = process.env.PI_REMEMBER_EXIT_SUMMARY_SCOPE?.toLowerCase();
  return {
    globalDir: process.env.PI_REMEMBER_DIR ?? join(homedir(), ".pi", "agent", "memory"),
    injectCharsGlobal: intEnv("PI_REMEMBER_INJECT_CHARS_GLOBAL", 3000),
    injectCharsLocal: intEnv("PI_REMEMBER_INJECT_CHARS_LOCAL", 3000),
    exitSummary: truthy(process.env.PI_REMEMBER_EXIT_SUMMARY),
    exitSummaryModel: process.env.PI_REMEMBER_EXIT_SUMMARY_MODEL,
    exitSummaryScope: scope === "global" || scope === "local" ? scope : "auto",
    exitSummaryTimeoutMs: intEnv("PI_REMEMBER_EXIT_SUMMARY_TIMEOUT_MS", 10_000),
  };
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let stores: Record<Scope, StorePaths> = resolveStores(
  process.cwd(),
  config.globalDir,
  CONFIG_DIR_NAME,
);
let snapshot: Snapshot = { text: "", globalChars: 0, localChars: 0 };
let sessionCwd = process.cwd();

/** Optional injection/warnings must not break startup or a committed mutation. */
async function readOptionalMemory(store: StorePaths): Promise<string> {
  try {
    await assertCurrentStoreVersion(store);
    return await readCatalogue(store);
  } catch { return ""; }
}

async function rebuildSnapshot(): Promise<Snapshot> {
  const [globalText, localText] = await Promise.all([
    readOptionalMemory(stores.global),
    readOptionalMemory(stores.local),
  ]);
  return buildSnapshot(globalText, localText, basename(sessionCwd), {
    maxGlobalChars: config.injectCharsGlobal,
    maxLocalChars: config.injectCharsLocal,
  });
}

function resolveScopes(param: "global" | "local" | "both" | undefined): Scope[] {
  if (param === "global") return ["global"];
  if (param === "local") return ["local"];
  return ["global", "local"];
}

const rootParameter = Type.Optional(Type.String({
  minLength: 1,
  description: "Workspace directory for local memory (not its .pi directory). Defaults to the session cwd; accepts absolute, relative-to-cwd, and ~/ paths. Ignored for global-only operations.",
}));
const workspaceGuidance = " Optional root selects another workspace's local memory; global memory is unchanged. Local memory requires memory_init first.";

/** Resolve per call without changing the session's stores or injected memory. */
function toolStores(root: string | undefined, scopes: Scope[], requireInit = true) {
  // Global-only calls never depend on a local workspace or its initialization.
  if (!scopes.includes("local")) return { status: "resolved" as const, stores };
  const target = resolveWorkspaceStores(sessionCwd, config.globalDir, CONFIG_DIR_NAME, root);
  if (target.status === "error") return target;
  const error = workspaceAccessError(target.stores, scopes, requireInit);
  return error ? { status: "error" as const, message: error } : target;
}

/** Validate after acquiring the queue, since earlier checks can become stale. */
async function mutateMemory<T>(
  targetStores: Record<Scope, StorePaths>,
  scope: Scope,
  operation: () => Promise<T>,
  requireInit = true,
): Promise<{ status: "ok"; value: T } | { status: "error"; message: string }> {
  return withFileMutationQueue(targetStores[scope].memoryFile, async () => {
    const error = workspaceAccessError(targetStores, [scope], requireInit);
    if (error) return { status: "error", message: error };
    try { await ensureStoreVersion(targetStores[scope]); }
    catch (error) { return { status: "error", message: String(error) }; }
    const value = await operation();
    // A new global store or memory_init did not exist before the operation.
    await ensureStoreVersion(targetStores[scope]);
    await refreshSnapshotFor(targetStores[scope]);
    return { status: "ok", value };
  });
}

/** Reads of other workspaces migrate lazily; missing stores are never created. */
async function prepareReadStores(targetStores: Record<Scope, StorePaths>, scopes: Scope[]): Promise<string | null> {
  for (const scope of scopes) {
    try {
      await withFileMutationQueue(targetStores[scope].memoryFile, async () => {
        const error = workspaceAccessError(targetStores, [scope]);
        if (error) throw new Error(error);
        await ensureStoreVersion(targetStores[scope]);
      });
    } catch (error) { return String(error); }
  }
  return null;
}

async function refreshSnapshotFor(store: StorePaths): Promise<void> {
  if (store.scope === "global" || store.memoryFile === stores.local.memoryFile) {
    snapshot = await rebuildSnapshot();
  }
}

/** Similar entries in the OTHER scope of this call, not another workspace. */
async function similarInOtherScope(targetStores: Record<Scope, StorePaths>, store: StorePaths, content: string): Promise<MemoryEntry[]> {
  const other = store.scope === "local" ? targetStores.global : targetStores.local;
  const entries = parseEntries(await readOptionalMemory(other));
  return findSimilar(entries, content);
}

const READ_CAP = { maxBytes: 20_000, maxLines: 400 };
const NOTE_CAP = { maxBytes: 30_000, maxLines: 600 };

function formatTruncated(t: ReturnType<typeof truncateTail>): string {
  return t.truncated
    ? `${t.content}\n[truncated: showing ${t.outputLines}/${t.totalLines} lines]`
    : t.content;
}

function memoryError(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: {}, isError: true };
}

function restoreHint(recoveryId: string, scope: Scope, root?: string): string {
  const args = { recoveryId, scope, ...(scope === "local" && root !== undefined ? { root } : {}) };
  return `Undo with memory_restore(${JSON.stringify(args)}).`;
}

function formatEntry(entry: MemoryEntry): string {
  const id = entryId(entry);
  return `${id ? `[id=${id}] ` : ""}${entry.line}`;
}

// ---------------------------------------------------------------------------
// Exit summary (opt-in)
// ---------------------------------------------------------------------------

function pickSummaryScope(): StorePaths {
  if (config.exitSummaryScope === "global") return stores.global;
  if (config.exitSummaryScope === "local") return stores.local;
  // auto: prefer project-local when the workdir already has pi config
  return existsSync(join(sessionCwd, CONFIG_DIR_NAME)) ? stores.local : stores.global;
}

async function runExitSummary(ctx: ExtensionContext): Promise<void> {
  const target = pickSummaryScope();
  // Do not spend a model call on a destination we cannot use.
  if (workspaceAccessError(stores, [target.scope])) return;
  const text = gatherConversationText(ctx.sessionManager.getBranch(), 20_000);
  if (text.trim().length < 100) return;

  let model = ctx.model;
  if (config.exitSummaryModel) {
    const idx = config.exitSummaryModel.lastIndexOf("/");
    if (idx > 0) {
      model =
        ctx.modelRegistry.find(config.exitSummaryModel.slice(0, idx), config.exitSummaryModel.slice(idx + 1)) ??
        model;
    } else {
      model = ctx.modelRegistry.find(config.exitSummaryModel) ?? model;
    }
  }
  if (!model) return;
  try {
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) return;
  } catch {
    return;
  }

  const messages = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: buildSummaryPrompt(text) }],
      timestamp: Date.now(),
    },
  ];

  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("pi-remember exit summary timeout")), config.exitSummaryTimeoutMs),
    );
    const response = await Promise.race([
      ctx.modelRegistry.complete(model, { messages }, {}),
      timeout,
    ]);
    const raw = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const facts = parseFacts(raw);
    if (facts.length === 0) return;

    for (const fact of facts) {
      const result = await mutateMemory(stores, target.scope, () => appendEntry(target, fact));
      if (result.status === "error") return;
    }
    snapshot = await rebuildSnapshot();
    if (ctx.hasUI) {
      ctx.ui.notify(`pi-remember: saved ${facts.length} fact(s) to ${target.scope} memory`, "info");
    }
  } catch {
    // silent: summary is best-effort, never block exit
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

async function buildStatusText(targetStores = stores): Promise<string> {
  const lines: string[] = [];
  for (const scope of ["global", "local"] as const) {
    try {
      const s = await statMemory(targetStores[scope]);
      lines.push(
        s.exists
          ? `${scope}: ${s.path}${existsSync(s.path) ? "" : " (facts file absent; standalone notes present)"} (${s.entries} facts, ${s.notesCount} notes, ${s.bytes} fact-file bytes, ${s.recoveryCount} recovery files)`
          : `${scope}: ${s.path} (no memory yet${scope === "local" ? "; run memory_init first" : ""})`,
      );
    } catch (error) {
      lines.push(`${scope}: ${targetStores[scope].memoryFile} (inspection error: ${String(error)})`);
    }
  }
  lines.push(
    `injected snapshot (current session: ${sessionCwd}): ${snapshot.text.length} chars (global ${snapshot.globalChars}, local ${snapshot.localChars})`,
  );
  lines.push(`exit summary: ${config.exitSummary ? "on" : "off"} (set PI_REMEMBER_EXIT_SUMMARY=1 to enable)`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    const target = resolveWorkspaceStores(ctx.cwd, config.globalDir, CONFIG_DIR_NAME);
    stores = target.status === "resolved" ? target.stores : resolveStores(ctx.cwd, config.globalDir, CONFIG_DIR_NAME);
    const failed = new Set<Scope>();
    for (const scope of ["global", "local"] as const) {
      try {
        await withFileMutationQueue(stores[scope].memoryFile, () => ensureStoreVersion(stores[scope]));
      } catch (error) {
        failed.add(scope);
        if (ctx.hasUI) ctx.ui.notify(`pi-remember: ${scope} memory unavailable: ${String(error)}`, "warning");
      }
    }
    snapshot = buildSnapshot(
      failed.has("global") ? "" : await readOptionalMemory(stores.global),
      failed.has("local") ? "" : await readOptionalMemory(stores.local),
      basename(sessionCwd), { maxGlobalChars: config.injectCharsGlobal, maxLocalChars: config.injectCharsLocal });
  });

  pi.on("before_agent_start", async (event) => {
    if (!snapshot.text) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${snapshot.text}` };
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (config.exitSummary && event.reason === "quit") {
      await runExitSummary(ctx);
    }
  });

  pi.registerTool({
    name: "memory_init",
    label: "Memory Init",
    description: "Explicitly initialize local memory in an existing workspace. Optional root defaults to the session cwd. Creates .pi/memory/MEMORY.md only if missing; never overwrites existing memory or creates the workspace itself. Global memory needs no initialization.",
    promptSnippet: "Initialize local memory in an existing workspace",
    promptGuidelines: [
      "Use root to access local memory in another workspace. Initialize it with memory_init only when you intend to create a memory store there; do not initialize merely to make a search succeed.",
    ],
    parameters: Type.Object({ root: rootParameter }),
    async execute(_toolCallId, params) {
      const target = toolStores(params.root, ["local"], false);
      if (target.status === "error") return memoryError(target.message);
      const store = target.stores.local;
      const mutation = await mutateMemory(target.stores, "local", () => initializeMemory(store), false);
      if (mutation.status === "error") return memoryError(mutation.message);
      const result = mutation.value;
      if (result.status === "error") return memoryError(result.message);
      return {
        content: [{ type: "text", text: result.status === "initialized"
          ? `Initialized local memory: ${store.memoryFile}`
          : `Local memory already initialized: ${store.memoryFile}. Existing content preserved.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "memory_write",
    label: "Memory Write",
    description:
      "Append exactly ONE concise, durable fact to memory. Default scope 'local' (current project, .pi/memory/MEMORY.md). " +
      "Use scope 'global' ONLY for machine/user-wide facts (user identity, OS, global tool preferences) — ~/.pi/agent/memory/MEMORY.md. " +
      "Store only knowledge that was expensive to obtain and will plausibly matter in a FUTURE session: stable preferences, decisions, lessons, environment quirks. " +
      "NEVER store temporary session state: current task, todos, in-progress work, debugging state, 'user asked me to X'. " +
      "One line only, max 300 chars. For longer content use memory_store, which writes a standalone frontmatter note." + workspaceGuidance,
    promptSnippet: "Persist one durable fact to memory (project-local or global)",
    promptGuidelines: [
      "Use memory_write sparingly — only for facts a future session will plausibly need. When in doubt, don't write.",
      "global scope is reserved for facts about the user or the machine; facts about specific software, repos, or configs stay local to the workdir where they were learned.",
      "Do not record session state (what you're doing now, todos, next steps) — pi's own session files persist that.",
      "Keep MEMORY.md for one-line facts only. Notes carry their own metadata; their descriptions are automatically included in session context.",
      "Use memory_search to recall stored knowledge before re-deriving it or asking the user.",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "Single fact to remember (one line, max 300 chars)" }),
      scope: Type.Optional(StringEnum(["local", "global"] as const)),
      root: rootParameter,
    }),
    async execute(_toolCallId, params) {
      if (params.content.length > 300) {
        return {
          content: [
            {
              type: "text",
              text: `Entry too long for the index (${params.content.length} chars, max 300). Use memory_store for detailed knowledge — it writes a notes file and keeps MEMORY.md lean.`,
            },
          ],
          details: {},
        };
      }
      const target = toolStores(params.root, [params.scope ?? "local"]);
      if (target.status === "error") return memoryError(target.message);
      const store = target.stores[params.scope ?? "local"];
      const mutation = await mutateMemory(target.stores, store.scope, async () => {
        return appendEntry(store, params.content);
      });
      if (mutation.status === "error") return memoryError(mutation.message);
      const result = mutation.value;
      if (result.duplicate) {
        return {
          content: [
            {
              type: "text",
              text:
                `Duplicate — already in ${store.scope} memory:\n` +
                (result.existing ?? []).map((e) => `- ${formatEntry(e)}`).join("\n"),
            },
          ],
          details: {},
        };
      }
      if (!result.line) {
        return { content: [{ type: "text", text: "Empty content — nothing saved." }], details: {} };
      }
      const similar = await similarInOtherScope(target.stores, store, result.line);
      const warning =
        similar.length > 0
          ? `\nNote: similar entry in ${store.scope === "local" ? "global" : "local"} memory: ${similar[0].line}\nKeep knowledge in ONE scope — memory_forget the copy that does not belong.`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Saved to ${store.scope} memory (${store.memoryFile}). Memo ID: ${result.id}.${warning}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "memory_store",
    label: "Memory Store Note",
    description:
      "Store detailed knowledge as a standalone Markdown note with description, ID and timestamps in frontmatter. " +
      "Only note descriptions/IDs/paths are injected into context; bodies are read on demand via memory_read. " +
      "Choose a short descriptive slug; filenames always prepend the UTC date. The extension adds no Markdown heading. " +
      "Default scope 'local'. Use 'global' ONLY for facts about the user or the machine itself — not specific software, repos, or configs. " +
      "Existing/duplicate entries are returned without creating or overwriting a note; use memory_update to revise an indexed memo." + workspaceGuidance,
    promptSnippet: "Store detailed knowledge as a dated, self-describing note",
    promptGuidelines: [
      "Use memory_store instead of memory_write whenever knowledge needs more than one line. MEMORY.md holds only short facts; notes are discovered from frontmatter.",
      "When recalling, prefer memory_search to find notes, then memory_read(path=...) to fetch the full note.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description:
          "Short note description stored in frontmatter and injected into context (max 300 chars). Does not create a Markdown heading.",
      }),
      slug: Type.Optional(Type.String({ minLength: 1, maxLength: 80,
        description: "Choose a concise filename slug: letters/digits separated by hyphens, no date/path/extension. UTC date is prepended. Falls back to a title-derived slug for older callers." })),
      content: Type.String({ description: "Markdown body only; no frontmatter. Include your own heading if useful." }),
      scope: Type.Optional(StringEnum(["local", "global"] as const)),
      root: rootParameter,
    }),
    async execute(_toolCallId, params) {
      if (!params.title.trim() || /[\x00-\x1f\x7f]/.test(params.title)) return memoryError("Description must be a nonempty single line.");
      if (!params.content.trim()) return memoryError("Empty note body — nothing saved.");
      if (params.slug !== undefined && !validNoteSlug(params.slug)) return memoryError("Invalid slug: use 1–80 letters/digits separated by hyphens, without date, path or extension.");
      if (params.title.length > 300) {
        return {
          content: [{ type: "text", text: `Title too long (${params.title.length} chars, max 300).` }],
          details: {},
        };
      }
      const target = toolStores(params.root, [params.scope ?? "local"]);
      if (target.status === "error") return memoryError(target.message);
      const store = target.stores[params.scope ?? "local"];
      const mutation = await mutateMemory(target.stores, store.scope, async () => {
        return writeNote(store, params.title, params.content, params.slug);
      });
      if (mutation.status === "error") return memoryError(mutation.message);
      const result = mutation.value;
      if (result.duplicate) {
        return {
          content: [{ type: "text", text: `Already indexed in ${store.scope} memory; no note created or overwritten:\n` +
            (result.existing ?? []).map((entry) => `- ${formatEntry(entry)}`).join("\n") +
            "\nRead the existing memo and use memory_update to revise it." }],
          details: {},
        };
      }
      const similar = await similarInOtherScope(target.stores, store, result.indexLine);
      const warning =
        similar.length > 0
          ? `\nNote: similar entry in ${store.scope === "local" ? "global" : "local"} memory: ${similar[0].line}\nKeep knowledge in ONE scope — memory_forget the copy that does not belong.`
          : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Stored note: ${result.noteRel}\nMemory file: ${store.memoryFile}\nMemo ID: ${result.id}\n` +
              `Description: ${result.indexLine}\nMetadata is stored in the note, not duplicated in MEMORY.md.${warning}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "memory_update",
    label: "Memory Update",
    description:
      "Update ONE existing memo by its exact eight-character metadata ID, preserving ID, creation date, note path and description. Note last-modified-date advances on changes. " +
      "Default scope 'local'. Read the memo first. For facts, content replaces the fact (one line, max 300 chars); " +
      "for notes, content replaces the full Markdown body, excluding frontmatter (include your own heading if wanted). Preserve still-correct details. " +
      "Blank content is rejected; identical content is a no-op. Actual changes return a recovery ID for memory_restore. " +
      "Legacy stores migrate automatically with backups; do not manually rewrite unrelated memory." + workspaceGuidance,
    promptSnippet: "Revise one memo in place by ID (recoverable)",
    promptGuidelines: [
      "Use memory_update for indexed memo corrections instead of forgetting/recreating facts or storing replacement notes.",
      "Read the existing memo first and preserve unrelated/correct content; update only with evidence, not merely because it is old.",
    ],
    parameters: Type.Object({
      id: Type.String({ pattern: "^[a-fA-F0-9]{8}$", description: "Exact memo ID from index metadata or a tool result (not a recovery ID)" }),
      content: Type.String({ minLength: 1, description: "Replacement fact or full Markdown note body; omit frontmatter" }),
      scope: Type.Optional(StringEnum(["local", "global"] as const)),
      root: rootParameter,
    }),
    async execute(_toolCallId, params) {
      const target = toolStores(params.root, [params.scope ?? "local"]);
      if (target.status === "error") return memoryError(target.message);
      const store = target.stores[params.scope ?? "local"];
      const mutation = await mutateMemory(target.stores, store.scope, async () => {
        return updateMemo(store, params.id, params.content, withFileMutationQueue);
      });
      if (mutation.status === "error") return memoryError(mutation.message);
      const result = mutation.value;
      if (result.status === "error") return memoryError(result.message);
      return {
        content: [{ type: "text", text: result.status === "unchanged"
          ? `Memo ${params.id} unchanged; nothing written.`
          : `Updated memo ${params.id} in ${store.scope} memory (${store.dir}). ID, creation date and note reference preserved; note last-modified-date updated.\n` +
            `Recovery ID: ${result.recoveryId}\n${restoreHint(result.recoveryId, store.scope, params.root)}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory Read",
    description:
      "Read memory contents. Default: one-line facts plus a derived note catalogue for scope 'both' (global + local). " +
      "Optional query filters index entries (case-insensitive substring). " +
      "Optional path reads an existing note file in the selected scope(s) (e.g. path='notes/2026-08-27-foo.md'). " +
      "Optional id retrieves exactly one indexed memo, including its note contents. Do not combine id with query/path. " +
      "Ambiguous IDs/paths require an explicit scope; no guessing." + workspaceGuidance,
    promptSnippet: "Read memory files (global and/or project-local)",
    parameters: Type.Object({
      root: rootParameter,
      scope: Type.Optional(StringEnum(["global", "local", "both"] as const)),
      id: Type.Optional(Type.String({ pattern: "^[a-fA-F0-9]{8}$", description: "Exact memo ID; returns the index entry and linked note contents" })),
      query: Type.Optional(Type.String({ description: "Optional case-insensitive substring filter" })),
      path: Type.Optional(
        Type.String({ description: "Optional note path to read, e.g. 'notes/2026-08-27-foo.md'" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const scopes = resolveScopes(params.scope);
      const target = toolStores(params.root, scopes);
      if (target.status === "error") return memoryError(target.message);
      const targetStores = target.stores;
      const preparationError = await prepareReadStores(targetStores, scopes);
      if (preparationError) return memoryError(preparationError);
      if (params.id !== undefined) {
        if (params.query !== undefined || params.path !== undefined) {
          return memoryError("Specify id alone, or use query/path without id.");
        }
        const memo = await readMemo(targetStores, params.id, scopes);
        if (memo.status === "error") return memoryError(memo.message);
        const out = `## ${memo.store.scope} memo ${params.id} — ${memo.store.memoryFile}\n\n` +
          `${memo.entry.meta ?? ""}\n${memo.entry.line}` +
          (memo.noteText !== undefined ? `\n\n## Note: ${memo.noteRel}\n\n${memo.noteText}` : "");
        return { content: [{ type: "text", text: formatTruncated(truncateTail(out, NOTE_CAP)) }], details: {} };
      }
      if (params.path !== undefined) {
        const resolved = resolveNotePath(targetStores, params.path, scopes);
        if (resolved.status === "error") return memoryError(resolved.message);
        const text = await readFile(resolved.absPath, "utf8");
        const out = `## ${resolved.store.scope} note: ${resolved.rel}\n\n${text}`;
        return {
          content: [{ type: "text", text: formatTruncated(truncateTail(out, NOTE_CAP)) }],
          details: {},
        };
      }
      const sections: string[] = [];
      for (const scope of scopes) {
        const store = targetStores[scope];
        const text = await readCatalogue(store);
        let body = text;
        if (params.query) {
          const q = params.query.toLowerCase();
          const kept = parseEntries(text).filter(
            (e) => e.line.toLowerCase().includes(q) || (e.meta ?? "").toLowerCase().includes(q),
          );
          body = kept.map((e) => `${e.meta ? `${e.meta}\n` : ""}${e.line}`).join("\n");
        }
        sections.push(
          `## ${scope} memory — ${store.memoryFile}${existsSync(store.memoryFile) ? "" : " (missing)"}\n\n${body.trim() || "(empty)"}`,
        );
      }
      return {
        content: [{ type: "text", text: formatTruncated(truncateTail(sections.join("\n\n"), READ_CAP)) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search facts and note bodies with weighted lexical ranking, exact tokens, phrase/coverage boosts and matching-passage snippets. Descriptions and tags weigh more; one result per note. Default scope 'both'." + workspaceGuidance,
    promptSnippet: "Search stored memory (global and/or project-local)",
    promptGuidelines: [
      "Use memory_search before guessing at previously established preferences, decisions, or facts.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search terms" }),
      scope: Type.Optional(StringEnum(["global", "local", "both"] as const)),
      root: rootParameter,
    }),
    renderCall(args, theme, _context) {
      const scope = args.scope ?? "both";
      return new Text(
        theme.fg("toolTitle", theme.bold("memory_search")) +
          " " +
          theme.fg("muted", `[${scope}]`) +
          " " +
          theme.fg("dim", `"${args.query}"`),
        0,
        0,
      );
    },
    async execute(_toolCallId, params) {
      const scopes = resolveScopes(params.scope);
      const target = toolStores(params.root, scopes);
      if (target.status === "error") return memoryError(target.message);
      const preparationError = await prepareReadStores(target.stores, scopes);
      if (preparationError) return memoryError(preparationError);
      const hits = await searchStores(target.stores, params.query, scopes, 20);
      if (hits.length === 0) {
        return { content: [{ type: "text", text: "No matches in memory." }], details: {} };
      }
      const lines = hits.map(
        (h) =>
          `[${h.scope}/${h.file}] ${h.id ? `[id=${h.id}] ` : ""}${h.line}${h.matchLines > 1 ? ` (+${h.matchLines - 1} more matching lines)` : ""}`,
      );
      return {
        content: [{ type: "text", text: formatTruncated(truncateTail(lines.join("\n"), READ_CAP)) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description:
      "Delete facts or notes whose description, path or metadata contains the given text (case-insensitive); note bodies are not matched. Removes note files with recoverable snapshots. Returns a recovery ID for memory_restore. Default scope 'local'." + workspaceGuidance,
    promptSnippet: "Delete memory entries (recoverable)",
    parameters: Type.Object({
      text: Type.String({ description: "Text that identifies entries to delete" }),
      scope: Type.Optional(StringEnum(["local", "global"] as const)),
      root: rootParameter,
    }),
    async execute(_toolCallId, params) {
      const target = toolStores(params.root, [params.scope ?? "local"]);
      if (target.status === "error") return memoryError(target.message);
      const store = target.stores[params.scope ?? "local"];
      const mutation = await mutateMemory(target.stores, store.scope, async () => {
        return forgetEntries(store, params.text, withFileMutationQueue);
      });
      if (mutation.status === "error") return memoryError(mutation.message);
      const result = mutation.value;
      if (result.recoveryId === null) {
        return {
          content: [{ type: "text", text: `No entries matching "${params.text}" in ${store.scope} memory.` }],
          details: {},
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Removed ${result.removed.length} entr(y/ies) from ${store.scope} memory (${store.memoryFile}). Recovery id: ${result.recoveryId}\n` +
              restoreHint(result.recoveryId, store.scope, params.root),
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "memory_restore",
    label: "Memory Restore",
    description: "Restore entries deleted by memory_forget or undo a memory_update using its recovery ID. Refuses to overwrite later edits; conflicts retain the recovery record. Default scope 'both'; use the same root as the original change." + workspaceGuidance,
    promptSnippet: "Undo a memory deletion or update",
    parameters: Type.Object({
      recoveryId: Type.String({ description: "Recovery id returned by memory_forget or memory_update" }),
      scope: Type.Optional(StringEnum(["global", "local", "both"] as const)),
      root: rootParameter,
    }),
    async execute(_toolCallId, params) {
      const scopes = resolveScopes(params.scope);
      const target = toolStores(params.root, scopes);
      if (target.status === "error") return memoryError(target.message);
      const result = await restoreEntry(target.stores, params.recoveryId, withFileMutationQueue, scopes,
        (store) => workspaceAccessError(target.stores, [store.scope]), ensureStoreVersion);
      if (!result) {
        return {
          content: [{ type: "text", text: `No recovery record found for id ${params.recoveryId}.` }],
          details: {},
        };
      }
      if (result.status === "error") return memoryError(result.message);
      await refreshSnapshotFor(target.stores[result.scope]);
      return {
        content: [
          {
            type: "text",
            text:
              `Restored ${result.entries.length} entr(y/ies) to ${result.scope} memory:\n` +
              result.entries.map((e) => `- ${e.line}`).join("\n"),
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "memory_status",
    label: "Memory Status",
    description: "Show memory file locations, sizes, entry counts, and current session's injected snapshot size. Optional root selects another existing workspace. Works before memory_init and never creates files.",
    promptSnippet: "Show memory storage status",
    parameters: Type.Object({ root: rootParameter }),
    async execute(_toolCallId, params) {
      const target = toolStores(params.root, ["local"], false);
      if (target.status === "error") return memoryError(target.message);
      return { content: [{ type: "text", text: await buildStatusText(target.stores) }], details: {} };
    },
  });

  registerMemoryCommand(pi, () => buildStatusText());
}
