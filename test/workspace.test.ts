import { strict as assert } from "node:assert";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { readMemoryText, resolveStores, type Scope, type StorePaths } from "../store.ts";
import { initializationError, initializeMemory, resolveWorkspaceStores, workspaceAccessError } from "../workspace.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-remember-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const globalDir = join(root, "global");
  const resolved = resolveWorkspaceStores(root, globalDir, ".pi");
  assert.equal(resolved.status, "resolved");
  return { root, globalDir, stores: resolved.stores, local: resolved.stores.local };
}

function assertError(result: { status: string; message?: string }, pattern?: RegExp) {
  assert.equal(result.status, "error");
  assert.ok(result.message);
  if (pattern) assert.match(result.message, pattern);
}

async function assertAbsent(path: string) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}

async function assertOnlyIndex(store: StorePaths) {
  assert.deepEqual(await readdir(store.dir), ["MEMORY.md"]);
  await assertAbsent(store.notesDir);
  await assertAbsent(store.recoveryDir);
}

function initializationRoot(stores: Record<Scope, StorePaths>): string {
  const message = initializationError(stores, ["global", "local"]);
  assert.ok(message);
  assert.match(message, /Local memory is not initialized/);
  assert.ok(message.includes(JSON.stringify(stores.local.memoryFile)));
  const call = message.match(/memory_init\((\{root:.*\})\)/);
  assert.ok(call, "error includes a directly usable initialization call");
  // The root must be a JSON-escaped string, including quotes and backslashes.
  return JSON.parse(call[1].slice("{root:".length, -1));
}

test("workspace: default root is cwd, stores stay unchanged and resolution is read-only", async (t) => {
  const { root, globalDir, stores } = await fixture(t);
  const result = resolveWorkspaceStores(root, globalDir, ".pi");
  assert.equal(result.status, "resolved");
  assert.equal(result.root, realpathSync(root));
  assert.deepEqual(result.stores, resolveStores(realpathSync(root), globalDir, ".pi"));
  assert.deepEqual(result.stores, stores);
  assert.deepEqual(await readdir(root), []);
});

test("workspace: relative roots are based on cwd, absolute roots ignore cwd", async (t) => {
  const { root, globalDir } = await fixture(t);
  const cwd = join(root, "working");
  const target = join(root, "elsewhere");
  await mkdir(cwd);
  await mkdir(target);
  for (const input of ["../elsewhere", target, "../working/../elsewhere/."]) {
    const result = resolveWorkspaceStores(cwd, globalDir, ".custom", input);
    assert.equal(result.status, "resolved");
    assert.equal(result.root, realpathSync(target));
    assert.equal(result.stores.local.dir, join(realpathSync(target), ".custom", "memory"));
    assert.deepEqual(result.stores.global, resolveStores(cwd, globalDir, ".pi").global);
  }
  assert.deepEqual(await readdir(target), []);
});

test("workspace: relative cwd works as default without being joined to itself", async (t) => {
  const { root, globalDir } = await fixture(t);
  const result = resolveWorkspaceStores(relative(process.cwd(), root), globalDir, ".pi");
  assert.equal(result.status, "resolved");
  assert.equal(result.root, realpathSync(root));
});

test("workspace: expands ~ and ~/ without changing the global store", async (t) => {
  const { root } = await fixture(t);
  const globalDir = "~/global-must-remain-unexpanded";
  for (const input of ["~", "~/", `~/${relative(homedir(), root)}`]) {
    const result = resolveWorkspaceStores(root, globalDir, ".pi", input);
    assert.equal(result.status, "resolved");
    assert.equal(result.root, realpathSync(input === "~" || input === "~/" ? homedir() : root));
    assert.deepEqual(result.stores.global, resolveStores(root, globalDir, ".pi").global);
  }
  assert.deepEqual(await readdir(root), []);
});

test("workspace: symlink and real roots yield identical path-keyed mutation stores", async (t) => {
  const { root, globalDir } = await fixture(t);
  const target = join(root, "target");
  const alias = join(root, "alias");
  await mkdir(target);
  await symlink(target, alias, "dir");
  const direct = resolveWorkspaceStores(root, globalDir, ".pi", target);
  const linked = resolveWorkspaceStores(alias, globalDir, ".pi");
  const explicit = resolveWorkspaceStores(root, globalDir, ".pi", "alias");
  assert.equal(direct.status, "resolved");
  assert.deepEqual(linked, direct);
  assert.deepEqual(explicit, direct);
  assert.equal(initializationRoot(direct.stores), realpathSync(target));
  assert.equal(initializationRoot(linked.status === "resolved" ? linked.stores : direct.stores), realpathSync(target));
});

test("workspace: missing, file, and dangling symlink roots fail without creation", async (t) => {
  const { root, globalDir } = await fixture(t);
  const missing = join(root, "missing", "nested");
  const file = join(root, "file");
  const dangling = join(root, "dangling");
  await writeFile(file, "original bytes\r\n");
  await symlink(missing, dangling, "dir");
  for (const input of [missing, file, join(file, "child"), dangling]) {
    assertError(resolveWorkspaceStores(root, globalDir, ".pi", input), /root|directory/i);
  }
  assert.equal(await readFile(file, "utf8"), "original bytes\r\n");
  await assertAbsent(join(root, "missing"));
  assert.deepEqual((await readdir(root)).sort(), ["dangling", "file"]);
});

for (const input of ["", " ", "\t\n", "bad\0root", "~username", "~username/project", "~invalid/"]) {
  test(`workspace: rejects invalid root ${JSON.stringify(input)} without side effects`, async (t) => {
    const { root, globalDir } = await fixture(t);
    assertError(resolveWorkspaceStores(root, globalDir, ".pi", input), /blank|NUL|~username/);
    assert.deepEqual(await readdir(root), []);
  });
}

test("workspace: invalid default cwd is also rejected and never created", async (t) => {
  const { root, globalDir } = await fixture(t);
  for (const cwd of ["", " ", "bad\0cwd", join(root, "missing")]) {
    assertError(resolveWorkspaceStores(cwd, globalDir, ".pi"));
  }
  assert.deepEqual(await readdir(root), []);
});

test("workspace: initialization guard ignores missing global memory and empty scopes", async (t) => {
  const { root, stores, local } = await fixture(t);
  const globalOnly: readonly Scope[] = ["global"];
  assert.equal(initializationError(stores, globalOnly), null);
  assert.equal(initializationError(stores, []), null);
  assert.equal(initializationRoot(stores), realpathSync(root));
  assert.ok(initializationError(stores, ["local"]));
  // Existing low-level injection semantics are unchanged.
  assert.equal(await readMemoryText(local), "");
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await initializeMemory(local), { status: "initialized" });
  assert.equal(initializationError(stores, ["local"]), null);
  assert.equal(initializationError(stores, ["global", "local"]), null);
  await assertAbsent(stores.global.dir);
});

test("workspace: guard supplies the exact canonical, escaped root with nested config directories", async (t) => {
  const { root, globalDir } = await fixture(t);
  const target = join(root, 'workspace "quoted" \\ name');
  const alias = join(root, "alias");
  await mkdir(target);
  await symlink(target, alias, "dir");
  const result = resolveWorkspaceStores(root, globalDir, join("nested", ".config"), alias);
  assert.equal(result.status, "resolved");
  assert.equal(initializationRoot(result.stores), realpathSync(target));
  assert.deepEqual(await readdir(target), []);
});

test("workspace: guard supports ordinary StorePaths from resolveStores", async (t) => {
  const { root, globalDir } = await fixture(t);
  assert.equal(initializationRoot(resolveStores(root, globalDir, ".pi")), root);
});

test("workspace: an index directory is neither initialized nor replaced", async (t) => {
  const { stores, local } = await fixture(t);
  await mkdir(local.memoryFile, { recursive: true });
  await writeFile(join(local.memoryFile, "keep"), "untouched");
  assert.match(initializationError(stores, ["local"])!, /regular file/);
  assertError(await initializeMemory(local), /regular file/);
  assert.equal(await readFile(join(local.memoryFile, "keep"), "utf8"), "untouched");
  await assertOnlyIndex(local);
});

test("workspace: init creates only an empty index, is idempotent, and preserves arbitrary bytes", async (t) => {
  const { root, local } = await fixture(t);
  assert.deepEqual(await initializeMemory(local), { status: "initialized" });
  assert.equal((await readFile(local.memoryFile)).length, 0);
  assert.deepEqual(await initializeMemory(local), { status: "existing" });
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xff, 0x00]);
  await writeFile(local.memoryFile, bytes);
  const before = await lstat(local.memoryFile);
  assert.deepEqual(await initializeMemory(local), { status: "existing" });
  assert.deepEqual(await readFile(local.memoryFile), bytes);
  const after = await lstat(local.memoryFile);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  await assertOnlyIndex(local);
  assert.deepEqual(await readdir(root), [".pi"]);
});

test("workspace: concurrent initialization has one creator and never overwrites existing bytes", async (t) => {
  const { local } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 32 }, () => initializeMemory(local)));
  assert.equal(results.filter((result) => result.status === "initialized").length, 1);
  assert.equal(results.filter((result) => result.status === "existing").length, 31);
  assert.equal(await readFile(local.memoryFile, "utf8"), "");
  const bytes = Buffer.from("<!-- manual -->\r\nKeep exactly\r\n\n");
  await writeFile(local.memoryFile, bytes);
  const repeated = await Promise.all(Array.from({ length: 32 }, () => initializeMemory(local)));
  assert.ok(repeated.every((result) => result.status === "existing"));
  assert.deepEqual(await readFile(local.memoryFile), bytes);
  await assertOnlyIndex(local);
});

test("workspace: symlink to a regular index is initialized already and retains link and target", async (t) => {
  const { root, stores, local } = await fixture(t);
  const target = join(root, "external-index");
  const bytes = Buffer.from("Manual target\r\n\0");
  await writeFile(target, bytes);
  await mkdir(local.dir, { recursive: true });
  await symlink(target, local.memoryFile);
  assert.equal(initializationError(stores, ["local", "global"]), null);
  assert.deepEqual(await initializeMemory(local), { status: "existing" });
  assert.equal(await readlink(local.memoryFile), target);
  assert.deepEqual(await readFile(target), bytes);
  await assertOnlyIndex(local);
});

for (const kind of ["dangling", "directory", "loop"] as const) {
  test(`workspace: ${kind} index symlinks are errors, never overwritten or followed for creation`, async (t) => {
    const { root, stores, local } = await fixture(t);
    const target = kind === "loop" ? local.memoryFile : join(root, "target");
    if (kind === "directory") await mkdir(target);
    await mkdir(local.dir, { recursive: true });
    await symlink(target, local.memoryFile);
    assert.ok(initializationError(stores, ["global", "local"]));
    assertError(await initializeMemory(local));
    assert.equal(await readlink(local.memoryFile), target);
    if (kind === "dangling") await assertAbsent(target);
    if (kind === "directory") assert.deepEqual(await readdir(target), []);
    await assertOnlyIndex(local);
  });
}

test("workspace: blocked memory directory reports filesystem failure without overwriting", async (t) => {
  const { local, stores } = await fixture(t);
  await mkdir(resolve(local.dir, ".."), { recursive: true });
  await writeFile(local.dir, "directory blocker");
  assert.match(initializationError(stores, ["local"])!, /ENOTDIR/);
  assertError(await initializeMemory(local), /ENOTDIR/);
  assert.equal(await readFile(local.dir, "utf8"), "directory blocker");
});

test("workspace: permissions failures are reported, not treated as missing or successful", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root bypasses Unix permission checks");
  const { root, globalDir, stores, local } = await fixture(t);
  await mkdir(local.dir, { recursive: true });
  await chmod(local.dir, 0o000);
  try {
    assert.match(initializationError(stores, ["local"])!, /EACCES/);
    assertError(await initializeMemory(local), /EACCES/);
  } finally {
    await chmod(local.dir, 0o700);
  }
  assert.deepEqual(await readdir(local.dir), []);
  const inaccessible = join(root, "inaccessible");
  await mkdir(join(inaccessible, "child"), { recursive: true });
  await chmod(inaccessible, 0o000);
  try {
    assertError(resolveWorkspaceStores(root, globalDir, ".pi", join(inaccessible, "child")), /EACCES/);
  } finally {
    await chmod(inaccessible, 0o700);
  }
});

test("workspace: access guard checks initialization by default and supplies initialization guidance", async (t) => {
  const { root, stores, local } = await fixture(t);
  const scopes: readonly Scope[] = ["global", "local"];
  const message = workspaceAccessError(stores, scopes);
  assert.equal(message, initializationError(stores, scopes));
  assert.ok(message?.includes(JSON.stringify(local.memoryFile)));
  assert.ok(message?.includes(`memory_init({root:${JSON.stringify(realpathSync(root))}})`));
  assert.equal(workspaceAccessError(stores, scopes, false), null);
  assert.equal(workspaceAccessError(stores, ["global"]), null);
  assert.equal(workspaceAccessError(stores, []), null);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(await initializeMemory(local), { status: "initialized" });
  assert.equal(workspaceAccessError(stores, scopes), null);
  await rm(local.memoryFile);
  assert.equal(workspaceAccessError(stores, scopes), message);
  assert.equal(workspaceAccessError(stores, scopes, false), null);
});

for (const initialized of [false, true]) {
  for (const change of ["removed", "renamed"] as const) {
    test(`workspace: ${initialized ? "initialized" : "uninitialized"} root ${change} after resolution is not recreated`, async (t) => {
      const { root, globalDir } = await fixture(t);
      const workspace = join(root, "workspace");
      const moved = join(root, "moved");
      await mkdir(workspace);
      const resolved = resolveWorkspaceStores(root, globalDir, ".pi", workspace);
      assert.equal(resolved.status, "resolved");
      const { stores } = resolved;
      if (initialized) {
        assert.deepEqual(await initializeMemory(stores.local), { status: "initialized" });
        await writeFile(stores.local.memoryFile, "preserve me\r\n");
      }
      assert.equal(workspaceAccessError(stores, ["local"], initialized), null);
      if (change === "removed") await rm(workspace, { recursive: true });
      else await rename(workspace, moved);
      for (const requireInitialized of [false, true]) {
        assert.match(workspaceAccessError(stores, ["local"], requireInitialized)!, /workspace root/i);
        assert.match(workspaceAccessError(stores, ["global", "local"], requireInitialized)!, /workspace root/i);
      }
      assertError(await initializeMemory(stores.local), /workspace root/i);
      await assertAbsent(workspace);
      if (change === "renamed") {
        if (initialized) assert.equal(await readFile(join(moved, ".pi", "memory", "MEMORY.md"), "utf8"), "preserve me\r\n");
        else assert.deepEqual(await readdir(moved), []);
      }
      // Global-only access must not inspect the stale local root or its index.
      assert.equal(workspaceAccessError(stores, ["global"]), null);
      assert.equal(workspaceAccessError(stores, []), null);
      assert.deepEqual(await initializeMemory(stores.global), { status: "initialized" });
      await assertAbsent(workspace);
    });
  }
}

for (const initialized of [false, true]) {
  test(`workspace: canonical root replaced by symlink to ${initialized ? "initialized" : "empty"} workspace is rejected`, async (t) => {
    const { root, globalDir } = await fixture(t);
    const workspace = join(root, "workspace");
    const moved = join(root, "moved");
    const elsewhere = join(root, "elsewhere");
    await mkdir(workspace);
    await mkdir(elsewhere);
    const resolved = resolveWorkspaceStores(root, globalDir, ".pi", workspace);
    assert.equal(resolved.status, "resolved");
    if (initialized) {
      assert.deepEqual(await initializeMemory(resolved.stores.local), { status: "initialized" });
      const target = resolveWorkspaceStores(root, globalDir, ".pi", elsewhere);
      assert.equal(target.status, "resolved");
      assert.deepEqual(await initializeMemory(target.stores.local), { status: "initialized" });
      await writeFile(target.stores.local.memoryFile, "do not touch\r\n");
    }
    await rename(workspace, moved);
    await symlink(elsewhere, workspace, "dir");
    assert.match(workspaceAccessError(resolved.stores, ["local"])!, /root changed|replacement/i);
    assert.match(workspaceAccessError(resolved.stores, ["local"], false)!, /root changed|replacement/i);
    assertError(await initializeMemory(resolved.stores.local), /root changed|replacement/i);
    assert.equal(await readlink(workspace), elsewhere);
    if (initialized) assert.equal(await readFile(join(elsewhere, ".pi", "memory", "MEMORY.md"), "utf8"), "do not touch\r\n");
    else assert.deepEqual(await readdir(elsewhere), []);
    assert.equal(workspaceAccessError(resolved.stores, ["global"]), null);
  });
}

test("workspace: access and initialization reject a canonical root replaced by a file", async (t) => {
  const { root, globalDir } = await fixture(t);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const resolved = resolveWorkspaceStores(root, globalDir, ".pi", workspace);
  assert.equal(resolved.status, "resolved");
  await rm(workspace, { recursive: true });
  await writeFile(workspace, "not a directory");
  assert.match(workspaceAccessError(resolved.stores, ["local"], false)!, /not a directory/i);
  assertError(await initializeMemory(resolved.stores.local), /not a directory/i);
  assert.equal(await readFile(workspace, "utf8"), "not a directory");
});

test("workspace: access and initialization use the ordinary StorePaths root fallback", async (t) => {
  const { root, globalDir } = await fixture(t);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const stores = resolveStores(workspace, globalDir, ".pi");
  assert.equal(workspaceAccessError(stores, ["local"], false), null);
  assert.equal(workspaceAccessError(stores, ["local"]), initializationError(stores, ["local"]));
  assert.deepEqual(await initializeMemory(stores.local), { status: "initialized" });
  await rm(workspace, { recursive: true });
  assert.match(workspaceAccessError(stores, ["local"], false)!, /workspace root/i);
  assertError(await initializeMemory(stores.local), /workspace root/i);
  await assertAbsent(workspace);
});

test("workspace: nested config initialization creates each missing component and accepts existing directories", async (t) => {
  const { root, globalDir } = await fixture(t);
  const target = join(root, "workspace");
  await mkdir(target);
  await mkdir(join(target, "nested"));
  const resolved = resolveWorkspaceStores(root, globalDir, join("nested", "deeper", ".config"), target);
  assert.equal(resolved.status, "resolved");
  assert.equal(workspaceAccessError(resolved.stores, ["local"]), initializationError(resolved.stores, ["local"]));
  assert.ok(workspaceAccessError(resolved.stores, ["local"])?.includes(`memory_init({root:${JSON.stringify(realpathSync(target))}})`));
  const results = await Promise.all(Array.from({ length: 8 }, () => initializeMemory(resolved.stores.local)));
  assert.equal(results.filter((result) => result.status === "initialized").length, 1);
  assert.equal(results.filter((result) => result.status === "existing").length, 7);
  assert.equal(workspaceAccessError(resolved.stores, ["local"]), null);
  assert.equal(await readFile(resolved.stores.local.memoryFile, "utf8"), "");
  await assertOnlyIndex(resolved.stores.local);
  assert.deepEqual(await readdir(target), ["nested"]);
  assert.deepEqual(await readdir(join(target, "nested")), ["deeper"]);
  assert.deepEqual(await readdir(join(target, "nested", "deeper")), [".config"]);
});

test("workspace: global initialization needs no local index and creates no ancillary directories", async (t) => {
  const { stores, local } = await fixture(t);
  assert.deepEqual(await initializeMemory(stores.global), { status: "initialized" });
  assert.deepEqual(await initializeMemory(stores.global), { status: "existing" });
  assert.equal(initializationError(stores, ["global"]), null);
  assert.ok(initializationError(stores, ["global", "local"]));
  await assertOnlyIndex(stores.global);
  await assertAbsent(local.dir);
});
