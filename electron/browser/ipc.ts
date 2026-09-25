import { ipcMain } from "electron";
import type { KeyboardLayout, LiveCommand } from "../../src/lib/keymap";
import { capSnapshot, parseSnapshot } from "../../src/lib/browser/snapshot";
import { CHANNELS, partitionFor } from "../../src/lib/browser/bridge";
import { importCookies } from "./cookies";
import { ownedGuest, prepareRestore, readyPageSession, setKeyboardLayout, setLiveCommands } from "./guests";

const TOKEN = /^[A-Za-z0-9-]{1,64}$/;
const FAVICON_BYTES = 128 * 1024;
const FAVICON_CACHE = 256;
/** Insertion-ordered, so the oldest entry is the first key. */
const favicons = new Map<string, Promise<string | null>>();

/** Fetched through the page's own session, so an icon behind a login comes back the same as in the page. */
async function fetchFavicon(url: string, partition: string): Promise<string | null> {
  if (url.startsWith("data:image/")) return url.length <= FAVICON_BYTES * 2 ? url : null;
  if (!/^https?:\/\//i.test(url)) return null;
  const response = await (await readyPageSession(partition)).fetch(url);
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || !type.startsWith("image/")) return null;
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > FAVICON_BYTES) return null;
  return `data:${type};base64,${body.toString("base64")}`;
}

function favicon(url: string, partition: string): Promise<string | null> {
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

  ipcMain.handle(CHANNELS.snapshot, (event, id: unknown) => {
    const guest = typeof id === "number" ? ownedGuest(event.sender, id) : null;
    if (!guest) return null;
    const history = guest.navigationHistory;
    return capSnapshot({ entries: history.getAllEntries(), index: history.getActiveIndex() });
  });

  /** Into one workspace's pages only: each workspace keeps its own sign-ins. */
  ipcMain.handle(CHANNELS.importCookies, async (_event, workspaceId: unknown, list: unknown) => {
    const partition = typeof workspaceId === "string" ? partitionFor(workspaceId) : null;
    if (!partition) return { imported: 0, failed: 0 };
    return importCookies(await readyPageSession(partition), list);
  });

  ipcMain.handle(CHANNELS.favicon, (_event, url: unknown, workspaceId: unknown) => {
    const partition = typeof workspaceId === "string" ? partitionFor(workspaceId) : null;
    return typeof url === "string" && partition ? favicon(url, partition) : null;
  });

  /** Takes the daemon's row as-is; parsing it here means main never trusts a renderer-built stack. */
  ipcMain.handle(CHANNELS.prepareRestore, (_event, token: unknown, entriesJson: unknown, index: unknown) => {
    if (typeof token !== "string" || !TOKEN.test(token)) return false;
    if (typeof entriesJson !== "string" || typeof index !== "number") return false;
    const parsed = parseSnapshot(entriesJson, index);
    const safe = parsed && capSnapshot(parsed);
    if (!safe) return false;
    prepareRestore(token, safe);
    return true;
  });
}
