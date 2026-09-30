import { ipcMain } from "electron";
import type { KeyboardLayout, LiveCommand } from "../../src/lib/keymap";
import { capSnapshot, parseSnapshot } from "../../src/lib/browser/snapshot";
import { CHANNELS, isIncognitoPartition, partitionFor } from "../../src/lib/browser/bridge";
import { isMachineAlias } from "../../src/lib/browser/machines";
import { importCookies } from "./cookies";
import { dockBounds, dockDevTools, placeDevTools, undockDevTools } from "./devtools";
import { downloadAction, setAskWhereToSave } from "./downloads";
import {
  ownedGuest,
  pageSession,
  prepareRestore,
  setGuestMachine,
  setKeyboardLayout,
  setLiveCommands,
  setSitePermissions,
} from "./guests";
import { answer } from "./prompts";
import { bindTab } from "./tab-guests";

const TOKEN = /^[A-Za-z0-9-]{1,64}$/;
const TAB_ID = /^browser:[A-Za-z0-9-]{1,64}$/;
const FAVICON_BYTES = 128 * 1024;
const FAVICON_CACHE = 256;
/** Insertion-ordered, so the oldest entry is the first key. */
const favicons = new Map<string, Promise<string | null>>();

/** Fetched through the page's own session, so an icon behind a login comes back the same as in the page. */
async function fetchFavicon(url: string, partition: string): Promise<string | null> {
  if (url.startsWith("data:image/")) return url.length <= FAVICON_BYTES * 2 ? url : null;
  if (!/^https?:\/\//i.test(url)) return null;
  const response = await pageSession(partition).fetch(url);
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || !type.startsWith("image/")) return null;
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > FAVICON_BYTES) return null;
  return `data:${type};base64,${body.toString("base64")}`;
}

function favicon(url: string, partition: string): Promise<string | null> {
  // What an incognito page showed is not kept past it, even in memory.
  if (isIncognitoPartition(partition)) return fetchFavicon(url, partition).catch(() => null);
  const key = `${partition} ${url}`;
  const cached = favicons.get(key);
  if (cached) return cached;
  const pending = fetchFavicon(url, partition).catch(() => null);
  favicons.set(key, pending);
  if (favicons.size > FAVICON_CACHE) favicons.delete(favicons.keys().next().value as string);
  return pending;
}

/** Keeps only well-formed entries: this list arrives from the renderer. */
function commandList(value: unknown): LiveCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const { id, keys, repeat } = item as Partial<LiveCommand>;
    if (typeof id !== "string") return [];
    const chord = typeof keys === "string" || (typeof keys === "object" && keys !== null && typeof keys.key === "string");
    if (!chord) return [];
    return [{ id, keys, repeat: repeat === true }];
  });
}

/** Keeps only short string entries: this map arrives from the renderer. */
function keyboardLayout(value: unknown): KeyboardLayout | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const layout: Record<string, string> = {};
  for (const [code, typed] of Object.entries(value).slice(0, 256)) {
    if (code.length <= 32 && typeof typed === "string" && typed.length <= 4) layout[code] = typed;
  }
  return layout;
}

export function registerBrowserIpc(): void {
  ipcMain.on(CHANNELS.commands, (event, list: unknown) => setLiveCommands(event.sender, commandList(list)));
  ipcMain.on(CHANNELS.keyboardLayout, (event, layout: unknown) => setKeyboardLayout(event.sender, keyboardLayout(layout)));

  ipcMain.on(CHANNELS.answer, (event, id: unknown, value: unknown) => answer(event.sender, id, value));
  ipcMain.on(CHANNELS.sitePermissions, (_event, decisions: unknown) => setSitePermissions(decisions));
  ipcMain.on(CHANNELS.downloadPrefs, (_event, ask: unknown) => setAskWhereToSave(ask === true));
  /** Resolves why the file could not open, or "" once it did. */
  ipcMain.handle(CHANNELS.downloadAction, (event, id: unknown, action: unknown) => downloadAction(event.sender, id, action));

  /** A hung page's process is ended; the window then builds it again. */
  ipcMain.handle(CHANNELS.kill, (event, id: unknown) => {
    const guest = typeof id === "number" ? ownedGuest(event.sender, id) : null;
    guest?.forcefullyCrashRenderer();
  });

  ipcMain.handle(CHANNELS.print, (event, id: unknown) => {
    const guest = typeof id === "number" ? ownedGuest(event.sender, id) : null;
    guest?.print();
  });

  /** Toggles, and answers whether DevTools are open afterwards. */
  ipcMain.handle(CHANNELS.devtools, (event, id: unknown) => {
    const guest = typeof id === "number" ? ownedGuest(event.sender, id) : null;
    if (!guest) return false;
    if (guest.isDevToolsOpened()) {
      guest.closeDevTools();
      return false;
    }
    guest.openDevTools({ mode: "detach" });
    return true;
  });

  /** Beside the page, over the panel at `bounds`; ones already open in a window of their own move there. */
  ipcMain.handle(CHANNELS.dockDevtools, (event, id: unknown, bounds: unknown) => {
    const guest = typeof id === "number" ? ownedGuest(event.sender, id) : null;
    const place = dockBounds(bounds);
    return guest && place ? dockDevTools(event.sender, guest, place) : false;
  });

  /** Null bounds hide them and answer with how they looked. */
  ipcMain.handle(CHANNELS.placeDevtools, (event, id: unknown, bounds: unknown) => {
    if (typeof id !== "number") return null;
    return placeDevTools(event.sender, id, bounds === null ? null : dockBounds(bounds));
  });

  ipcMain.handle(CHANNELS.closeDevtools, (event, id: unknown) => {
    if (typeof id === "number") undockDevTools(event.sender, id);
  });

  ipcMain.handle(CHANNELS.snapshot, (event, id: unknown) => {
    const guest = typeof id === "number" ? ownedGuest(event.sender, id) : null;
    if (!guest) return null;
    const history = guest.navigationHistory;
    return capSnapshot({ entries: history.getAllEntries(), index: history.getActiveIndex() });
  });

  // Only a guest this window embeds can be named as a tab's page: an agent's call must never reach the window itself.
  ipcMain.on(CHANNELS.pageGuest, (event, tab: unknown, id: unknown) => {
    if (typeof tab !== "string" || !TAB_ID.test(tab) || typeof id !== "number") return;
    const guest = ownedGuest(event.sender, id);
    if (guest) bindTab(tab, guest);
  });

  ipcMain.on(CHANNELS.guestMachine, (event, id: unknown, alias: unknown) => {
    const guest = typeof id === "number" ? ownedGuest(event.sender, id) : null;
    if (guest) setGuestMachine(guest, isMachineAlias(alias) ? alias : null);
  });

  /** Into every page's session, never an incognito one. */
  ipcMain.handle(CHANNELS.importCookies, (_event, list: unknown) => importCookies(pageSession(partitionFor()), list));

  ipcMain.handle(CHANNELS.favicon, (_event, url: unknown, incognito: unknown) =>
    typeof url === "string" ? favicon(url, partitionFor(incognito === true)) : null,
  );

  /** Takes the daemon's row as-is; parsing it here means main never trusts a renderer-built stack. */
  ipcMain.handle(CHANNELS.prepareRestore, (_event, token: unknown, entriesJson: unknown, index: unknown, machine: unknown) => {
    if (typeof token !== "string" || !TOKEN.test(token)) return false;
    if (typeof entriesJson !== "string" || typeof index !== "number") return false;
    const parsed = parseSnapshot(entriesJson, index);
    const safe = parsed && capSnapshot(parsed);
    if (!safe) return false;
    prepareRestore(token, safe, isMachineAlias(machine) ? machine : null);
    return true;
  });
}
