import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { CHANNELS, type PagePrompt, type PromptAnswer } from "../../src/lib/browser/bridge";

/**
 * Questions a page puts to the person: a permission, a site's sign-in,
 * another app. Each is shown over the page it came from and waits for the
 * window's answer; a page that navigates away or closes takes its questions
 * with it, answered with null.
 */

/** Distributes Omit over the union, so each kind keeps its own fields. */
type Ask<T> = T extends PagePrompt ? Omit<T, "id" | "webContentsId"> : never;
export type PromptRequest = Ask<PagePrompt>;

type Pending = { host: WebContents; pageId: number; resolve: (answer: PromptAnswer) => void };

const pending = new Map<string, Pending>();
/** A page asks at most this many questions at once; past it, the rest are answered no. */
const MAX_PER_PAGE = 8;

/** Where a page's questions go: the window that embeds it, over the page with this webContents id. */
export type PromptTarget = { host: WebContents; pageId: number };

export function ask(target: PromptTarget, request: PromptRequest): Promise<PromptAnswer> {
  const { host, pageId } = target;
  if (host.isDestroyed()) return Promise.resolve(null);
  let open = 0;
  for (const entry of pending.values()) if (entry.pageId === pageId) open++;
  if (open >= MAX_PER_PAGE) return Promise.resolve(null);
  const id = randomUUID();
  return new Promise((resolve) => {
    pending.set(id, { host, pageId, resolve });
    host.send(CHANNELS.prompt, { ...request, id, webContentsId: pageId } as PagePrompt);
  });
}

/** From the window that was asked, and no other: the id alone proves nothing. */
export function answer(sender: WebContents, id: unknown, value: unknown): void {
  if (typeof id !== "string") return;
  const entry = pending.get(id);
  if (!entry || entry.host !== sender) return;
  pending.delete(id);
  entry.resolve(parseAnswer(value));
}

/** Every question a page left open, answered null and taken off the window. */
export function dropPrompts(pageId: number): void {
  for (const [id, entry] of pending) {
    if (entry.pageId !== pageId) continue;
    pending.delete(id);
    entry.resolve(null);
    if (!entry.host.isDestroyed()) entry.host.send(CHANNELS.promptGone, id);
  }
}

/** A window that closes answers nothing more. */
export function dropHost(host: WebContents): void {
  for (const [id, entry] of pending) {
    if (entry.host !== host) continue;
    pending.delete(id);
    entry.resolve(null);
  }
}

const FIELD = 1024;

/** The answer arrives from the renderer, so only the shapes a prompt can take get through. */
export function parseAnswer(value: unknown): PromptAnswer {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.allow === "boolean") return { allow: v.allow, remember: v.remember === true };
  if (typeof v.username === "string" && typeof v.password === "string") {
    if (v.username.length > FIELD || v.password.length > FIELD) return null;
    return { username: v.username, password: v.password };
  }
  if (typeof v.open === "boolean") return { open: v.open };
  if (typeof v.settings === "boolean") return { settings: v.settings };
  return null;
}
