# pi-remember

Durable memory for [pi](https://pi.dev/): a curated, plain-file knowledge cache that survives sessions. Save knowledge that was **expensive to obtain** and will matter again—decisions, preferences, lessons, environment quirks, research findings—not todos, debugging state, transcripts, or “the user asked me to X.” Pi's session files (`/resume`) already preserve session continuity.

| Scope | Store directory | Use for |
|---|---|---|
| `local` (default for writes) | `<root>/.pi/memory/` | Knowledge about that workspace, repo, software, server, or configuration |
| `global` | `~/.pi/agent/memory/` | Facts about the user or machine itself: identity, OS, global tool preferences |

`root` defaults to the session working directory. `PI_REMEMBER_DIR` overrides the global directory. Specific software/configuration knowledge belongs in its workspace even when the software is installed machine-wide.

## Install

```sh
pi install npm:@seangle/pi-remember
```

Restart Pi (or use `/reload` in an existing session) after installation. Use `/memory` for help and ask Pi to remember a durable fact to get started. Local writes require explicit initialization with the `memory_init` tool; global memory needs no initialization.

Requires Node.js **22.15 or newer**. Tested with Pi **1.4.0** (`@earendil-works/pi-coding-agent`); older Pi versions or other forks may not provide the host APIs this extension uses. Pi loads the TypeScript source directly; no build step or external service is needed.

**Upgrading from a manually installed copy:** remove or move the old extension directory out of `~/.pi/agent/extensions/` before loading the npm package, so the same tools are not registered twice. Keep your memory stores; they live separately from the extension. Review the migration section below before upgrading existing stores.

Source and issues: [Esensats/pi-remember](https://github.com/Esensats/pi-remember). The npm package is **`@seangle/pi-remember`**, not the unrelated unscoped `pi-remember` package.

## Architecture and file format

There is **no database, daemon, embedding service, or durable duplicate index**. Facts live in `MEMORY.md`; detailed notes are standalone Markdown files whose frontmatter is authoritative. A note catalogue is derived from those files when needed, never saved back into `MEMORY.md`.

Each store can contain:

| Path | Contents |
|---|---|
| `MEMORY.md` | One-line facts and their metadata comments; not note references |
| `notes/<YYYY-MM-DD>-<slug>.md` | Standalone notes with YAML frontmatter and a Markdown body |
| `pi-remember.json` | Store format marker: `{"version": 1}` |
| `recovery/<recovery ID>.json` | Recoverable deletions and updates, including note snapshots |
| `migrations/v0-to-v1-<uuid>/` | Original-file backups and a manifest from each migration attempt |

Directories for notes and recovery are created only as needed. An absent store is not created merely by startup or migration checks.

### Facts

A fact is one line, at most 300 characters, with an eight-hex memo ID and a creation timestamp in the preceding HTML comment:

```markdown
<!-- 2026-10-18T16:10:33Z [a1b2c3d4] -->
#lesson Use the workspace's own virtual environment.
```

**Facts currently have no last-modified date.** Updating a fact retains its ID and creation comment. Tags (`#lesson`) and wiki-links (`[[topic]]`) are optional text conventions, not required schema. Existing facts without IDs remain readable, but cannot be targeted by the ID-based update tool.

### Notes

```markdown
---
description: "Python environment conventions"
memory-id: "e5f6a7b8"
created-date: "2026-10-18T16:10:33.000Z"
last-modified-date: "2026-10-18T16:10:33.000Z"
---
# Optional body heading

Confirmed details, rationale, and examples go here.
```

The four frontmatter fields are **`description`, `memory-id`, `created-date`, and `last-modified-date`**. The description is the short catalogue text; it is not a body heading. IDs identify memos independently of their paths.

`memory_store` retains the parameter name **`title` for backwards compatibility**, but it now means **description**. New descriptions must be nonempty, single-line, and at most 300 characters. Pass Markdown body text as `content`, **without frontmatter**. No H1 is generated; include your own heading in the body if useful.

Choose an optional `slug` of 1–80 letters/digits separated by hyphens, **without a date, path, or extension**. The filename always receives the UTC creation date and `.md`: `notes/2026-10-18-python-environments.md`. Omitting `slug` uses a description-derived slug for older callers. Filename collisions receive numbered suffixes rather than overwriting files.

The parser deliberately supports a **small scalar YAML subset**, not arbitrary YAML:

- Exactly the four known fields, each once; blank lines and comments are allowed.
- Plain scalars, single-quoted scalars (doubled apostrophes), or double-quoted scalars with JSON-compatible escapes. Quote ambiguous values.
- No nested structures, lists, multiline values, tags, anchors, aliases, unknown fields, or duplicate fields.
- A nonempty single-line description, an eight-hex ID, and valid ISO timestamps with time zones are required.
- The header, including delimiters, must fit within **16 KiB of UTF-8**. Metadata discovery reads in 512-byte chunks and stops at the closing delimiter, with a hard cap of 16 KiB plus one lookahead byte, rather than loading large note bodies.

A file beginning with a frontmatter delimiter but containing an invalid, incomplete, or oversized header is an error, not a legacy-note fallback. Invalid notes can make catalogue operations fail; optional session injection omits the affected scope instead of breaking the session. Ordinary text without frontmatter is treated as legacy input during migration.

## Session context and retrieval

At session start, pi-remember builds a snapshot containing facts plus a **frontmatter-only derived note catalogue**: description, memo ID, creation date, last-modified date, and path. Catalogue references may look like `#note [[notes/...]] Description`, but these are generated views, not persistent `MEMORY.md` entries. **Note bodies are not injected**; retrieve them explicitly by ID/path or search them on demand.

The snapshot is byte-stable between turns: `before_agent_start` appends the saved block without rereading files or making model calls. Writes/deletions and successful updates/restores to global or current-workspace memory rebuild it; another workspace's local changes do not replace the session's injected local memory. External file edits are not watched—start a fresh session to reliably pick them up.

Each scope has a default **3,000-character snapshot budget**. Oversized content keeps roughly the first 20% and last 80%, replacing the middle with a truncation notice. These are character budgets, not token/byte limits or strict final-output ceilings: the notice, scope headings, and enclosing instructions add overhead. The snapshot can omit entries or cut through an entry; read/search the store before making decisions based on it.

### Search

`memory_search` builds a **query-local BM25F-like lexical ranking** over facts and notes. No embeddings, vector database, persistent search index, or model call is involved.

- Unicode-normalized, case-insensitive **exact tokens**, not substring matches; common English stopwords and tokens shorter than two characters are omitted.
- Field weighting favors descriptions and tags/wiki-links; term-frequency saturation and length normalization limit repetition bias.
- Query coverage and contiguous phrase matches boost ranking. Quotes request a phrase boost, **not a mandatory phrase filter**.
- A note's description and body form one document, producing **one hit and one matching-passage snippet per note**, with scope/path/ID and an additional matching-line count where applicable.
- Managed frontmatter and HTML comments are excluded from searchable body text. Dates and IDs are metadata, not body keywords; use exact-ID reads for identity lookup.
- Up to 20 results are returned. Search reads bodies on demand; injection/catalogue discovery does not.

For a simple substring filter over fact/catalogue lines and metadata, use `memory_read({query})` instead.

## Tools

Every tool accepts optional `root`; it selects only local memory. Scope defaults differ intentionally:

| Tool | Parameters / behavior | Default scope |
|---|---|---|
| `memory_init` | `{root?}`: explicitly initialize local memory in an existing workspace; preserve existing contents | local only |
| `memory_write` | `{content, scope?, root?}`: append one fact (≤300 chars) | `local` |
| `memory_store` | `{title, content, slug?, scope?, root?}`: create a standalone frontmatter note; `title` means description | `local` |
| `memory_read` | `{id?, query?, path?, scope?, root?}`: facts + derived catalogue, substring filter, exact memo lookup, or file read | `both` |
| `memory_search` | `{query, scope?, root?}`: ranked fact/note search with snippets | `both` |
| `memory_update` | `{id, content, scope?, root?}`: revise one existing memo in place; return recovery ID on change | `local` |
| `memory_forget` | `{text, scope?, root?}`: case-insensitive substring deletion by fact text or note description/path/identity metadata, **not note body** | `local` |
| `memory_restore` | `{recoveryId, scope?, root?}`: undo a deletion or update | `both` |
| `memory_status` | `{root?}`: store paths, counts, fact-file sizes, recoveries, and current session snapshot size | both stores |

New writes use normalized-text duplicate checks against facts and the derived catalogue. Duplicate note storage returns existing references **without creating or overwriting a note**; read and update the existing memo instead. Similar entries in the other scope can produce non-blocking warnings. These are text heuristics, not semantic deduplication or a body-comparison service.

Read/search outputs are bounded: catalogue/search output uses 20,000-byte / 400-line limits; note/ID reads use 30,000-byte / 600-line limits. Truncation keeps the tail and is reported. For a larger file, use pi's ordinary file-reading tools with offsets.

## Workspaces, initialization, and security

`root` is the **workspace directory containing `.pi`**, not `.pi` or the memory directory. Absolute paths, `~/` paths, and paths relative to the session cwd are accepted. The workspace must already exist; tools never create it. Symlinked workspace roots are canonicalized, and local access is rechecked after mutation-queue waits to avoid following a replaced root.

Roots are **per call**: accessing another workspace does not change subsequent default calls or the session's injected local memory. Global-only calls ignore `root` entirely and do not depend on local initialization. `scope: 'both'` combines global memory with the selected workspace's local store; it does not search every workspace.

Before using a local store, call `memory_init({root})` **only when you intend to create memory there**:

- It exclusively creates an empty `.pi/memory/MEMORY.md` if missing, never truncates existing memory, and never recreates a vanished workspace. Notes/recovery directories stay lazy; format setup may create version/migration files.
- An existing regular `MEMORY.md` already satisfies initialization; legacy data still needs the automatic format migration described below.
- Local tools, including reads/searches and default `both` calls, fail with an initialization instruction if `MEMORY.md` is missing. A notes-only local store still requires that file.
- `memory_status({root})` is the diagnostic exception: it works before initialization and never creates files or migrates the selected store. Its snapshot counts always describe the **current session**, not the selected root. Note counts include recursively discovered valid frontmatter notes. A note-only global store is reported even without a facts file.
- Global memory needs no explicit initialization. Use `scope: 'global'` from an uninitialized workspace rather than creating unwanted local memory just to make a search succeed.

Example tool calls from a session in another directory:

```js
memory_status({root: '~/homelab'})
memory_init({root: '~/homelab'}) // only if you intend to create its local store
memory_search({root: '~/homelab', scope: 'local', query: 'TV server'})
memory_store({
  root: '~/homelab',
  title: 'TV server configuration', // stored as description
  slug: 'tv-server',
  content: '# TV server\n\nConfirmed durable details…',
})
memory_read({root: '~/homelab', scope: 'local', id: 'e5f6a7b8'}) // use returned ID
memory_update({root: '~/homelab', id: 'e5f6a7b8', content: '# TV server\n\nFull revised body…'})
memory_restore({root: '~/homelab', scope: 'local', recoveryId: '<returned recovery ID>'})
```

Safe explicit path resolution rejects traversal/out-of-scope files and symlinks escaping a store. Catalogue discovery skips symlink aliases, and note/recovery writes refuse redirected subdirectories. Migration refuses symlinks within its input paths, including internal aliases. These checks are not a sandbox against hostile concurrent filesystem changes. Memory tools operate on local files with pi's permissions: `root` is not an SSH destination, and stored knowledge never grants remote-access permission. Do not store secrets or credentials.

## IDs, updates, deletion, and undo

A **memo ID** is eight hexadecimal characters, stored in a fact's metadata comment or a note's `memory-id`. A **recovery ID** identifies an undo record, not a memo. Use memo IDs with `memory_read`/`memory_update`, recovery IDs with `memory_restore`.

- `memory_read({id})` returns exactly one memo, including the complete stored note text subject to output limits. Do not combine `id` with `query` or `path`.
- IDs or relative paths present in both scopes are ambiguous with `scope: 'both'`; select `local` or `global`. Duplicate IDs within one scope require manual resolution, not a guessed match.
- `memory_update` requires a prior read. For facts, pass the replacement single line (≤300 chars); for notes, pass the **full revised body without frontmatter**, including any body heading you want to retain. Preserve unrelated/correct details.
- A note update preserves description, ID, creation date, and path; **`last-modified-date` advances only on an actual body change**. Fact updates do not add a modified date. Blank content is rejected; normalized/trim-equivalent no-ops leave bytes, timestamps, and recovery state untouched.
- Actual updates save recovery data before replacing the file. Targeted fact updates preserve unrelated bytes; file replacements are atomic and retain permissions. Extension mutations use pi's file-mutation queues. Note updates/undo use the note-file queue; deletion holds all selected note queues before snapshotting and removing them. New notes and recovery records are published atomically without overwriting existing paths.
- `memory_forget` saves matching entries and full note snapshots before removing them, including the note files themselves. For notes, the generated identity metadata used for matching contains the ID and creation date, **not the last-modified date**. Use a specific ID/path/description to avoid broad deletions.
- `memory_restore` must use the **same root** as the original change. It searches only the selected stores. Ambiguous recovery IDs, existing recovered paths/IDs, missing targets, and later edits cause refusal; conflicting recovery records are retained.
- Update undo checks the memo's identity and exact saved “after” content before restoring “before.” Note undo restores the **snapshot's metadata too**, including its previous last-modified date; it does not stamp the undo time. Successful undo consumes its recovery record. Deletion undo restores saved facts/notes without creating persistent note references and retains saved note permissions. Newly created notes/recovery records default to owner-only access (`0600`); new note/recovery directories use `0700`.

## Format versions and automatic migration

`pi-remember.json` inside each store records **format version 1**. An absent marker (or version `0`) means legacy format: note references were persisted in `MEMORY.md`, and generated notes could have a timestamp comment plus an automatic H1.

Migration runs automatically:

- At session startup for existing global and current-workspace stores.
- Lazily before ordinary reads/searches or mutations of another workspace; restore prepares its selected recovery store before changing it.
- Around initialization/first writes to establish the version of a newly created store. Missing stores are never created by migration itself.

**A read/search can therefore write migration data.** Status inspection does not migrate. Startup migration failures warn when UI is available and omit that scope from injection; explicit operations surface the error. Invalid or future versions are refused rather than guessed or overwritten, and version checks are repeated rather than permanently cached.

Migration validates its entire conversion plan before making backups or changing memory data. Each attempt creates **`migrations/v0-to-v1-<uuid>/`** containing a manifest (including modes, timestamps, and inference rules) and read-only, byte-for-byte backups of **all affected originals before any original is mutated**. Backups are retained even after success or a partial failure. The version marker is committed last; interrupted work can be retried with a new backup set. This is not a single multi-file transaction or an automatic rollback mechanism.

Conversion preserves existing memo IDs, note paths, fact bytes, unrelated index bytes, and file modes. It removes persisted note references and their managed comments from `MEMORY.md`, moving identity/description/dates into notes. Only the recognized generated legacy timestamp marker and its immediate generated H1/blank line are stripped; user-authored body headings remain. Existing valid frontmatter is retained. Unindexed legacy notes become discoverable standalone notes and receive IDs if needed.

Legacy notes had no recorded modified date: migration infers it from the original file's filesystem mtime. Creation comes from existing index/generated metadata where available, otherwise from mtime. These are documented inferences, not reconstructed edit history.

Recovery records migrate too, including old deletion records and whole-note update snapshots. **Forgotten notes are not resurrected**: legacy files left behind after deletion are snapshotted into recovery and removed from the active store. Recovery conversion happens before note/index edits so retries can retain identities and conflict checks. Malformed records, unsafe/dangling references, duplicate IDs, or conflicting metadata halt migration rather than silently dropping data.

### Concurrency and compatibility limits

In-process migration calls for the same canonical store share one run. An exclusively created **`.pi-remember-migration.lock`** serializes migrators across processes; existing locks cause a clear refusal, are never stolen, and require manual inspection if left after a crash. Backups are followed by a source-change check before applying the plan.

The migration lock is **not a general cross-process writer lock**. Pi's ordinary file-mutation queues coordinate cooperating operations within the host process, not other pi instances, editors, sync tools, or old binaries. Avoid concurrent writers during migration; a lock cannot make uncooperative writers safe.

**Old binaries are not safe to use against a migrated store. There is no backward-writer support or dual-format index.** Upgrade every writer; do not downgrade by deleting the version marker. New code refuses future versions, but old code may not understand the marker at all. Preserve the migration backups before any manual recovery or downgrade work.

## Commands

- **`/memory`** shows status in a notification, without starting an agent turn.
- **`/memory update`** sends an incremental memory-review reminder to the **current session's agent**. When idle it starts a normal turn; when busy it queues a **follow-up**, not an interruption. It uses the available conversation context (including compaction summaries) and normal tools, not a separate summarizer or bulk rewrite. Unknown arguments show usage; `update` is offered in completion.

The reminder asks the agent to read/search relevant memory, add missed durable knowledge, correct confirmed errors with `memory_update`, and recoverably remove obsolete entries. It preserves unrelated/correct knowledge, treats age alone as insufficient evidence, avoids secrets/task state, and permits no changes when nothing useful needs saving. The agent briefly reports its changes or that none were needed. **The command does not authorize remote actions or carry prior remote permission forward.** Reload extension changes with `/reload`.

## Configuration and opt-in exit summary

| Environment variable | Default | Purpose |
|---|---|---|
| `PI_REMEMBER_DIR` | `~/.pi/agent/memory` | Global store directory |
| `PI_REMEMBER_INJECT_CHARS_GLOBAL` | `3000` | Global snapshot character budget, plus truncation/wrapper overhead |
| `PI_REMEMBER_INJECT_CHARS_LOCAL` | `3000` | Local snapshot character budget, plus truncation/wrapper overhead |
| `PI_REMEMBER_EXIT_SUMMARY` | off | Enable with `1`, `true`, `yes`, or `on` (case-insensitive) |
| `PI_REMEMBER_EXIT_SUMMARY_MODEL` | session model | Optional `provider/model-id` (or model ID); unavailable selection falls back to the session model |
| `PI_REMEMBER_EXIT_SUMMARY_SCOPE` | `auto` | `global`, `local`, or `auto`: local if the session workdir has `.pi`, otherwise global |
| `PI_REMEMBER_EXIT_SUMMARY_TIMEOUT_MS` | `10000` | Timeout for waiting on the summary model response |

Character budgets and timeout must parse as positive integers; invalid/nonpositive values use defaults. Zero does not disable injection. Configuration is loaded when the extension loads; reload/restart after changing it.

Exit summarization runs only on session shutdown with reason **`quit`**, when opted in. It sends up to the last 20,000 characters of user/assistant text from the current session branch to the selected model, asks for at most six concise durable fact lines (or `NONE`), filters the response, and appends accepted facts with normal duplicate checks. It is a model call that may incur cost and send conversation text to that provider—not purely local processing. No cheap model is automatically selected; choose one explicitly if desired.

A selected but uninitialized local store is **skipped**, not created and not redirected to global. Too little conversation text, missing model/authentication, errors, and timeouts are best-effort skips. The timeout stops waiting for the response; it does **not** cancel the underlying provider request. This opt-in extractor is separate from `/memory update` and does not perform its targeted review/correction workflow.

## Git and development

To keep workspace memory private, add this to the project's `.gitignore`:

```gitignore
.pi/memory/
```

Committing memory shares it with the team. Review not just facts/notes but **recovery snapshots and migration backups**, which may retain removed information. Files are plain Markdown/JSON and can be reviewed in git; concurrent merges still require care with unique IDs and metadata.

No build step: pi loads TypeScript via jiti. There are no declared npm dependencies; host imports (`pi`, TypeBox, and TUI) are supplied by pi. For a one-off load, use `pi --extension ./index.ts` from this directory.

```sh
git clone git@github.com:Esensats/pi-remember.git
cd pi-remember
npm test
# node --experimental-strip-types --test "test/*.test.ts"
```

Use **Node >=22.15**: tests execute TypeScript directly with Node's experimental type stripping, and integration stubs use `module.registerHooks`. No separate TypeScript build or test runner is required. The tests use temporary fixture stores rather than live memory.

Source responsibilities:

| Module | Responsibility |
|---|---|
| `store.ts` | Facts, standalone note storage/discovery, derived catalogue, IDs, updates, deletion/recovery, safe path lookup |
| `notes.ts` | Bounded frontmatter parsing/serialization and legacy generated-header handling |
| `migration.ts` | Version guards, validation/planning, backups, migration lock, conversion of notes and recovery records |
| `workspace.ts` | Existing-root resolution, explicit initialization, local-access guards |
| `search.ts` | Query-local lexical ranking and passage selection |
| `inject.ts` | Stable snapshot construction and middle truncation |
| `summary.ts` | Exit-summary text extraction, prompt, and response filtering |
| `command.ts` | `/memory` routing and incremental-review reminder (type-only pi import) |
| `index.ts` | Host integration: lifecycle, tools, queues, configuration, snapshot refresh, exit-summary model call |

Core modules have no pi runtime imports and are tested with plain Node; command behavior uses a stub API, and extension wiring tests stub host imports with Node module hooks.

## License

Copyright 2026 Esensats.

Licensed under the [Apache License, Version 2.0](LICENSE). Contributions are accepted under the same license.
