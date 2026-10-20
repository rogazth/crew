// An image in a remote workspace's worktree comes from that machine, even
// when git put the worktree beside the workspace's folder and not inside it.
// So does one a chat there names by a path outside both, `~` being that
// machine's home, and the path is a chip that opens it.
// The two machines share this disk here, so the daemon's own log of `/fs`
// requests is the witness: a file read from this Mac's disk would load too.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import path from "node:path";
import { test } from "node:test";
import {
  addRemote,
  goToWorktree,
  launchCrew,
  MOD,
  pressChord,
  remoteRequest,
  sendInChat,
  sessionTab,
  waitFor,
  worktreeHeader,
  type RemoteDaemon,
} from "./harness.ts";
import type { Session, Workspace } from "../src/lib/types.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8DwnwEIGBgY/jMwAAAjBQP9jGqOQwAAAABJRU5ErkJggg==";

/** Forwards to `target` and keeps the request line of every `/fs` read that passes. */
async function sniffingProxy(target: number) {
  const reads: string[] = [];
  const open = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(target, "127.0.0.1");
    open.add(client).add(upstream);
    client.once("data", (chunk) => {
      const line = chunk.toString("latin1").split("\r\n")[0] ?? "";
      if (/^(GET|HEAD) \/fs\?/.test(line)) reads.push(decodeURIComponent(line));
    });
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return {
    port: (server.address() as AddressInfo).port,
    reads,
    close: () => {
      for (const socket of open) socket.destroy();
      server.close();
    },
  };
}

test("images in a remote worktree beside the workspace, and ones a chat there names outside it, are read from that machine", async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  let proxy: Awaited<ReturnType<typeof sniffingProxy>> | null = null;
  try {
    remote = await addRemote(crew, "devbox");
    proxy = await sniffingProxy(remote.port);
    // The window dials the proxy from now on.
    await crew.window.evaluate(
      (input) => window.crewHost!.remotes!.add(input),
      { id: remote.id, name: "devbox", host: "127.0.0.1", port: proxy.port, user: "agent", token: remote.token },
    );
    await crew.reload();

    const api = await crew.makeRepo("api");
    const beside = path.join(path.dirname(api), "api-feature");
    await crew.git(api, "worktree", "add", "-b", "feat/pics", beside);
    await mkdir(path.join(beside, "public"), { recursive: true });
    await writeFile(path.join(beside, "public/dot.png"), Buffer.from(PNG, "base64"));
    const page = crew.window;

    await pressChord(crew, `${MOD}+o`);
    const machine = page.getByRole("option", { name: /devbox/ });
    await machine.waitFor();
    await waitFor(() => machine.evaluate((row) => /\d+ ms/.test(row.textContent ?? "")), { message: "the machine answers" });
    await page.keyboard.press(`${MOD}+2`);
    const field = page.getByLabel("Folder on devbox");
    await field.waitFor();
    await field.fill(`${api}/`);
    await page.keyboard.press(`${MOD}+Enter`);
    await page.locator(`nav[aria-label="Workspaces"][data-sidebar-rail] button[data-nav][aria-label="api"]`).waitFor();

    await worktreeHeader(crew, "feat/pics").waitFor();
    await goToWorktree(crew, "feat/pics");

    await pressChord(crew, `${MOD}+p`);
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("textbox", { name: "Search" }).fill("dot");
    await palette.getByRole("button", { name: "public/dot.png", exact: true }).click();
    await palette.waitFor({ state: "detached" });

    const image = page.getByRole("img", { name: "public/dot.png" });
    await waitFor(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth === 2), { message: "the image loads" });
    assert.ok(
      proxy.reads.some((line) => line.includes(`root=${beside}`) && line.includes("dot.png")),
      `devbox served it: ${JSON.stringify(proxy.reads)}`,
    );

    // A chat in the worktree names files outside the workspace, as an agent saving a screenshot would.
    const shots = path.join(crew.root, "shots");
    await mkdir(shots, { recursive: true });
    await writeFile(path.join(shots, "shot.png"), Buffer.from(PNG, "base64"));
    await mkdir(path.join(crew.home, "pics"), { recursive: true });
    await writeFile(path.join(crew.home, "pics/home.png"), Buffer.from(PNG, "base64"));
    const workspace = (await remoteRequest<Workspace[]>(remote, "workspace_list")).find((row) => row.path === api);
    assert.ok(workspace, "the workspace is on devbox");
    await pressChord(crew, `${MOD}+n`);
    const chat = await waitFor(
      async () => (await remoteRequest<Session[]>(remote!, "session_list", { workspaceId: workspace.id })).find((row) => row.kind === "terminal"),
      { message: "the chat starts on devbox" },
    );
    const shot = path.join(shots, "shot.png");
    await sendInChat(crew, `saved \`${shot}\` and \`~/pics/home.png\``);

    for (const [chip, file] of [
      [shot, shot],
      ["~/pics/home.png", path.join(crew.home, "pics/home.png")],
    ] as const) {
      // A chip opens the image in the lightbox over the chat; Esc puts it away.
      await sessionTab(crew, chat).click();
      await page.locator(`.crew-file-ref[title="${chip}"]`).last().click();
      const lightbox = page.getByRole("dialog", { name: path.basename(file) });
      await lightbox.waitFor();
      const opened = lightbox.locator("img");
      await waitFor(() => opened.evaluate((img: HTMLImageElement) => img.naturalWidth === 2), { message: `${chip} loads` });
      // The lightbox reads the file itself, not through devbox's proxy: only the palette's image does.
      await page.keyboard.press("Escape");
      await lightbox.waitFor({ state: "detached" });
    }
  } finally {
    proxy?.close();
    await remote?.stop();
    await crew.close();
  }
});
