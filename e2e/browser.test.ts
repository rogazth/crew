import { after, before, test } from "node:test";
import { startFixtures, type Fixtures } from "./fixtures.ts";
import { guestEval, guests, launchCrew, MOD, pressInGuest, waitFor, type Crew } from "./harness.ts";

let crew: Crew;
let site: Fixtures;

before(async () => {
  site = await startFixtures();
  crew = await launchCrew();
});

after(async () => {
  await crew?.close();
  await site?.close();
});

const address = () => crew.window.getByRole("textbox", { name: "Address" });

async function openBrowserTab() {
  await crew.window.getByRole("button", { name: /^New tab/ }).click();
  await crew.window.getByRole("button", { name: "Browser", exact: true }).click();
  await address().waitFor({ state: "visible" });
}

async function onlyGuest(): Promise<number> {
  const guest = await waitFor(async () => {
    const all = await guests(crew.app);
    return all.length === 1 ? all[0] : undefined;
  });
  return guest.id;
}

test("a new tab loads what is typed into the address bar", async () => {
  await openBrowserTab();
  // A blank tab puts the keyboard in the bar.
  await waitFor(() => address().evaluate((el) => el === document.activeElement));
  await address().fill(site.url("/page/first"));
  await address().press("Enter");
  const id = await onlyGuest();
  await waitFor(async () => (await guestEval<string>(crew.app, id, "document.title")) === "first");
  await waitFor(async () => (await address().inputValue()) === site.url("/page/first"));
  await crew.window.getByRole("tab", { name: "first" }).waitFor();
});

test("back and forward follow the toolbar and ⌘[ / ⌘] from inside the page", async () => {
  const id = await onlyGuest();
  await guestEval(crew.app, id, `location.href = ${JSON.stringify(site.url("/page/second"))}`, true);
  await waitFor(async () => (await guestEval<string>(crew.app, id, "document.title")) === "second");

  await crew.window.getByRole("button", { name: "Back" }).click();
  await waitFor(async () => (await guestEval<string>(crew.app, id, "document.title")) === "first");

  await pressInGuest(crew.app, id, { key: "]", modifiers: [MOD] });
  await waitFor(async () => (await guestEval<string>(crew.app, id, "document.title")) === "second");

  await pressInGuest(crew.app, id, { key: "[", modifiers: [MOD] });
  await waitFor(async () => (await guestEval<string>(crew.app, id, "document.title")) === "first");
});

test("⌘L from inside the page takes the keyboard to the address bar", async () => {
  const id = await onlyGuest();
  await pressInGuest(crew.app, id, { key: "l", modifiers: [MOD] });
  await waitFor(() => address().evaluate((el) => el === document.activeElement));
  // The guest may take focus back a frame later; the bar keeps asking for a few frames.
  await waitFor(() =>
    address().evaluate((el) => {
      const input = el as HTMLInputElement;
      return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length;
    }),
  );
});
