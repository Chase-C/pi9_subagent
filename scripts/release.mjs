#!/usr/bin/env node
// Cuts a release in one step: bumps the version, rolls [Unreleased] into a
// dated changelog section, tags and pushes the release commit, then creates a
// GitHub Release with those changelog entries. The Release triggers
// .github/workflows/publish.yml, which publishes to npm via OIDC trusted publishing.
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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function resolveNextVersion(currentVersion, bump) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(bump)) return bump;

  const dir = mkdtempSync(join(tmpdir(), "pi9-release-version-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "version-probe", version: currentVersion }));
    return capture("npm", ["version", bump, "--no-git-tag-version", "--ignore-scripts", "--prefix", dir]).replace(/^v/, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function prepareChangelog(content, version, date) {
  const heading = content.match(/^## \[Unreleased\](?: - .*?)?$/m);
  if (!heading || heading.index === undefined) abort("CHANGELOG.md must contain a '## [Unreleased]' section.");
  if (new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\](?: |$)`, "m").test(content)) {
    abort(`CHANGELOG.md already contains a ${version} release section.`);
  }

  const sectionStart = heading.index;
  const bodyStart = sectionStart + heading[0].length;
  const nextHeading = content.slice(bodyStart).match(/^## \[/m);
  if (!nextHeading || nextHeading.index === undefined) abort("CHANGELOG.md needs a released section after [Unreleased].");
  const nextSectionStart = bodyStart + nextHeading.index;
  const notes = content.slice(bodyStart, nextSectionStart).trim();
  if (!notes) abort("CHANGELOG.md [Unreleased] has no entries to release.");

  const link = content.match(/^\[Unreleased\]:\s+(.+?\/compare\/)([^\s]+)\.\.\.HEAD$/m);
  if (!link) abort("CHANGELOG.md must contain an [Unreleased] comparison link ending in ...HEAD.");
  const [, comparePrefix, previousTag] = link;
  const tag = `v${version}`;

  let updated = [
    content.slice(0, sectionStart),
    "## [Unreleased]\n\n",
    `## [${version}] - ${date}\n\n`,
    notes,
    "\n\n",
    content.slice(nextSectionStart),
  ].join("");
  updated = updated.replace(
    /^\[Unreleased\]:.*$/m,
    `[Unreleased]: ${comparePrefix}${tag}...HEAD\n[${version}]: ${comparePrefix}${previousTag}...${tag}`,
  );

  return { updated, notes };
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
const nextVersion = resolveNextVersion(currentVersion, bump);
const newTag = `v${nextVersion}`;
const now = new Date();
const releaseDate = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
].join("-");
const changelogUrl = new URL("../CHANGELOG.md", import.meta.url);
const changelog = prepareChangelog(readFileSync(changelogUrl, "utf8"), nextVersion, releaseDate);

console.log(`\n→ Releasing @pi9/subagent (v${currentVersion} → ${newTag})${dryRun ? "  [dry-run]" : ""}\n`);

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

// --- Bump, changelog, push, release ---------------------------------------
if (dryRun) {
  console.log(`\n  [dry-run] npm version ${bump} --no-git-tag-version   (${newTag})`);
  console.log(`  [dry-run] move CHANGELOG.md [Unreleased] entries to [${nextVersion}] - ${releaseDate}`);
} else {
  const bumpedTag = execFileSync("npm", ["version", bump, "--no-git-tag-version"], { encoding: "utf8" }).trim();
  if (bumpedTag !== newTag) abort(`npm resolved ${bumpedTag}, expected ${newTag}.`);
  writeFileSync(changelogUrl, changelog.updated);
}

mutate("git", ["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
mutate("git", ["commit", "-m", `Release ${newTag}`]);
mutate("git", ["tag", "-a", newTag, "-m", `Release ${newTag}`]);

console.log(`\n→ Version tag: ${newTag}`);

mutate("git", ["push", "origin", RELEASE_BRANCH]);
mutate("git", ["push", "origin", newTag]);

if (dryRun) {
  console.log(`  [dry-run] gh release create ${newTag} --title ${newTag} --generate-notes --notes <${nextVersion} changelog entries>`);
} else {
  try {
    execFileSync(
      "gh",
      ["release", "create", newTag, "--title", newTag, "--generate-notes", "--notes", changelog.notes],
      { stdio: "inherit" },
    );
  } catch {
    abort([
      `Tag ${newTag} was pushed, but creating the GitHub Release failed.`,
      "Create it manually with the matching CHANGELOG section to trigger the publish workflow.",
    ].join("\n"));
  }
}

console.log(`\n✔ ${dryRun ? "[dry-run] would create" : "Created"} release ${newTag}.`);
console.log("  The publish workflow runs on the new Release — watch it with:");
console.log("    gh run watch    (or the repo's Actions tab)\n");
