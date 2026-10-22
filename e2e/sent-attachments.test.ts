// What the user attached to a message stays an attachment once it is sent: the
// bubble holds the words alone and the picture sits under it, for every
// provider Crew drives a chat over.
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { composerOf, installFakeCodex, installFakeOpencode, launchCrew, newSession, waitFor, type Crew } from "./harness.ts";

// An 8×8 red PNG: what a screenshot on the clipboard is to the composer.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAD///9BHTQRAAAAEUlEQVQI12P4z8AARjAGHgBzVwX7VJ6PQgAAAABJRU5ErkJggg==";

let crew: Crew;

before(async () => {
  crew = await launchCrew();
  await installFakeCodex(crew);
  await installFakeOpencode(crew);
});

after(async () => {
  await crew?.close();
});

/** A screenshot pasted into the chat's composer, the way the clipboard hands it over. */
async function pasteImage(): Promise<void> {
  await composerOf(crew).evaluate((field, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "image.png", { type: "image/png" }));
    field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, PNG);
}

for (const provider of ["claude", "codex", "opencode"]) {
  test(`a message sent to ${provider} with a picture shows it as an attachment, not a path`, async () => {
    const [workspace] = crew.workspaces;
    assert.ok(workspace);
    await crew.request("state_set", {
      key: "providers:default",
      value: JSON.stringify({ provider, model: "", effort: "", access: "full" }),
    });
    await crew.reload();
    const session = await newSession(crew, workspace.id);

    await pasteImage();
    const pending = crew.window.getByRole("button", { name: /^Open .*\.png$/ });
    await pending.waitFor();
    const words = `look at these ${provider}`;
    const field = composerOf(crew, session);
    await field.fill(words);
    await field.press("Enter");

    const message = crew.window.locator('[data-message="user"]').filter({ hasText: words });
    const bubble = message.locator("[data-bubble]");
    await bubble.waitFor();
    await waitFor(async () => (await crew.request<{ status: string }>("session_get", { id: session.id })).status !== "working", {
      message: "the turn is over",
    });
    assert.equal((await bubble.innerText()).trim(), words, "the bubble holds the words alone");
    await message.getByRole("button", { name: /^Open .*\.png$/ }).waitFor();
    await crew.window.screenshot({ path: path.join(process.env.E2E_SHOTS ?? crew.root, `sent-${provider}.png`) });
  });
}
