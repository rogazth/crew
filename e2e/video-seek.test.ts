// A video opened from the project moves along its timeline, not only plays and
// pauses: its bytes are served by range, on this Mac and from another machine.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { before, test } from "node:test";
import { addRemote, launchCrew, MOD, pressChord, waitFor, workspaceMark, type Crew, type RemoteDaemon } from "./harness.ts";

/** The ten-second fixture is small enough to load whole, and a whole file seeks anyway: a `free` box keeps it loading. */
async function largeVideo(): Promise<Buffer> {
  const clip = await readFile(path.join(import.meta.dirname, "fixtures", "clip.mp4"));
  const padding = Buffer.alloc(64 * 1024 * 1024);
  padding.writeUInt32BE(padding.length, 0);
  padding.write("free", 4, "latin1");
  return Buffer.concat([clip, padding]);
}

async function committedRepo(crew: Crew, video: Buffer): Promise<string> {
  const repo = await crew.makeRepo("media");
  await writeFile(path.join(repo, "clip.mp4"), video);
  await crew.git(repo, "add", "clip.mp4");
  await crew.git(repo, "commit", "--quiet", "--message", "video");
  return repo;
}

/** Runs a script in the guest that previews the video. */
const inGuest = <T>(crew: Crew, script: string) =>
  crew.app.evaluate(async ({ webContents }, script) => {
    const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith("crew-file://"));
    return guest ? ((await guest.executeJavaScript(script)) as unknown) : null;
  }, script) as Promise<T | null>;

async function openVideo(crew: Crew): Promise<void> {
  await pressChord(crew, `${MOD}+p`);
  const palette = crew.window.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Search" }).fill("clip");
  await palette.getByRole("button", { name: "clip.mp4", exact: true }).click();
  await palette.waitFor({ state: "detached" });
}

async function assertSeeks(crew: Crew, size: number): Promise<void> {
  await waitFor(async () => ((await inGuest<number>(crew, "document.querySelector('video')?.readyState ?? 0")) ?? 0) >= 1, {
    message: "the video loads",
  });

  const part = await inGuest<{ status: number; contentRange: string | null; length: number }>(
    crew,
    `fetch(location.href, { headers: { range: "bytes=10-19" } }).then(async (r) => ({
      status: r.status,
      contentRange: r.headers.get("content-range"),
      length: (await r.arrayBuffer()).byteLength,
    }))`,
  );
  const landed = await inGuest<number>(
    crew,
    `new Promise((resolve) => {
      const video = document.querySelector('video');
      video.pause();
      const done = () => resolve(video.currentTime);
      video.addEventListener('seeked', done, { once: true });
      setTimeout(done, 5000);
      video.currentTime = 6;
    })`,
  );
  assert.ok(Math.abs((landed ?? 0) - 6) < 0.5, `the video landed at ${landed}`);
  assert.deepEqual(part, { status: 206, contentRange: `bytes 10-19/${size}`, length: 10 });
}

let video: Buffer;

before(async () => {
  video = await largeVideo();
});

test("a video on this Mac seeks", async () => {
  const crew = await launchCrew();
  try {
    await crew.addWorkspace(await committedRepo(crew, video));
    await openVideo(crew);
    await assertSeeks(crew, video.length);
  } finally {
    await crew.close();
  }
});

test("a video on another machine seeks", async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox");
    const repo = await committedRepo(crew, video);
    const window = crew.window;

    await pressChord(crew, `${MOD}+o`);
    const machine = window.getByRole("option", { name: /devbox/ });
    await machine.waitFor();
    await waitFor(() => machine.evaluate((row) => /\d+ ms/.test(row.textContent ?? "")), { message: "the machine answers" });
    await window.keyboard.press(`${MOD}+2`);
    const field = window.getByLabel("Folder on devbox");
    await field.waitFor();
    await field.fill(`${repo}/`);
    await window.keyboard.press(`${MOD}+Enter`);
    await workspaceMark(crew, "media").waitFor();

    await openVideo(crew);
    await assertSeeks(crew, video.length);
  } finally {
    await remote?.stop();
    await crew.close();
  }
});
