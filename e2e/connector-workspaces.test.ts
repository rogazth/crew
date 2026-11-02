// C1: a connector's account is for the workspaces picked, and only their
// sessions get it. Adding an account asks for its workspaces first; picked to
// one, the sign-in lands there alone, and a chat in another workspace starts
// without the connector's server. The account's ⋯ → Workspaces sets it to all,
// and the next chat there has it. The connector is a fake MCP server with its
// own OAuth (crates/crewd/examples/fake_connector.rs); its consent redirects at
// once, so the sign-in window closes on its own.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchCrew, sessions, startChat, waitFor, workspaceMark, type Crew } from "./harness.ts";
import type { Connector, Session } from "../src/lib/protocol.ts";

const FAKE = path.join(fileURLToPath(new URL("..", import.meta.url)), "target/debug/examples/fake_connector");

let crew: Crew;
let fake: ChildProcess;
let mcpUrl = "";

before(async () => {
  fake = spawn(FAKE, [], { stdio: ["ignore", "pipe", "inherit"] });
  mcpUrl = await new Promise<string>((resolve, reject) => {
    fake.once("error", reject);
    createInterface({ input: fake.stdout! }).once("line", resolve);
  });
  // The fake server is plain http on 127.0.0.1, which crewd's guard refuses otherwise.
  process.env.CREW_CONNECTORS_INSECURE = "1";
  crew = await launchCrew({ repos: ["app", "site"] });
});

after(async () => {
  await crew?.close();
  fake?.kill();
});

const list = () => crew.request<Connector[]>("connectors_list", {});
const accountOfFake = async () => (await list()).find((c) => c.name === "Fake")?.accounts[0];

/** The servers a session's claude was launched with, by name. */
async function serversOf(session: Session): Promise<string[]> {
  const launch = await waitFor(
    async () => (await crew.claudeLaunches()).find((l) => l.argv.includes(session.id) && !l.argv.includes("--strict-mcp-config")),
    { message: "the session's claude starts" },
  );
  const config = JSON.parse(launch.argv[launch.argv.indexOf("--mcp-config") + 1]!) as { mcpServers: Record<string, unknown> };
  return Object.keys(config.mcpServers).sort();
}

async function chatIn(name: string, text: string): Promise<Session> {
  const workspace = crew.workspaces.find((w) => w.name === name)!;
  await workspaceMark(crew, name).click();
  return startChat(crew, text, () => sessions(crew, workspace.id));
}

test("an account reaches only the workspaces it's for", async () => {
  const [app, site] = crew.workspaces;
  assert.deepEqual([app!.name, site!.name], ["app", "site"]);
  await crew.request("connector_add", { registryName: null, builtin: null, url: mcpUrl, name: "Fake" });

  const page = crew.window;
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  await page.getByRole("button", { name: /^Fake/ }).click();
  await page.getByRole("button", { name: "Add an account" }).click();

  const add = page.getByRole("dialog", { name: "Add an account to Fake" });
  const all = add.getByRole("checkbox", { name: /^All workspaces/ });
  assert.equal(await all.getAttribute("aria-checked"), "true", "every workspace is picked to begin with");
  await all.click();
  assert.equal(await add.getByRole("button", { name: "Sign in" }).isDisabled(), true, "no workspace, no sign-in");
  await add.getByRole("checkbox", { name: /^site/ }).click();
  await add.getByRole("button", { name: "Sign in" }).click();

  const account = await waitFor(async () => {
    const a = await accountOfFake();
    return a?.state === "connected" ? a : undefined;
  }, { message: "the sign-in lands" });
  assert.deepEqual(account.workspaces, [site!.id]);
  const accounts = page.getByRole("region", { name: "Accounts" });
  await accounts.getByText("1 workspace", { exact: true }).waitFor();

  assert.deepEqual(await serversOf(await chatIn("app", "hello from app")), ["crew"], "app isn't one of its workspaces");
  assert.deepEqual(await serversOf(await chatIn("site", "hello from site")), ["crew", "fake"]);

  // From its ⋯, to every workspace.
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  await page.getByRole("button", { name: /^Fake/ }).click();
  await page.getByRole("button", { name: `More for ${account.label}` }).click();
  await page.getByRole("menuitem", { name: "Workspaces" }).click();
  const edit = page.getByRole("dialog", { name: `Workspaces for ${account.label}` });
  assert.equal(await edit.getByRole("checkbox", { name: /^site/ }).getAttribute("aria-checked"), "true");
  assert.equal(await edit.getByRole("checkbox", { name: /^app/ }).getAttribute("aria-checked"), "false");
  await edit.getByRole("checkbox", { name: /^All workspaces/ }).click();
  await edit.getByRole("button", { name: "Save" }).click();
  await waitFor(async () => (await accountOfFake())?.workspaces === null, { message: "it's for every workspace" });
  await accounts.getByText("All workspaces", { exact: true }).waitFor();

  assert.deepEqual(await serversOf(await chatIn("app", "hello again")), ["crew", "fake"]);
});
