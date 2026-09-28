// Builds the macOS arm64 app and publishes the GitHub release for the checked-out
// tag. .github/workflows/release.yml runs it on a macOS runner; cut a release with
// `npm run release` instead of calling this. Re-running on a tag that already has
// a release replaces its files, which is how a failed publish is retried.
// Needs cargo, zig + cargo-zigbuild and a gh token (GH_TOKEN).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
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

await run("cargo", ["build", "--release", "-p", "crewd"]);
// The Linux daemons Crew installs on other machines ship inside the app.
await run("node", ["scripts/crewd-linux.mjs"]);
await run("npm", ["run", "build"]);
await compileElectron({ release: true });
// Without --publish never, electron-builder publishes on its own when it sees CI and a tag.
await run("npx", ["electron-builder", "--mac", "--arm64", "--publish", "never"]);

const zipName = `Crew-${version}-arm64.zip`;
const zip = path.join(ROOT, "release", zipName);
const manifest = {
  version,
  zip: `https://github.com/${REPO}/releases/download/${tag}/${zipName}`,
  sha256: await sha256(zip),
};
const manifestPath = path.join(ROOT, "release", "latest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const exists = await run("gh", ["release", "view", tag, "--json", "tagName"], { capture: true }).then(
  () => true,
  () => false,
);
if (exists) {
  await run("gh", ["release", "upload", tag, zip, manifestPath, "--clobber"]);
  await run("gh", ["release", "edit", tag, "--draft=false", "--latest"]);
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
    "--generate-notes",
  ]);
}

console.log(`\nReleased ${tag}. Installed copies pick it up within 6 hours, or from Crew › Check for Updates.`);
