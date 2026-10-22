import { realpathSync, statSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveStores, type Scope, type StorePaths } from "./store.ts";

type WorkspaceResult =
  | { status: "resolved"; root: string; stores: Record<Scope, StorePaths> }
  | { status: "error"; message: string };

type InitializationResult =
  | { status: "initialized" | "existing" }
  | { status: "error"; message: string };

// StorePaths intentionally has no workspace field. Retain the exact root even
// for nested configDirName values without changing that shared store contract.
const workspaceRoots = new WeakMap<StorePaths, string>();

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
}

/** Resolve only existing workspaces; resolution itself never creates anything. */
export function resolveWorkspaceStores(
  cwd: string,
  globalDir: string,
  configDirName: string,
  root?: string,
): WorkspaceResult {
  const input = root ?? cwd;
  if (!input.trim()) return { status: "error", message: "Workspace root must not be blank." };
  if (input.includes("\0")) return { status: "error", message: "Workspace root must not contain NUL characters." };
  if (input.startsWith("~") && input !== "~" && !input.startsWith("~/")) {
    return { status: "error", message: "Unsupported workspace root: use ~ or ~/path, not ~username." };
  }
  const expanded = input === "~" ? homedir() : input.startsWith("~/")
    ? join(homedir(), input.slice(2)) : input;
  const candidate = root === undefined ? resolve(cwd) : resolve(cwd, expanded);
  try {
    const canonicalRoot = realpathSync(candidate);
    if (!statSync(canonicalRoot).isDirectory()) {
      return { status: "error", message: `Workspace root is not a directory: ${JSON.stringify(candidate)}.` };
    }
    const stores = resolveStores(canonicalRoot, globalDir, configDirName);
    workspaceRoots.set(stores.local, canonicalRoot);
    return { status: "resolved", root: canonicalRoot, stores };
  } catch (error) {
    return { status: "error", message: `Cannot resolve workspace root ${JSON.stringify(candidate)}: ${String(error)}` };
  }
}

function workspaceRoot(store: StorePaths): string {
  return workspaceRoots.get(store) ?? dirname(dirname(store.dir));
}

function canonicalRootError(store: StorePaths): string | null {
  const root = workspaceRoot(store);
  try {
    if (realpathSync(root) !== resolve(root)) {
      return `Workspace root changed since resolution: ${JSON.stringify(root)}. Refusing to follow its replacement.`;
    }
    if (!statSync(root).isDirectory()) {
      return `Workspace root is not a directory: ${JSON.stringify(root)}.`;
    }
    return null;
  } catch (error) {
    return `Cannot access workspace root ${JSON.stringify(root)}: ${String(error)}`;
  }
}

/** Recheck after queue waits, before any local memory access or mutation. */
export function workspaceAccessError(
  stores: Record<Scope, StorePaths>,
  scopes: readonly Scope[],
  requireInitialized = true,
): string | null {
  if (!scopes.includes("local")) return null;
  return canonicalRootError(stores.local) ??
    (requireInitialized ? initializationError(stores, scopes) : null);
}

/** Tool-boundary guard only: low-level reads may still treat missing memory as empty. */
export function initializationError(
  stores: Record<Scope, StorePaths>,
  scopes: readonly Scope[],
): string | null {
  if (!scopes.includes("local")) return null;
  const store = stores.local;
  const root = workspaceRoot(store);
  const guidance = `Local memory is not initialized at ${JSON.stringify(store.memoryFile)}. ` +
    `Run memory_init({root:${JSON.stringify(root)}}).`;
  try {
    return statSync(store.memoryFile).isFile() ? null : guidance + " MEMORY.md must be a regular file.";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return guidance;
    return `${guidance} Cannot inspect MEMORY.md: ${String(error)}`;
  }
}

/** Exclusively create an empty index; never truncate or replace an existing entry. */
export async function initializeMemory(store: StorePaths): Promise<InitializationResult> {
  try {
    const rootError = store.scope === "local" ? canonicalRootError(store) : null;
    if (rootError) return { status: "error", message: rootError };
    try {
      if ((await stat(store.memoryFile)).isFile()) {
        const error = store.scope === "local" ? canonicalRootError(store) : null;
        return error ? { status: "error", message: error } : { status: "existing" };
      }
      return { status: "error", message: `Memory index is not a regular file: ${JSON.stringify(store.memoryFile)}.` };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (store.scope === "global") {
      await mkdir(store.dir, { recursive: true });
    } else {
      const root = workspaceRoot(store);
      const belowRoot = relative(root, store.dir);
      if (!belowRoot || isAbsolute(belowRoot) || belowRoot.split(sep).includes("..")) {
        return { status: "error", message: `Memory directory must be below workspace root: ${JSON.stringify(store.dir)}.` };
      }
      // Never use recursive mkdir locally: it could recreate a vanished root.
      // Create only the config/memory components, leaving notes/recovery lazy.
      let directory = root;
      for (const component of belowRoot.split(sep)) {
        const error = canonicalRootError(store);
        if (error) return { status: "error", message: error };
        directory = join(directory, component);
        try {
          await mkdir(directory);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          if (!(await stat(directory)).isDirectory()) {
            return { status: "error", message: `Memory path is not a directory: ${JSON.stringify(directory)}.` };
          }
        }
      }
      const error = canonicalRootError(store);
      if (error) return { status: "error", message: error };
    }
    try {
      await writeFile(store.memoryFile, "", { flag: "wx" });
      return { status: "initialized" };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      // A concurrent initializer may have won. stat follows symlinks, but a
      // dangling link or a directory must not count as an initialized index.
      if ((await stat(store.memoryFile)).isFile()) {
        const error = store.scope === "local" ? canonicalRootError(store) : null;
        return error ? { status: "error", message: error } : { status: "existing" };
      }
      return { status: "error", message: `Memory index is not a regular file: ${JSON.stringify(store.memoryFile)}.` };
    }
  } catch (error) {
    return { status: "error", message: `Cannot initialize memory at ${JSON.stringify(store.memoryFile)}: ${String(error)}` };
  }
}
