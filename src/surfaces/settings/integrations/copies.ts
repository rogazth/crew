// MOCKUP: the connector copies in the providers' own configs (outside.tsx,
// install.tsx). State lives in memory and every step is a timer.
import { useSyncExternalStore } from "react";
import { LOCAL } from "../../../lib/client/registry";

/* ── Mock store ─────────────────────────────────────────────────────── */

export type CopyState = "adding" | "needs-auth" | "signing-in" | "connected";
export type Copy = { url: string; envId: string; provider: string; state: CopyState };

let copies: Copy[] = [];
const listeners = new Set<() => void>();
const set = (next: Copy[]) => {
  copies = next;
  listeners.forEach((l) => l());
};
export const useCopies = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => copies,
  );
export const same = (a: Copy, b: Omit<Copy, "state">) => a.url === b.url && a.envId === b.envId && a.provider === b.provider;
const move = (key: Omit<Copy, "state">, state: CopyState) => set(copies.map((c) => (same(c, key) ? { ...c, state } : c)));

export const mock = {
  add(url: string, envId: string, providers: string[]) {
    set([...copies, ...providers.map((provider): Copy => ({ url, envId, provider, state: "adding" }))]);
    providers.forEach((provider, i) => window.setTimeout(() => move({ url, envId, provider }, "needs-auth"), 700 + i * 350));
  },
  signIn(key: Omit<Copy, "state">) {
    move(key, "signing-in");
    window.setTimeout(() => move(key, "connected"), 1600);
  },
  remove: (key: Omit<Copy, "state">) => set(copies.filter((c) => !same(c, key))),
};

/** Where each provider keeps its user-wide servers: what the sheet says it writes. */
export const CONFIG: Record<string, string> = {
  claude: "~/.claude.json",
  codex: "~/.codex/config.toml",
  cursor: "~/.cursor/mcp.json",
  opencode: "~/.config/opencode/opencode.json",
  grok: "~/.grok/config.toml",
};

/** Mock: which providers a machine has. A remote without Grok shows the row it can't take. */
export const installed = (envId: string, provider: string) => envId === LOCAL || provider !== "grok";
