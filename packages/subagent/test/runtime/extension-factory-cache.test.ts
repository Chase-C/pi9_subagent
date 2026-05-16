import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExtensionFactoryCache } from "../../src/runtime/extension-factory-cache.js";

const SAVED_TIMING = process.env.PI_SUBAGENT_DEBUG_TIMING;
const SAVED_TIMING_FILE = process.env.PI_SUBAGENT_DEBUG_TIMING_FILE;

afterEach(() => {
  if (SAVED_TIMING === undefined) delete process.env.PI_SUBAGENT_DEBUG_TIMING;
  else process.env.PI_SUBAGENT_DEBUG_TIMING = SAVED_TIMING;
  if (SAVED_TIMING_FILE === undefined) delete process.env.PI_SUBAGENT_DEBUG_TIMING_FILE;
  else process.env.PI_SUBAGENT_DEBUG_TIMING_FILE = SAVED_TIMING_FILE;
});

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "ext-cache-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  return { root, agentDir, cwd };
}

test("emits timing instrumentation events when PI_SUBAGENT_DEBUG_TIMING is enabled", async () => {
  const { root, agentDir, cwd } = await makeWorkspace();
  const logFile = join(root, "timing.log");
  process.env.PI_SUBAGENT_DEBUG_TIMING = "1";
  process.env.PI_SUBAGENT_DEBUG_TIMING_FILE = logFile;

  const okEntry = join(agentDir, "extensions", "ok.ts");
  const badEntry = join(agentDir, "extensions", "bad.ts");
  await writeFile(okEntry, "export default () => {};");
  await writeFile(badEntry, "export default () => {};");

  let calls = 0;
  const cache = new ExtensionFactoryCache({
    importFactory: async (p: string) => {
      calls += 1;
      if (p === badEntry) throw new Error("boom");
      return () => {};
    },
  });
  await cache.load(cwd, agentDir);  // discovery + miss + import + fallback-on-error
  await cache.load(cwd, agentDir);  // hit + sticky fallback

  await writeFile(okEntry, "export default () => { /* v2 */ };");
  await utimes(okEntry, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  await cache.load(cwd, agentDir);  // invalidation + re-import

  const bypassCache = new ExtensionFactoryCache({ bypass: true });
  await bypassCache.load(cwd, agentDir);  // fallback-on-bypass

  const log = await readFile(logFile, "utf8");
  const expected = [
    "extensionFactoryCache.discover",
    "extensionFactoryCache.import",
    "extensionFactoryCache.hit",
    "extensionFactoryCache.miss",
    "extensionFactoryCache.fallbackOnError",
    "extensionFactoryCache.fallbackOnBypass",
    "extensionFactoryCache.invalidate",
  ];
  for (const event of expected) {
    assert.match(log, new RegExp(`event=${event}\\b`), `missing event ${event}`);
  }
  void calls;
  await rm(logFile, { force: true });
});

test("default importer loads real TS extension files and returns a fresh factory after the file changes", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "real.ts");
  await writeFile(entry, "export default (pi: any) => { pi.tag = 'v1'; };");

  const cache = new ExtensionFactoryCache();

  const first = await cache.load(cwd, agentDir);
  assert.equal(first.fallbackPaths.length, 0, "default importer should successfully import TS files");
  assert.equal(first.factories.length, 1);
  const probe1: any = {};
  await first.factories[0](probe1);
  assert.equal(probe1.tag, "v1");

  await writeFile(entry, "export default (pi: any) => { pi.tag = 'v2-updated'; };");
  await utimes(entry, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

  const second = await cache.load(cwd, agentDir);
  assert.equal(second.factories.length, 1);
  const probe2: any = {};
  await second.factories[0](probe2);
  assert.equal(probe2.tag, "v2-updated", "must not return stale module");
});

test("bypass mode routes every discovered path to fallback without invoking the importer", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const tsEntry = join(agentDir, "extensions", "alpha.ts");
  const jsEntry = join(cwd, ".pi", "extensions", "beta.js");
  await writeFile(tsEntry, "export default () => {};");
  await writeFile(jsEntry, "export default () => {};");

  let calls = 0;
  const cache = new ExtensionFactoryCache({
    bypass: true,
    importFactory: async () => { calls += 1; return () => {}; },
  });

  const result = await cache.load(cwd, agentDir);

  assert.equal(calls, 0);
  assert.deepEqual(result.factories, []);
  assert.deepEqual([...result.fallbackPaths].sort(), [tsEntry, jsEntry].sort());
});

test("emits fallback path when importer throws", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "broken.ts");
  await writeFile(entry, "export default () => {};");

  const cache = new ExtensionFactoryCache({
    importFactory: async () => { throw new Error("jiti exploded"); },
  });

  const result = await cache.load(cwd, agentDir);

  assert.deepEqual(result.factories, []);
  assert.deepEqual(result.fallbackPaths, [entry]);
});

test("emits fallback path when importer returns undefined", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "no-default.ts");
  await writeFile(entry, "// no default export");

  const cache = new ExtensionFactoryCache({
    importFactory: async () => undefined,
  });

  const result = await cache.load(cwd, agentDir);

  assert.deepEqual(result.factories, []);
  assert.deepEqual(result.fallbackPaths, [entry]);
});

test("fallback decision is sticky until file mtime or size changes", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "flaky.ts");
  await writeFile(entry, "export default () => {};");

  let calls = 0;
  const factory = () => {};
  const cache = new ExtensionFactoryCache({
    importFactory: async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return factory;
    },
  });

  const first = await cache.load(cwd, agentDir);
  assert.deepEqual(first.fallbackPaths, [entry]);

  const second = await cache.load(cwd, agentDir);
  assert.equal(calls, 1, "importer should not be retried while sticky");
  assert.deepEqual(second.fallbackPaths, [entry]);
  assert.deepEqual(second.factories, []);

  await writeFile(entry, "export default () => { /* fixed */ };");
  await utimes(entry, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

  const third = await cache.load(cwd, agentDir);
  assert.equal(calls, 2);
  assert.deepEqual(third.fallbackPaths, []);
  assert.equal(third.factories.length, 1);
});

test("reimports factory when file mtime or size changes", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "alpha.ts");
  await writeFile(entry, "export default () => {};");

  const factories = [() => {}, () => {}];
  let calls = 0;
  const cache = new ExtensionFactoryCache({
    importFactory: async () => factories[calls++],
  });

  const first = await cache.load(cwd, agentDir);
  assert.equal(first.factories[0], factories[0]);

  // Change content (changes size) and mtime, then reload.
  await writeFile(entry, "export default () => { /* updated */ };");
  await utimes(entry, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

  const second = await cache.load(cwd, agentDir);
  assert.equal(calls, 2);
  assert.equal(second.factories[0], factories[1]);
});

test("reuses cached factories when file mtime and size are unchanged", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const entry = join(agentDir, "extensions", "alpha.ts");
  await writeFile(entry, "export default () => {};");

  let importCalls = 0;
  const factory = () => {};
  const cache = new ExtensionFactoryCache({
    importFactory: async () => { importCalls += 1; return factory; },
  });

  const first = await cache.load(cwd, agentDir);
  const second = await cache.load(cwd, agentDir);

  assert.equal(importCalls, 1);
  assert.equal(first.factories.length, 1);
  assert.equal(second.factories.length, 1);
  assert.equal(second.factories[0], factory);
});

test("deduplicates resolved paths discovered through multiple routes", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const pkgDir = join(agentDir, "extensions", "dual");
  await mkdir(pkgDir, { recursive: true });
  const entry = join(pkgDir, "index.ts");
  await writeFile(entry, "export default () => {};");
  // Manifest with two entries pointing at the same file.
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "dual", pi: { extensions: ["./index.ts", "./index.ts"] } }),
  );

  const imported: string[] = [];
  const cache = new ExtensionFactoryCache({
    importFactory: async (path: string) => { imported.push(path); return () => {}; },
  });

  const result = await cache.load(cwd, agentDir);

  assert.deepEqual(imported, [entry]);
  assert.equal(result.factories.length, 1);
});

test("ignores hidden entries, node_modules, non-extension files, and dirs without a valid entrypoint", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const globalRoot = join(agentDir, "extensions");
  // hidden file and hidden dir
  await writeFile(join(globalRoot, ".secret.ts"), "export default () => {};");
  await mkdir(join(globalRoot, ".hidden", "nested"), { recursive: true });
  await writeFile(join(globalRoot, ".hidden", "index.ts"), "export default () => {};");
  // non-extension file
  await writeFile(join(globalRoot, "notes.md"), "");
  await writeFile(join(globalRoot, "data.json"), "{}");
  // node_modules
  await mkdir(join(globalRoot, "node_modules", "thing"), { recursive: true });
  await writeFile(join(globalRoot, "node_modules", "thing", "index.ts"), "export default () => {};");
  // empty dir without any entrypoint
  await mkdir(join(globalRoot, "empty"), { recursive: true });
  // a single valid entry, to confirm discovery still runs
  const ok = join(globalRoot, "ok.ts");
  await writeFile(ok, "export default () => {};");

  const imported: string[] = [];
  const cache = new ExtensionFactoryCache({
    importFactory: async (path: string) => { imported.push(path); return () => {}; },
  });

  const result = await cache.load(cwd, agentDir);

  assert.deepEqual(imported, [ok]);
  assert.equal(result.factories.length, 1);
});

test("discovers package-manifest pi.extensions entrypoints in subdirectories", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const pkgDir = join(agentDir, "extensions", "with-manifest");
  await mkdir(join(pkgDir, "lib"), { recursive: true });
  const entry = join(pkgDir, "lib", "extension.ts");
  await writeFile(entry, "export default () => {};");
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "with-manifest", pi: { extensions: ["./lib/extension.ts"] } }),
  );

  const imported: string[] = [];
  const cache = new ExtensionFactoryCache({
    importFactory: async (path: string) => { imported.push(path); return () => {}; },
  });

  const result = await cache.load(cwd, agentDir);

  assert.equal(result.factories.length, 1);
  assert.deepEqual(imported, [entry]);
});

test("discovers index.ts and index.js entrypoints in subdirectories", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const tsDir = join(agentDir, "extensions", "alpha");
  const jsDir = join(cwd, ".pi", "extensions", "beta");
  await mkdir(tsDir, { recursive: true });
  await mkdir(jsDir, { recursive: true });
  const tsEntry = join(tsDir, "index.ts");
  const jsEntry = join(jsDir, "index.js");
  await writeFile(tsEntry, "export default () => {};");
  await writeFile(jsEntry, "export default () => {};");

  const imported: string[] = [];
  const cache = new ExtensionFactoryCache({
    importFactory: async (path: string) => { imported.push(path); return () => {}; },
  });

  const result = await cache.load(cwd, agentDir);

  assert.equal(result.factories.length, 2);
  assert.deepEqual([...imported].sort(), [tsEntry, jsEntry].sort());
});

test("discovers .ts and .js file entrypoints in agentDir/extensions and cwd/.pi/extensions", async () => {
  const { agentDir, cwd } = await makeWorkspace();
  const globalTs = join(agentDir, "extensions", "alpha.ts");
  const globalJs = join(agentDir, "extensions", "beta.js");
  const projectTs = join(cwd, ".pi", "extensions", "gamma.ts");
  const projectJs = join(cwd, ".pi", "extensions", "delta.js");
  await writeFile(globalTs, "export default () => {};");
  await writeFile(globalJs, "export default () => {};");
  await writeFile(projectTs, "export default () => {};");
  await writeFile(projectJs, "export default () => {};");

  const imported: string[] = [];
  const cache = new ExtensionFactoryCache({
    importFactory: async (path: string) => {
      imported.push(path);
      return () => {};
    },
  });

  const result = await cache.load(cwd, agentDir);

  assert.equal(result.factories.length, 4);
  assert.deepEqual(result.fallbackPaths, []);
  assert.deepEqual([...imported].sort(), [globalTs, globalJs, projectTs, projectJs].sort());
});
