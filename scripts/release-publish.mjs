// Builds the macOS arm64 app and publishes the GitHub release for the checked-out
// tag. .github/workflows/release.yml runs it on a macOS runner; cut a release with
// `npm run release` instead of calling this. Re-running on a tag that already has
// a release replaces its files, which is how a failed publish is retried.
// Needs the daemons the workflow's other jobs build (in target/release and
// target/linux) and a gh token (GH_TOKEN).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileElectron } from "./compile-electron.mjs";

const REPO = "rogazth/crew";
const ROOT = path.resolve(import.meta.dirname, "..");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      cwd: ROOT,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
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

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const { version } = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const tag = `v${version}`;

const tagsHere = (await run("git", ["tag", "--points-at", "HEAD"], { capture: true })).split("\n");
if (!tagsHere.includes(tag)) fail(`HEAD is not tagged ${tag}; publish only runs on a release tag.`);

const cargo = await readFile(path.join(ROOT, "Cargo.toml"), "utf8");
const crateVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (crateVersion !== version) fail(`package.json is ${version} but Cargo.toml is ${crateVersion}.`);

const daemons = ["target/release/crewd", "target/release/crew", "target/linux/crewd-linux-x64", "target/linux/crewd-linux-arm64"];
const missing = daemons.filter((file) => !existsSync(path.join(ROOT, file)));
if (missing.length > 0) fail(`Missing ${missing.join(", ")}; the release workflow's daemon jobs build them.`);

await run("node", ["scripts/licenses.mjs"]);
await run("npm", ["run", "build"]);
await compileElectron({ release: true });
// Without --publish never, electron-builder publishes on its own when it sees CI and a tag.
await run("npx", ["electron-builder", "--mac", "--arm64", "--publish", "never"]);

// What changed since the last release: the commits that are news (feat, fix, refactor, perf).
// The app shows them in the update card; the GitHub release carries the same bullets,
// which "What's new" reads back (src/lib/update.ts › notesOf).
const NEWS = { feat: "new", fix: "fixed", refactor: "improved", perf: "improved" };
async function releaseNotes() {
  const tags = (await run("git", ["tag", "--list", "v*", "--sort=-v:refname"], { capture: true })).split("\n").filter(Boolean);
  const previous = tags[tags.indexOf(tag) + 1];
  const range = previous ? `${previous}..${tag}` : tag;
  const subjects = (await run("git", ["log", range, "--no-merges", "--pretty=%s"], { capture: true })).split("\n");
  const notes = [];
  const lines = [];
  for (const subject of subjects) {
    const match = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(subject.trim());
    const kind = match && NEWS[match[1].toLowerCase()];
    if (!kind) continue;
    const text = match[2].trim();
    notes.push({ kind, text: text.charAt(0).toUpperCase() + text.slice(1) });
    lines.push(`- ${subject.trim()}`);
  }
  return { notes, body: lines.join("\n") };
}
const { notes, body } = await releaseNotes();

const zipName = `Crew-${version}-arm64.zip`;
const zip = path.join(ROOT, "release", zipName);
const manifest = {
  version,
  zip: `https://github.com/${REPO}/releases/download/${tag}/${zipName}`,
  sha256: await sha256(zip),
  // Optional: installed copies from before these existed ignore them.
  size: statSync(zip).size,
  date: new Date().toISOString(),
  notes,
};
const manifestPath = path.join(ROOT, "release", "latest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const exists = await run("gh", ["release", "view", tag, "--json", "tagName"], { capture: true }).then(
  () => true,
  () => false,
);
if (exists) {
  await run("gh", ["release", "upload", tag, zip, manifestPath, "--clobber"]);
  await run("gh", ["release", "edit", tag, "--draft=false", "--latest", "--notes", body || `Crew ${version}`]);
} else {
  await run("gh", [
    "release",
    "create",
    tag,
    zip,
    manifestPath,
    "--verify-tag",
    "--title",
    `Crew ${version}`,
    "--notes",
    body || `Crew ${version}`,
  ]);
}

console.log(`\nReleased ${tag}. Installed copies pick it up within 6 hours, or from Crew › Check for Updates.`);
