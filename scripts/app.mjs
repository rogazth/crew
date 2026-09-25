import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import electron from "electron";
import { compileElectron } from "./compile-electron.mjs";

const PORT = Number(process.env.CREW_PORT) || 1420;

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

const vite = spawn("npm", ["run", "dev"], { stdio: "inherit" });
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

const app = spawn(electron, ["."], { stdio: "inherit" });
app.on("exit", (code) => shutdown(code ?? 0));
app.on("error", (error) => {
  console.error(error);
  shutdown(1);
});
