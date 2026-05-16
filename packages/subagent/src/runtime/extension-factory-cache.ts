import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { timingMark, timingStart } from "./timing.js";

export type ExtensionFactoryImport = (path: string) => Promise<ExtensionFactory | undefined>;

export interface ExtensionFactoryCacheOptions {
  importFactory?: ExtensionFactoryImport;
  bypass?: boolean;
}

export interface ExtensionFactoryLoad {
  factories: ExtensionFactory[];
  fallbackPaths: string[];
}

const EXTENSION_FILE_EXTS = new Set([".ts", ".js"]);

interface CachedFactoryEntry {
  kind: "factory";
  mtimeMs: number;
  size: number;
  factory: ExtensionFactory;
}

interface CachedFallbackEntry {
  kind: "fallback";
  mtimeMs: number;
  size: number;
}

type CachedEntry = CachedFactoryEntry | CachedFallbackEntry;

export class ExtensionFactoryCache {
  private readonly importFactory: ExtensionFactoryImport;
  private readonly entries = new Map<string, CachedEntry>();
  private readonly bypass: boolean;

  constructor(options: ExtensionFactoryCacheOptions = {}) {
    this.importFactory = options.importFactory ?? defaultImportFactory;
    this.bypass = options.bypass ?? false;
  }

  async load(cwd: string, agentDir: string): Promise<ExtensionFactoryLoad> {
    const roots = [path.join(agentDir, "extensions"), path.join(cwd, ".pi", "extensions")];
    const seen = new Set<string>();
    const paths: string[] = [];
    const endDiscover = timingStart("extensionFactoryCache.discover", { cwd, agentDir });
    for (const root of roots) {
      for (const entry of await discoverEntries(root)) {
        if (seen.has(entry)) continue;
        seen.add(entry);
        paths.push(entry);
      }
    }
    endDiscover({ count: paths.length });

    const factories: ExtensionFactory[] = [];
    const fallbackPaths: string[] = [];
    if (this.bypass) {
      for (const entry of paths) timingMark("extensionFactoryCache.fallbackOnBypass", { path: entry });
      return { factories, fallbackPaths: paths };
    }
    for (const entry of paths) {
      const meta = await statMeta(entry);
      if (!meta) continue;
      const cached = this.entries.get(entry);
      if (cached && cached.mtimeMs === meta.mtimeMs && cached.size === meta.size) {
        timingMark("extensionFactoryCache.hit", { path: entry, kind: cached.kind });
        if (cached.kind === "factory") factories.push(cached.factory);
        else fallbackPaths.push(entry);
        continue;
      }
      if (cached) timingMark("extensionFactoryCache.invalidate", { path: entry });
      timingMark("extensionFactoryCache.miss", { path: entry });
      const endImport = timingStart("extensionFactoryCache.import", { path: entry });
      let factory: ExtensionFactory | undefined;
      let failureReason: "threw" | "noFactory" | undefined;
      try {
        factory = await this.importFactory(entry);
        endImport({ ok: true, hasFactory: factory !== undefined });
        if (!factory) failureReason = "noFactory";
      } catch (error) {
        failureReason = "threw";
        endImport({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      if (factory) {
        this.entries.set(entry, { kind: "factory", ...meta, factory });
        factories.push(factory);
      } else {
        timingMark("extensionFactoryCache.fallbackOnError", { path: entry, reason: failureReason });
        this.entries.set(entry, { kind: "fallback", ...meta });
        fallbackPaths.push(entry);
      }
    }
    return { factories, fallbackPaths };
  }

  clear(): void {
    this.entries.clear();
  }
}

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  fsCache: false,
});

const defaultImportFactory: ExtensionFactoryImport = async (file: string) => {
  const mod = await jiti.import<unknown>(file, { default: true });
  if (typeof mod === "function") return mod as ExtensionFactory;
  return undefined;
};

async function statMeta(file: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const info = await stat(file);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return undefined;
  }
}

async function discoverEntries(root: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
    const full = path.join(root, dirent.name);
    if (dirent.isFile() && EXTENSION_FILE_EXTS.has(path.extname(dirent.name))) {
      results.push(full);
      continue;
    }
    if (dirent.isDirectory()) {
      const manifestEntries = await readManifestEntries(full);
      if (manifestEntries.length > 0) {
        results.push(...manifestEntries);
        continue;
      }
      const indexEntry = await findIndexEntry(full);
      if (indexEntry) results.push(indexEntry);
    }
  }
  return results;
}

async function readManifestEntries(dir: string): Promise<string[]> {
  try {
    const raw = await readFile(path.join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { pi?: { extensions?: unknown } };
    const list = parsed.pi?.extensions;
    if (!Array.isArray(list)) return [];
    const resolved: string[] = [];
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      const candidate = path.resolve(dir, entry);
      try {
        const info = await stat(candidate);
        if (info.isFile()) resolved.push(candidate);
      } catch {}
    }
    return resolved;
  } catch {
    return [];
  }
}

async function findIndexEntry(dir: string): Promise<string | undefined> {
  for (const name of ["index.ts", "index.js"]) {
    const candidate = path.join(dir, name);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {}
  }
  return undefined;
}
