// Cross-compiles crewd for the Linux machines Crew installs it on, from this
// Mac: `node scripts/crewd-linux.mjs [x64] [arm64]` (both by default).
// Needs zig and cargo-zigbuild: `brew install zig cargo-zigbuild`.
// Leaves target/linux/crewd-linux-<arch>.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const TARGETS = {
  x64: "x86_64-unknown-linux-gnu",
  arm64: "aarch64-unknown-linux-gnu",
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

const wanted = process.argv.slice(2);
const unknown = wanted.filter((arch) => !(arch in TARGETS));
if (unknown.length > 0) {
  console.error(`Unknown arch: ${unknown.join(", ")}. Use ${Object.keys(TARGETS).join(" or ")}.`);
  process.exit(1);
}
const arches = wanted.length > 0 ? wanted : Object.keys(TARGETS);

if (spawnSync("cargo", ["zigbuild", "--help"], { stdio: "ignore" }).status !== 0) {
  console.error("cargo-zigbuild is missing: brew install zig cargo-zigbuild");
  process.exit(1);
}

// rust-toolchain.toml pins the toolchain; the targets have to be added to that one.
await run("rustup", ["target", "add", ...arches.map((arch) => TARGETS[arch])]);

const out = path.join("target", "linux");
mkdirSync(out, { recursive: true });
for (const arch of arches) {
  const target = TARGETS[arch];
  await run("cargo", ["zigbuild", "--release", "--target", target, "-p", "crewd"]);
  const binary = path.join(out, `crewd-linux-${arch}`);
  copyFileSync(path.join("target", target, "release", "crewd"), binary);
  console.log(`→ ${binary}`);
}
