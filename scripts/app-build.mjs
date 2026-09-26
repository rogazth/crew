import { spawn } from "node:child_process";
import { compileElectron } from "./compile-electron.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

// crew rides in the bundle beside crewd; "Install `crew` Command…" links to it.
await run("cargo", ["build", "--release", "-p", "crewd", "-p", "crew-cli"]);
await run("npm", ["run", "build"]);
await compileElectron();
await run("npx", ["electron-builder", "--mac", "--arm64", "--dir"]);
