import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import electron from "electron";
import { compileElectron } from "./compile-electron.mjs";

function git(...args) {
  return path.resolve(execFileSync("git", ["rev-parse", ...args], { encoding: "utf8" }).trim());
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A linked worktree keeps its data inside itself and takes a free port, so it runs
// beside the main checkout and `git worktree remove` takes its database with it.
const linked = git("--git-dir") !== git("--git-common-dir");
const PORT = Number(process.env.CREW_PORT) || (linked ? await freePort() : 1420);
const env = { ...process.env, CREW_PORT: String(PORT) };
if (linked && !env.CREW_USER_DATA) env.CREW_USER_DATA = path.join(git("--show-toplevel"), ".crew-dev");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    if ((await canConnect(port, "127.0.0.1")) || (await canConnect(port, "::1"))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`vite did not listen on ${port}`);
}

await compileElectron();

const vite = spawn("npm", ["run", "dev"], { stdio: "inherit", env });
vite.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

const shutdown = (code = 0) => {
  if (!vite.killed) vite.kill("SIGTERM");
  process.exit(code);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  await waitForPort(PORT);
  await run("cargo", ["build", "-p", "crewd"]);
} catch (error) {
  console.error(error);
  shutdown(1);
}

if (env.CREW_USER_DATA) console.log(`crew: data in ${env.CREW_USER_DATA}, dev server on ${PORT}`);
const app = spawn(electron, ["."], { stdio: "inherit", env });
app.on("exit", (code) => shutdown(code ?? 0));
app.on("error", (error) => {
  console.error(error);
  shutdown(1);
});
