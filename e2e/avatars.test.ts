// A1: agents' faces. Settings › Appearance › "Avatar style" changes every
// agent's face, and "Change Face…" gives one agent a face of its own; crewd
// keeps both (`agent:avatar`, `agent:faces`) and a relaunch draws the same
// face. Faces are compared as the images drawn (their data URIs), never
// against a known value.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { launchCrew, MOD, pressChord, sessions, waitFor, type Crew } from "./harness.ts";

/** The agent's card in the sidebar panel. */
function card(crew: Crew, name: string) {
  return crew.window.locator(`[data-sidebar-panel] button[data-session][aria-label="${name}"]`);
}

/** The face the card draws, once its style has loaded (a glyph holds the spot until then). */
async function faceOf(crew: Crew, name: string): Promise<string> {
  return waitFor(() => card(crew, name).locator("img").first().getAttribute("src", { timeout: 1000 }), {
    message: `${name}'s card draws a face`,
  });
}

/** A crewd state key, parsed as JSON when it is JSON. */
async function stored(crew: Crew, key: string): Promise<unknown> {
  const raw = await crew.request<string | null>("state_get", { key });
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

type Faces = Record<string, { style?: string; seed?: string }>;

test("A1: the avatar style and a face picked for one agent survive a restart", async (t) => {
  let crew = await launchCrew();
  t.after(() => crew.close());
  const [workspace] = crew.workspaces;
  assert.ok(workspace);
  const page = crew.window;

  // An agent, made in the sheet.
  await pressChord(crew, `${MOD}+Shift+n`);
  const sheet = page.getByRole("dialog", { name: "New agent" });
  await sheet.getByPlaceholder("e.g. Research").fill("Scout");
  await sheet.getByRole("button", { name: "Create agent" }).click();
  await sheet.waitFor({ state: "detached" });
  const agent = await waitFor(
    async () => (await sessions(crew, workspace.id)).find((row: Session) => row.kind === "agent" && row.name === "Scout"),
    { message: "crewd has the agent" },
  );
  // A new agent is dealt a face of its own at birth; the window published it before crewd had it.
  await waitFor(async () => (((await stored(crew, "agent:faces")) ?? {}) as Faces)[agent.id]?.seed, {
    message: "crewd keeps the face the agent was born with",
  });
  const born = await faceOf(crew, "Scout");

  // Settings › Appearance › Avatar style: anything but the one in use.
  await pressChord(crew, `${MOD}+,`);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const select = page.getByRole("combobox", { name: "Avatar style" });
  const current = (await select.innerText()).trim();
  await select.click();
  const options = page.getByRole("option");
  await options.first().waitFor();
  const labels = (await options.allInnerTexts()).map((label) => label.trim());
  const other = labels.find((label) => label !== current);
  assert.ok(other, `a style other than ${current} among ${labels.join(", ")}`);
  await page.getByRole("option", { name: other, exact: true }).click();
  const style = await waitFor(
    async () => {
      const value = await stored(crew, "agent:avatar");
      return typeof value === "string" && value !== "" && value;
    },
    { message: "crewd keeps the avatar style" },
  );
  await pressChord(crew, `${MOD}+,`);
  const restyled = await waitFor(async () => {
    const face = await faceOf(crew, "Scout");
    return face !== born && face;
  }, { message: "the agent's face is drawn in the new style" });

  // Change Face…: a new hand, one face from it, saved.
  await card(crew, "Scout").click({ button: "right", force: true });
  await page.getByRole("menuitem", { name: "Change Face…" }).click();
  const settings = page.getByRole("dialog", { name: "Agent settings" });
  await settings.waitFor();
  const before = ((await stored(crew, "agent:faces")) ?? {}) as Faces;
  await settings.getByRole("button", { name: "Deal new faces" }).click();
  const choice = settings.getByRole("radio", { name: "Use this face" }).nth(2);
  const chosen = await waitFor(() => choice.locator("img").getAttribute("src", { timeout: 1000 }), {
    message: "the hand draws its faces",
  });
  await choice.click();
  await settings.getByRole("button", { name: "Save" }).click();
  await settings.waitFor({ state: "detached" });
  const faces = await waitFor(
    async () => {
      const value = ((await stored(crew, "agent:faces")) ?? {}) as Faces;
      const seed = value[agent.id]?.seed;
      return seed && seed !== before[agent.id]?.seed && value;
    },
    { message: "crewd keeps the agent's new face" },
  );
  assert.deepEqual(Object.keys(faces), [agent.id], "only this agent has a face of its own");
  const picked = await waitFor(async () => {
    const face = await faceOf(crew, "Scout");
    return face !== restyled && face;
  }, { message: "the card wears the new face" });
  assert.equal(picked, chosen, "the card wears the face that was picked");

  crew = await crew.restart();
  assert.equal(await stored(crew, "agent:avatar"), style, "the style survives the restart");
  assert.deepEqual(await stored(crew, "agent:faces"), faces, "the face survives the restart");
  // The faces arrive from crewd after the first paint, which may draw the default face first.
  let shown = "";
  await waitFor(async () => (shown = await faceOf(crew, "Scout")) === picked, { timeout: 5000 }).catch(() => {});
  assert.equal(shown, picked, "the relaunched card draws the same face");
});
