#!/usr/bin/env node
// Cuts a release in one step: bumps the version, tags it, pushes, and creates
// a GitHub Release. The Release triggers .github/workflows/publish.yml, which
// publishes to npm via OIDC trusted publishing.
//
// This script does NOT publish to npm directly — that stays with the workflow.
//
// Usage:
//   npm run release:patch                 # 0.1.0 -> 0.1.1
//   npm run release:minor                 # 0.1.0 -> 0.2.0
//   npm run release:major                 # 0.1.0 -> 1.0.0
//   npm run release -- 1.4.2              # explicit version
//   npm run release -- patch --dry-run   # preview without changing anything
//   npm run release -- patch --skip-checks   # skip the local typecheck+test gate

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RELEASE_BRANCH = "main";
const KEYWORDS = ["patch", "minor", "major", "prepatch", "preminor", "premajor", "prerelease"];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipChecks = args.includes("--skip-checks");
const bump = args.find(a => !a.startsWith("--"));

function abort(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

// In a real run, a failed check aborts. In --dry-run it's reported but we keep
// going, so you see the entire plan even from a dirty tree or the wrong branch.
function check(ok, msg) {
  if (ok) return;
  if (dryRun) console.warn(`  ⚠ would abort: ${msg}`);
  else abort(msg);
}

function capture(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { encoding: "utf8" }).trim();
}

function silent(cmd, cmdArgs) {
  execFileSync(cmd, cmdArgs, { stdio: "ignore" });
}

// State-changing commands: skipped (but printed) in --dry-run.
function mutate(cmd, cmdArgs) {
  if (dryRun) {
    console.log(`  [dry-run] ${cmd} ${cmdArgs.join(" ")}`);
    return;
  }
  execFileSync(cmd, cmdArgs, { stdio: "inherit" });
}

// --- Validate arguments ----------------------------------------------------
if (!bump) {
  abort([
    "Specify a version bump.",
    "  npm run release:patch | release:minor | release:major",
    "  npm run release -- <patch|minor|major|x.y.z> [--dry-run] [--skip-checks]",
  ].join("\n"));
}
const isExplicitVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(bump);
if (!KEYWORDS.includes(bump) && !isExplicitVersion) {
  abort(`Invalid bump "${bump}". Use one of ${KEYWORDS.join(", ")}, or an explicit x.y.z version.`);
}

const currentVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

console.log(`\n→ Releasing @pi9/subagent (current v${currentVersion}, bump: ${bump})${dryRun ? "  [dry-run]" : ""}\n`);

// --- Preflight -------------------------------------------------------------
let ghInstalled = true;
try { silent("gh", ["--version"]); } catch { ghInstalled = false; }
check(ghInstalled, "GitHub CLI (gh) not found. Install it: https://cli.github.com");

if (ghInstalled) {
  let ghAuthed = true;
  try { silent("gh", ["auth", "status"]); } catch { ghAuthed = false; }
  check(ghAuthed, "Not logged in to GitHub CLI. Run: gh auth login");
}

const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
check(branch === RELEASE_BRANCH, `Releases must be cut from "${RELEASE_BRANCH}", but you're on "${branch}".`);

check(capture("git", ["status", "--porcelain"]) === "", "Working tree is not clean. Commit or stash your changes first.");

try { silent("git", ["fetch", "origin", RELEASE_BRANCH]); } catch { /* offline: skip the up-to-date check */ }
let behind = 0;
try {
  behind = Number(capture("git", ["rev-list", "--left-right", "--count", `origin/${RELEASE_BRANCH}...HEAD`]).split(/\s+/)[0] || 0);
} catch { /* no upstream yet */ }
check(behind === 0, `Local ${RELEASE_BRANCH} is ${behind} commit(s) behind origin/${RELEASE_BRANCH}. Run: git pull --ff-only`);

// --- Local gate (mirrors the CI prepublishOnly gate) -----------------------
if (skipChecks) {
  console.log("⚠ Skipping local typecheck + tests (--skip-checks).");
} else {
  console.log("▶ Running typecheck + tests (skip with --skip-checks)…");
  mutate("npm", ["run", "typecheck"]);
  mutate("npm", ["test"]);
}

// --- Bump, push, release ---------------------------------------------------
let newTag;
if (dryRun) {
  console.log(`\n  [dry-run] npm version ${bump} -m "Release v%s"   (from v${currentVersion})`);
  newTag = `v<next:${bump}>`;
} else {
  newTag = execFileSync("npm", ["version", bump, "-m", "Release v%s"], { encoding: "utf8" }).trim();
}
console.log(`\n→ Version tag: ${newTag}`);

mutate("git", ["push", "origin", RELEASE_BRANCH]);
mutate("git", ["push", "origin", newTag]);

if (dryRun) {
  console.log(`  [dry-run] gh release create ${newTag} --title ${newTag} --generate-notes`);
} else {
  try {
    execFileSync("gh", ["release", "create", newTag, "--title", newTag, "--generate-notes"], { stdio: "inherit" });
  } catch {
    abort([
      `Tag ${newTag} was pushed, but creating the GitHub Release failed.`,
      "Create it manually to trigger the publish workflow:",
      `  gh release create ${newTag} --generate-notes`,
    ].join("\n"));
  }
}

console.log(`\n✔ ${dryRun ? "[dry-run] would create" : "Created"} release ${newTag}.`);
console.log("  The publish workflow runs on the new Release — watch it with:");
console.log("    gh run watch    (or the repo's Actions tab)\n");
