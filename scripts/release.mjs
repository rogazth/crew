// Cuts a release from any machine: `npm run release -- <patch|minor|major|X.Y.Z>`.
// Bumps the version everywhere it lives, commits, tags and pushes master and the
// tag together. The tag starts .github/workflows/release.yml, which builds the app
// on a macOS runner and publishes the GitHub release (scripts/release-publish.mjs).
// Needs only node, git and push access: no Rust, zig or Mac.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BRANCH = "master";
// The workspace crates whose version Cargo.lock records.
const CRATES = ["crew-cli", "crew-core", "crew-protocol", "crewd"];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      cwd: ROOT,
    });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [major, minor, patch] = current.split(".").map(Number);
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "major") return `${major + 1}.0.0`;
  return null;
}

function newer(next, current) {
  const a = next.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Swaps exactly one match, so a file that changed shape fails loudly instead of
// shipping with a stale version.
function replaceOnce(text, pattern, replacement, file) {
  const matches = text.match(new RegExp(pattern, "gm")) ?? [];
  if (matches.length !== 1) fail(`Expected one version line in ${file}, found ${matches.length}.`);
  return text.replace(new RegExp(pattern, "m"), replacement);
}

async function edit(file, change) {
  const full = path.join(ROOT, file);
  await writeFile(full, change(await readFile(full, "utf8")));
}

const bump = process.argv[2];
if (!bump) fail("Usage: npm run release -- <patch|minor|major|X.Y.Z>");

const { version: current } = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const version = nextVersion(current, bump);
if (!version) fail(`"${bump}" is not patch, minor, major or a version like 1.2.3.`);
if (!newer(version, current)) fail(`${version} is not newer than the current ${current}.`);
const tag = `v${version}`;

if (await run("git", ["status", "--porcelain"], { capture: true })) {
  fail("The working tree is dirty. Commit or stash before releasing.");
}
const branch = await run("git", ["branch", "--show-current"], { capture: true });
if (branch !== BRANCH) fail(`Releases are cut from ${BRANCH}; this is ${branch || "a detached HEAD"}.`);

await run("git", ["fetch", "origin", BRANCH, "--tags"]);
const behind = await run("git", ["rev-list", "--count", `HEAD..origin/${BRANCH}`], { capture: true });
if (behind !== "0") fail(`${BRANCH} is ${behind} commits behind origin. Pull first.`);
if (await run("git", ["tag", "--list", tag], { capture: true })) fail(`${tag} already exists.`);

await edit("package.json", (text) =>
  replaceOnce(text, `^  "version": "${current}",$`, `  "version": "${version}",`, "package.json"),
);
// The lockfile carries the version twice: at the top and under packages[""].
await edit("package-lock.json", (text) => {
  const top = replaceOnce(text, `^  "version": "${current}",$`, `  "version": "${version}",`, "package-lock.json");
  // Keyed on the name, since a dependency can sit at the same version.
  return replaceOnce(
    top,
    `^      "name": "crew",\\n      "version": "${current}",$`,
    `      "name": "crew",\n      "version": "${version}",`,
    "package-lock.json",
  );
});
await edit("Cargo.toml", (text) =>
  replaceOnce(text, `^version = "${current}"$`, `version = "${version}"`, "Cargo.toml"),
);
await edit("Cargo.lock", (text) =>
  CRATES.reduce(
    (lock, crate) =>
      replaceOnce(
        lock,
        `^name = "${crate}"\\nversion = "${current}"$`,
        `name = "${crate}"\nversion = "${version}"`,
        `Cargo.lock (${crate})`,
      ),
    text,
  ),
);

await run("git", ["add", "package.json", "package-lock.json", "Cargo.toml", "Cargo.lock"]);
await run("git", ["commit", "-m", `chore: bump the version to ${version}`]);
await run("git", ["tag", tag]);
// Atomic: the tag never reaches origin without the commit it points at.
await run("git", ["push", "--atomic", "origin", BRANCH, tag]);

console.log(`\nPushed ${tag}. The Release workflow builds and publishes it:`);
console.log("  gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')");
