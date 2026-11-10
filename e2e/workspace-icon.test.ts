// A workspace's icon: crewd finds the best image in its repo and the rail
// wears it; the face heading its settings opens a card to pick another of the
// repo's images, upload one (kept in crewd's data dir, never in the repo) or
// go back to the initials. Each choice is crewd's, so a reload keeps it.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import type { WorkspaceIcon } from "../src/lib/protocol.ts";
import { launchCrew, waitFor, workspaceMark, type Crew } from "./harness.ts";

const square = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${fill}"/></svg>\n`;
const wide = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100"/></svg>\n`;
/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let crew: Crew;

before(async () => {
  crew = await launchCrew({
    repos: [
      {
        name: "site",
        files: {
          "README.md": "# site\n",
          "public/favicon.svg": square("#4f46e5"),
          "public/logo.svg": wide,
          "node_modules/pkg/favicon.svg": square("#ff0000"),
        },
      },
    ],
  });
});

after(async () => {
  await crew?.close();
});

const site = () => {
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  return workspace;
};

const icon = (choices = false) => crew.request<WorkspaceIcon>("workspace_icon_get", { id: site().id, choices });

/** What the rail's mark draws: an image's data URL, or null for the initials. */
const railImage = () =>
  workspaceMark(crew, "site")
    .locator("img")
    .first()
    .getAttribute("src", { timeout: 1000 })
    .catch(() => null);

/** The workspace's settings, and the icon card on them: from wherever the window is, open or not. */
async function openPicker() {
  const group = crew.window.getByRole("radiogroup", { name: "Icon" });
  if (await group.isVisible()) return group;
  const face = crew.window.getByRole("button", { name: "Change icon" });
  if (!(await face.isVisible())) {
    await crew.window.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Settings", exact: true }).click();
  }
  await face.click();
  await group.waitFor({ timeout: 10_000 });
  return group;
}

async function checked(group: Awaited<ReturnType<typeof openPicker>>): Promise<string | null> {
  return group.getByRole("radio", { checked: true }).getAttribute("aria-label");
}

test("the rail wears the repo's best icon, and the picker offers the repo's images", async () => {
  const found = await waitFor(async () => {
    const answer = await icon(true);
    return answer.found.length > 0 && answer;
  }, { message: "crewd finds the repo's images" });
  assert.deepEqual(
    found.found.map((file) => file.path),
    ["public/favicon.svg", "public/logo.svg"],
    "square first, nothing from node_modules",
  );
  await waitFor(async () => (await railImage()) === found.found[0]!.image, { message: "the rail draws the favicon" });

  const group = await openPicker();
  assert.equal(await checked(group), "Automatic");
  assert.ok(await group.getByRole("radio", { name: "logo.svg" }).isVisible());
});

test("the initials, then an uploaded image, each survive a reload", async () => {
  let group = await openPicker();
  await group.getByRole("radio", { name: "Initials" }).click();
  await waitFor(async () => (await icon()).choice === "initials", { message: "crewd keeps the initials" });
  await waitFor(async () => (await railImage()) === null, { message: "the rail draws the initials" });
  await crew.reload();
  group = await openPicker();
  assert.equal(await checked(group), "Initials", "the initials survive the reload");
  assert.equal(await railImage(), null);

  // An image dropped on the face is uploaded.
  await crew.window.getByRole("button", { name: "Change icon" }).evaluate((face, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "mine.png", { type: "image/png" }));
    face.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, PNG);
  const uploaded = await waitFor(async () => {
    const answer = await icon(true);
    return answer.choice === "upload" && answer;
  }, { message: "crewd keeps the upload" });
  assert.equal(uploaded.image, `data:image/png;base64,${PNG}`);
  assert.ok(existsSync(path.join(crew.userData, "workspace-icons", `${site().id}.png`)), "kept in crewd's data dir");
  const inRepo = await readdir(site().path, { recursive: true });
  assert.ok(!inRepo.some((file) => String(file).includes("mine") || String(file).includes(site().id)), "nothing written to the repo");

  await crew.reload();
  await waitFor(async () => (await railImage()) === uploaded.image, { message: "the rail draws the upload after the reload" });
  group = await openPicker();
  assert.equal(await checked(group), "Uploaded image");

  // Another of the repo's images, picked: crewd keeps the file it names.
  await group.getByRole("radio", { name: "logo.svg" }).click();
  await waitFor(async () => {
    const answer = await icon();
    return answer.choice === "repo" && answer.path === "public/logo.svg";
  }, { message: "crewd keeps the repo's file" });
});
