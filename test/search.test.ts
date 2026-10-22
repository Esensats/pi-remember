import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { scoreLine, searchInText, searchStores, tokenize } from "../search.ts";
import { resolveStores, type Scope, type StorePaths } from "../store.ts";

test("tokenize drops stopwords and short tokens", () => {
  assert.deepEqual(tokenize("How do I configure the proxy?"), ["configure", "proxy"]);
  assert.deepEqual(tokenize("pnpm"), ["pnpm"]);
});

test("searchInText ranks tag hits above plain hits", () => {
  const text = [
    "<!-- m1 -->",
    "#preference [[pnpm]] Always use pnpm in this repo.",
    "Plain line mentioning pnpm once.",
    "",
  ].join("\n");
  const hits = searchInText("local", "/mem/MEMORY.md", text, "pnpm");
  assert.equal(hits.length, 2);
  assert.match(hits[0].line, /Always use pnpm/);
  assert.ok(hits[0].score > hits[1].score);
});

test("searchInText finds a multi-token phrase", () => {
  const text = "#fact The websocket proxy is at ws://localhost:8080\n\n#fact Another line\n";
  const hits = searchInText("local", "/m", text, "websocket proxy");
  assert.equal(hits.length, 1);
});

test("searchStores reads both scopes and caps results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remember-search-"));
  const stores = resolveStores(dir, join(dir, "global-mem"), ".pi");
  try {
    await mkdir(join(dir, "global-mem"), { recursive: true });
    await mkdir(join(dir, ".pi", "memory"), { recursive: true });
    await writeFile(stores.global.memoryFile, "#fact Global fact about arch linux.\n", "utf8");
    await writeFile(stores.local.memoryFile, "#fact Local fact about pnpm.\n", "utf8");
    const hits = await searchStores(stores, "pnpm", ["global", "local"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].scope, "local");
    const none = await searchStores(stores, "docker", ["global", "local"]);
    assert.equal(none.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchStores indexes note files with notes/ labels", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remember-search-note-"));
  const stores = resolveStores(dir, join(dir, "global-mem"), ".pi");
  try {
    await mkdir(stores.local.notesDir, { recursive: true });
    await writeFile(
      join(stores.local.notesDir, "2026-08-27-k8s.md"),
      "# k8s\n\nThe control plane uses containerd, not docker.\n",
      "utf8",
    );
    const hits = await searchStores(stores, "containerd control plane", ["local"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].scope, "local");
    assert.equal(hits[0].file, "notes/2026-08-27-k8s.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchStores groups note lines: one hit per file, best line wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remember-search-group-"));
  const stores = resolveStores(dir, join(dir, "global-mem"), ".pi");
  try {
    await mkdir(stores.local.notesDir, { recursive: true });
    await writeFile(
      join(stores.local.notesDir, "2026-08-27-k8s.md"),
      [
        "# k8s ops",
        "",
        "Control plane runs containerd.",
        "Workers also use containerd.",
        "Networking is flannel.",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(stores.local.notesDir, "2026-08-27-other.md"),
      "# unrelated\n\nJust a placeholder note about nothing.\n",
      "utf8",
    );
    const hits = await searchStores(stores, "containerd", ["local"]);
    assert.equal(hits.length, 1); // one hit despite 2 matching lines; other note not matched
    assert.equal(hits[0].file, "notes/2026-08-27-k8s.md");
    assert.match(hits[0].line, /containerd/i);
    assert.equal(hits[0].matchLines, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchStores ranks term density before raw matching line count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-remember-search-tie-"));
  const stores = resolveStores(dir, join(dir, "global-mem"), ".pi");
  try {
    await mkdir(stores.local.notesDir, { recursive: true });
    await writeFile(
      join(stores.local.notesDir, "2026-08-27-a.md"),
      "# a\n\nflannel flannel flannel\n",
      "utf8",
    );
    await writeFile(
      join(stores.local.notesDir, "2026-08-27-b.md"),
      "# b\n\nflannel here\nflannel there\nflannel everywhere\n",
      "utf8",
    );
    const hits = await searchStores(stores, "flannel", ["local"]);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].file, "notes/2026-08-27-a.md"); // same term frequency, less irrelevant text
    assert.equal(hits[1].matchLines, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function withStores(run: (stores: Record<Scope, StorePaths>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-remember-ranking-"));
  const stores = resolveStores(dir, join(dir, "global"), ".pi");
  try {
    await Promise.all(Object.values(stores).map((store) => mkdir(store.notesDir, { recursive: true })));
    await run(stores);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function frontmatter(description: string, id: string, body: string): string {
  return [
    "---", `description: ${JSON.stringify(description)}`, `memory-id: ${id}`,
    "created-date: 2026-08-27T12:34:56Z", "last-modified-date: 2026-10-18T23:45:12Z",
    "---", "", body, "",
  ].join("\n");
}

const note = (store: StorePaths, file: string, content: string) =>
  writeFile(join(store.notesDir, file), content, "utf8");

test("exact normalized tokens do not match arbitrary substrings or tag prefixes", () => {
  const text = [
    "PostgreSQL contains no SQL token.",
    "Archiving is not an architecture preference.",
    "A #dockerized service is running.",
    "[[proxypass]] settings are documented.",
  ].join("\n");
  assert.equal(searchInText("local", "MEMORY.md", text, "postgres").length, 0);
  assert.equal(searchInText("local", "MEMORY.md", text, "arch").length, 0);
  assert.equal(searchInText("local", "MEMORY.md", text, "docker").length, 0);
  assert.equal(searchInText("local", "MEMORY.md", text, "proxy").length, 0);
  assert.equal(scoreLine("#dockerized", undefined, ["docker"], "docker"), 0);
  assert.deepEqual(tokenize("ＰＲＯＸＹ CAFÉ контейнер"), ["proxy", "café", "контейнер"]);
  assert.equal(searchInText("local", "MEMORY.md", "Use ＰＲＯＸＹ for CAFÉ.", "proxy café").length, 1);
});

test("repeated query terms do not add coverage or repeated-token phrase boosts", () => {
  const text = "Use proxy locally.\nproxy proxy proxy proxy\n";
  const once = searchInText("local", "MEMORY.md", text, "proxy");
  const repeated = searchInText("local", "MEMORY.md", text, "proxy proxy proxy");
  assert.deepEqual(repeated, once);
  assert.equal(scoreLine("Use a proxy", undefined, ["proxy", "proxy"], "proxy"),
    scoreLine("Use a proxy", undefined, ["proxy"], "proxy"));
});

test("ordered phrases beat scattered or reversed terms, preserving stopwords", () => {
  const text = [
    "Proxy services support docker deployments.",
    "Docker in proxy environments requires configuration.",
    "Proxy in docker environments requires configuration.",
  ].join("\n");
  const hits = searchInText("local", "MEMORY.md", text, '"proxy in docker"');
  assert.match(hits[0].line, /^Proxy in docker/);
  assert.ok(hits[0].score > hits[1].score);
  assert.equal(hits.length, 3); // Phrase boosts, rather than removing useful partial matches.
});

test("fact IDs survive parsing, while metadata identifiers and dates are not searchable", () => {
  const text = "<!-- 2026-08-27T12:34:56Z [abcdef12] -->\nPrefer pnpm workspaces.\n";
  const hits = searchInText("local", "/tmp/MEMORY.md", text, "pnpm");
  assert.equal(hits[0].id, "abcdef12");
  assert.equal(searchInText("local", "MEMORY.md", text, "abcdef12").length, 0);
  assert.equal(searchInText("local", "MEMORY.md", text, "2026").length, 0);
});

test("distinct query coverage across a document beats repetitive partial matches", async () => {
  await withStores(async (stores) => {
    await note(stores.local, "restore.md", "# Runbook\nPostgreSQL is the database.\n\nDaily backup snapshots are retained.\n\nUse restore drills to verify recovery.");
    await note(stores.local, "spam.md", `# Log\n${"PostgreSQL ".repeat(120)}`);
    await note(stores.local, "partial.md", "PostgreSQL backup status is healthy.");
    const hits = await searchStores(stores, "postgresql backup restore", ["local"]);
    assert.equal(hits[0].file, "notes/restore.md");
    assert.equal(hits[0].matchLines, 3);
    assert.ok(hits[0].score > hits[1].score);
    assert.equal(hits.at(-1)?.file, "notes/spam.md");
  });
});

test("corpus rarity distinguishes an uncommon meaningful term from common boilerplate", async () => {
  await withStores(async (stores) => {
    await note(stores.local, "rare.md", "litestream recovery procedures are documented");
    await note(stores.local, "common.md", "database recovery procedures are documented");
    for (let i = 0; i < 5; i++) await note(stores.local, `database-${i}.md`, "database operations general reference documentation");
    const hits = await searchStores(stores, "database litestream", ["local"]);
    assert.equal(hits[0].file, "notes/rare.md");
  });
});

test("standalone frontmatter descriptions are weighted, searchable, and retain memo identity", async () => {
  await withStores(async (stores) => {
    await note(stores.local, "title.md", frontmatter("PostgreSQL backup runbook", "aabbcc11", "Snapshots are stored offsite.\nRestore drills run weekly."));
    await note(stores.local, "body.md", frontmatter("Operations journal", "aabbcc22", "PostgreSQL backup runbook appears in this journal."));
    const hits = await searchStores(stores, "postgresql backup", ["local"]);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].file, "notes/title.md");
    assert.equal(hits[0].id, "aabbcc11");
    assert.equal(hits[0].line, "PostgreSQL backup runbook"); // No matching body: use description.
    assert.ok(hits[0].score > hits[1].score);
  });
});

test("tags and wiki links boost exact tokens over otherwise equivalent prose", async () => {
  await withStores(async (stores) => {
    await note(stores.local, "plain.md", "docker deployment configuration");
    await note(stores.local, "tag.md", "#docker deployment configuration");
    await note(stores.local, "link.md", "[[docker]] deployment configuration");
    const hits = await searchStores(stores, "docker", ["local"]);
    assert.equal(hits.length, 3);
    assert.equal(hits.at(-1)?.file, "notes/plain.md");
    assert.ok(hits[0].score > hits[2].score);
  });
});

test("frontmatter field names, IDs, timestamps, and filenames do not leak into matches or snippets", async () => {
  await withStores(async (stores) => {
    const text = frontmatter("Proxy deployment guide", "deadbeef", "The proxy listens on localhost.");
    await note(stores.local, "filenamecanary.md", text);
    for (const query of ["deadbeef", "2026", "modified", "description", "memory", "filenamecanary"]) {
      assert.deepEqual(await searchStores(stores, query, ["local"]), [], query);
    }
    const [hit] = await searchStores(stores, "proxy", ["local"]);
    assert.match(hit.line, /proxy listens/);
    assert.doesNotMatch(hit.line, /description|deadbeef|2026|memory-id|---/);
    assert.equal(hit.matchLines, 1);
    assert.equal(searchInText("local", "notes/test.md", text, "deadbeef").length, 0);
    assert.equal(searchInText("local", "notes/test.md", "---\nmemory-id: deadbeef\n", "deadbeef").length, 0);
  });
});

test("legacy indexed notes merge description, ID, and body into one ranked document", async () => {
  await withStores(async (stores) => {
    await writeFile(stores.local.memoryFile, [
      "<!-- 2026-08-27T12:34:56Z [abcdef12] -->",
      "#note [[notes/legacy.md]] PostgreSQL backup recovery",
      "Use pnpm for repository installs.",
    ].join("\n"));
    await note(stores.local, "legacy.md", "<!-- pi-remember note: 2026-08-27T12:34:56Z -->\n# PostgreSQL backup recovery\n\nRecovery uses an offsite snapshot.");
    const hits = await searchStores(stores, "postgresql recovery", ["local"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, "notes/legacy.md");
    assert.equal(hits[0].id, "abcdef12");
    assert.equal((await searchStores(stores, "offsite", ["local"]))[0].id, "abcdef12");
    assert.deepEqual(await searchStores(stores, "2026", ["local"]), []);
  });
});

test("frontmatter notes with leftover legacy references do not produce double hits", async () => {
  await withStores(async (stores) => {
    await writeFile(stores.local.memoryFile, "<!-- old [abcddcba] -->\n#note [[notes/migrated.md]] Proxy deployment guide\n");
    await note(stores.local, "migrated.md", frontmatter("Proxy deployment guide", "abcddcba", "Use a proxy for local services."));
    const hits = await searchStores(stores, "proxy", ["local"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "abcddcba");
    assert.equal(hits[0].file, "notes/migrated.md");
  });
});

test("best passage covers the query, ignores earlier weak matches, and stays bounded", async () => {
  await withStores(async (stores) => {
    await note(stores.local, "passage.md", [
      "# Deployment log", "The proxy was inspected.", "",
      "Unrelated historical logging details. ".repeat(100),
      "", "Proxy connection failed; certificate rotation fixes the timeout.",
      "Keep the previous certificate available for rollback.",
    ].join("\n"));
    const [hit] = await searchStores(stores, "proxy certificate timeout", ["local"]);
    assert.match(hit.line, /Proxy connection failed/);
    assert.match(hit.line, /certificate rotation fixes the timeout/);
    assert.doesNotMatch(hit.line, /proxy was inspected|historical logging/i);
    assert.ok(hit.line.length <= 288, hit.line);
  });
});

test("passage selection finds matches deep inside a single long line", async () => {
  await withStores(async (stores) => {
    await note(stores.local, "long.md", `${"unrelated padding ".repeat(100)}Use containerd for the control plane.${" trailing information".repeat(100)}`);
    const [hit] = await searchStores(stores, "containerd control plane", ["local"]);
    assert.match(hit.line, /containerd for the control plane/);
    assert.ok(hit.line.length <= 288);
  });
});

test("description relevance is not diluted by a long note body", async () => {
  await withStores(async (stores) => {
    await note(stores.local, "runbook.md", frontmatter("PostgreSQL backup runbook", "1234abcd",
      "Retention schedules and operational context. ".repeat(400)));
    await note(stores.local, "mention.md", frontmatter("Weekly journal", "1234abce",
      "We discussed the PostgreSQL backup runbook yesterday."));
    const hits = await searchStores(stores, "postgresql backup", ["local"]);
    assert.equal(hits[0].file, "notes/runbook.md");
    assert.equal(hits[0].line, "PostgreSQL backup runbook");
  });
});

test("dangling legacy references remain searchable without exposing filenames or traversing paths", async () => {
  await withStores(async (stores) => {
    await writeFile(stores.local.memoryFile, [
      "<!-- old [abcdef12] -->",
      "#note [[notes/missingcanary.md]] Proxy deployment guide",
      "#note [[notes/../private.md]] Unrelated broken reference",
    ].join("\n"));
    await writeFile(join(stores.local.dir, "private.md"), "Private storagecanary outside notes");
    const hits = await searchStores(stores, "proxy", ["local"]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, "MEMORY.md");
    assert.equal(hits[0].line, "Proxy deployment guide");
    assert.equal(hits[0].id, "abcdef12");
    assert.deepEqual(await searchStores(stores, "missingcanary storagecanary", ["local"]), []);
  });
});

test("equal scores have deterministic file/scope ordering independent of caller scope order", async () => {
  await withStores(async (stores) => {
    for (const scope of ["local", "global"] as const) {
      await note(stores[scope], "z.md", "Docker deployment guide");
      await note(stores[scope], "a.md", "Docker deployment guide");
    }
    const first = await searchStores(stores, "docker", ["local", "global"]);
    const second = await searchStores(stores, "docker", ["global", "local"]);
    assert.deepEqual(first, second);
    assert.deepEqual(first.map((h) => `${h.scope}:${h.file}`), [
      "global:notes/a.md", "global:notes/z.md", "local:notes/a.md", "local:notes/z.md",
    ]);
    assert.deepEqual(await searchStores(stores, "docker", ["local", "global"], 2), first.slice(0, 2));
    assert.deepEqual(await searchStores(stores, "docker", ["local", "local"]),
      await searchStores(stores, "docker", ["local"]));
    assert.deepEqual(await searchStores(stores, "docker", ["local"], 0), []);
    assert.deepEqual(await searchStores(stores, "docker", ["local"], -1), []);
    assert.deepEqual(await searchStores(stores, "the and of", ["local"]), []);
    assert.deepEqual(await searchStores(stores, "", ["local"]), []);
  });
});
