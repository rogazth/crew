// A workspace's icon: crewd finds the best image in its repo and the rail
// wears it; a press on the face heading its settings uploads another (kept in
// crewd's data dir, never in the repo), and a × on it goes back to the repo's.
// Each choice is crewd's, so a reload keeps it.
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

/** The face heading the workspace's settings: from wherever the window is, open or not. */
async function openFace() {
  const face = crew.window.getByRole("button", { name: "Change icon" });
  if (!(await face.isVisible())) {
    await crew.window.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Settings", exact: true }).click();
  }
  await face.waitFor({ timeout: 10_000 });
  return face;
}

test("the rail wears the repo's best icon", async () => {
  const found = await waitFor(
    async () => {
      const answer = await icon(true);
      return answer.found.length > 0 && answer;
    },
    { message: "crewd finds the repo's images" },
  );
  assert.deepEqual(
    found.found.map((file) => file.path),
    ["public/favicon.svg", "public/logo.svg"],
    "square first, nothing from node_modules",
  );
  await waitFor(async () => (await railImage()) === found.found[0]!.image, { message: "the rail draws the favicon" });

  await openFace();
  assert.equal(await crew.window.getByRole("button", { name: "Remove icon" }).count(), 0, "nothing to remove on the default");
});

test("an uploaded image survives a reload, and its × goes back to the repo's", async () => {
  const best = (await icon(true)).found[0]!.image;
  // An image dropped on the face is uploaded.
  await (
    await openFace()
  ).evaluate((face, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "mine.png", { type: "image/png" }));
    face.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, PNG);
  const uploaded = await waitFor(
    async () => {
      const answer = await icon(true);
      return answer.choice === "upload" && answer;
    },
    { message: "crewd keeps the upload" },
  );
  assert.equal(uploaded.image, `data:image/png;base64,${PNG}`);
  assert.ok(existsSync(path.join(crew.userData, "workspace-icons", `${site().id}.png`)), "kept in crewd's data dir");
  const inRepo = await readdir(site().path, { recursive: true });
  assert.ok(!inRepo.some((file) => String(file).includes("mine") || String(file).includes(site().id)), "nothing written to the repo");

  await crew.reload();
  await waitFor(async () => (await railImage()) === uploaded.image, { message: "the rail draws the upload after the reload" });

  const face = await openFace();
  await face.hover();
  await crew.window.getByRole("button", { name: "Remove icon" }).click();
  await waitFor(async () => (await icon()).choice === "auto", { message: "crewd goes back to the default" });
  await waitFor(async () => (await railImage()) === best, { message: "the rail draws the favicon again" });
});
