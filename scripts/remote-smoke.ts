// Installs crewd on a Linux machine over SSH, checks daemon_info, then removes it.
// Run: node --experimental-strip-types scripts/remote-smoke.ts user@100.x.y.z [arm64|x64]
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { installDaemon, remoteLayout, removeDaemon, rpc } from "../electron/remote-ssh.ts";

const exec = promisify(execFile);
const [destination, arch = "arm64"] = process.argv.slice(2);
const [user, host] = destination?.includes("@") ? destination.split("@") : [];
if (!user || !host) {
  console.error("Usage: scripts/remote-smoke.ts user@host [arm64|x64]");
  process.exit(1);
}
const binary = `target/linux/crewd-linux-${arch}`;
const target = { destination: host, user };
// A crewd of its own, beside any the release runs on that machine.
const layout = remoteLayout("dev");
const port = layout.port;

if (!existsSync(binary)) {
  console.error(`Missing ${binary}`);
  process.exit(1);
}

try {
  const paired = await installDaemon({
    target,
    port,
    layout,
    binaryFor: (wanted) => (wanted === arch ? binary : null),
    onStep: (step) => console.log(`${step.state}\t${step.id}${step.detail ? `\t${step.detail}` : ""}`),
  });
  console.log(
    JSON.stringify({
      ip: paired.ip,
      protocol: paired.protocol,
      version: paired.version,
      os: paired.os,
      home: paired.home,
      socksPort: paired.socksPort,
      installed: paired.installed,
    }),
  );
  const listing = await rpc<{ path: string; entries: unknown[] }>(paired.ip, port, paired.token, "dir_list", {
    path: "~",
  });
  console.log(`dir ${listing.path} (${listing.entries.length} folders)`);
  const active = await remote("export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active crewd");
  console.log(`service ${active.trim()}`);
  if (paired.protocol !== 1 || !paired.home.startsWith("/home/") || paired.socksPort !== port + 1) {
    throw new Error("daemon_info did not look like a paired Linux crewd");
  }
  if (active.trim() !== "active") throw new Error(`crewd is ${active.trim()}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  const diag = await remote(
    'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user status crewd --no-pager -l || true; echo ---; journalctl --user -u crewd -n 80 --no-pager || true; echo ---; ss -ltnp || netstat -ltn || true',
  ).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
  console.log(diag);
} finally {
  await removeDaemon(target, true, layout).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
  const left = await remote(
    'test ! -e "$HOME/.crew" && echo CLEAN; export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active crewd || true; loginctl show-user "$USER" -p Linger',
  );
  console.log(left.trim());
}

function remote(command: string): Promise<string> {
  return exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", `${target.user}@${target.destination}`, command]).then(
    (result) => result.stdout,
  );
}
