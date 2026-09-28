import { ClockIcon, CornerLeftUpIcon, FolderGit2Icon, FolderIcon, FolderOpenIcon, LoaderCircleIcon, WifiOffIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import * as api from "../lib/api";
import { reconnect, type EnvLink } from "../lib/client/registry";
import type { DirListing } from "../lib/protocol";
import { errorText } from "../lib/remotes";
import { joinPath, leafOf, parentOf, prettyPath, splitTyped } from "../lib/remotePath";
import { recentKey } from "../lib/remoteUi";
import { Button } from "./kit";
import { Kbd } from "./Kbd";

type Row = {
  key: string;
  label: string;
  detail?: string;
  /** Absolute, on the machine. */
  path: string;
  kind: "here" | "recent" | "up" | "dir";
  repo: boolean;
};

type Listing = { state: "loading" } | { state: "ready"; listing: DirListing } | { state: "error"; message: string };

type Props = {
  env: EnvLink;
  /** An absolute path on `env`. Rejects with why it could not open. */
  onOpen: (path: string) => Promise<void>;
};

/**
 * A folder on a machine that has no Finder, picked from the keyboard. The path
 * completes like a shell: "code/sto" lists code/ for names that start with
 * "sto", ⇥ goes into the highlighted folder, ↵ opens a repo or goes into a
 * folder that is not one, ⌘↵ opens exactly what is typed.
 */
export function FolderBrowser({ env, onOpen }: Props) {
  const home = env.info?.home ?? env.home ?? "/";
  const [raw, setRaw] = useState("~/");
  /** The highlighted row, for the listing it was picked in: a new folder or filter starts it over. */
  const [pick, setPick] = useState<{ at: string; index: number } | null>(null);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [recents, setRecents] = useState<string[]>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const online = env.status === "online" && !env.mismatch;

  const { dir, filter } = splitTyped(raw, home);
  const current = listings[dir];

  useEffect(() => {
    void api.stateGet(recentKey(env.id)).then(
      (value) => {
        const parsed = JSON.parse(value ?? "[]") as unknown;
        if (Array.isArray(parsed)) setRecents(parsed.filter((item): item is string => typeof item === "string"));
      },
      () => {},
    );
  }, [env.id]);

  // The folder being typed into is listed once, and kept while the user goes up and down.
  const listed = current !== undefined && current.state !== "error";
  useEffect(() => {
    if (!online || listed) return;
    let cancelled = false;
    void api.listDir(env.id, dir).then(
      (listing) => !cancelled && setListings((prev) => ({ ...prev, [dir]: { state: "ready", listing } })),
      (reason: unknown) => !cancelled && setListings((prev) => ({ ...prev, [dir]: { state: "error", message: errorText(reason) } })),
    );
    return () => {
      cancelled = true;
    };
  }, [dir, env.id, listed, online]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const listing = current?.state === "ready" ? current.listing : null;
    if (raw === "~/" || raw === "") {
      for (const path of recents) {
        out.push({ key: `r:${path}`, label: leafOf(path), detail: prettyPath(path, home), path, kind: "recent", repo: true });
      }
    }
    if (listing?.repo && !filter) {
      out.push({ key: "here", label: `Open ${leafOf(dir) || dir}`, detail: prettyPath(dir, home), path: dir, kind: "here", repo: true });
    }
    if (dir !== "/" && dir !== home) out.push({ key: "up", label: "..", path: parentOf(dir), kind: "up", repo: false });
    if (listing) {
      const hidden = filter.startsWith(".");
      for (const entry of listing.entries) {
        if (entry.name.startsWith(".") && !hidden) continue;
        if (filter && !entry.name.toLowerCase().startsWith(filter.toLowerCase())) continue;
        out.push({ key: `d:${entry.path}`, label: entry.name, path: entry.path, kind: "dir", repo: entry.repo });
      }
    }
    return out;
  }, [current, dir, filter, home, raw, recents]);

  // Inside a folder the cursor starts on its first child, not on "..".
  const at = `${dir}\n${filter}`;
  const cursor = pick?.at === at ? Math.min(pick.index, Math.max(rows.length - 1, 0)) : Math.max(rows.findIndex((row) => row.kind !== "up"), 0);
  const setCursor = (next: number | ((value: number) => number)) =>
    setPick({ at, index: typeof next === "function" ? next(cursor) : next });
  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  async function open(path: string) {
    setOpening(true);
    setError(null);
    try {
      await onOpen(path);
      const next = [path, ...recents.filter((item) => item !== path)].slice(0, 6);
      void api.stateSet(recentKey(env.id), JSON.stringify(next)).catch(() => {});
    } catch (reason) {
      setError(errorText(reason));
      setOpening(false);
    }
  }

  function browse(path: string) {
    setError(null);
    setRaw(`${prettyPath(path, home).replace(/\/$/, "")}/`);
    input.current?.focus();
  }

  function choose(row: Row) {
    if (row.kind === "up") browse(row.path);
    else if (row.kind === "here" || row.kind === "recent" || row.repo) void open(row.path);
    else browse(row.path);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const row = rows[cursor];
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => Math.min(value + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => Math.max(value - 1, 0));
    } else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      if (row && row.kind !== "here") browse(row.path);
    } else if (event.key === "Backspace" && raw.endsWith("/") && !filter && dir !== "/") {
      const field = event.currentTarget;
      if (field.selectionStart !== field.selectionEnd || field.selectionStart !== raw.length) return;
      event.preventDefault();
      browse(parentOf(dir));
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.metaKey || event.ctrlKey) void open(filter ? joinPath(dir, filter) : dir);
      else if (row) choose(row);
    }
  }

  const loading = online && (current === undefined || current.state === "loading");
  const failed = current?.state === "error" ? current.message : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <label
        className={`mx-3 mt-3 flex h-9 shrink-0 items-center gap-0.5 rounded-md bg-canvas px-3 font-mono text-[12.5px] ring ring-border focus-within:ring-[1.5px] focus-within:ring-focus/50 ${online ? "" : "opacity-50"}`}
      >
        <span className="shrink-0 text-text-muted">{env.name}:</span>
        <input
          ref={input}
          value={raw}
          autoFocus
          disabled={!online || opening}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={`Folder on ${env.name}`}
          onChange={(event) => {
            setError(null);
            setRaw(event.target.value);
          }}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-placeholder"
        />
        {(loading || opening || env.status === "connecting") && <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-text-muted" />}
      </label>

      {!online ? (
        <Offline env={env} />
      ) : (
        <div ref={list} className="max-h-[320px] min-h-24 flex-1 overflow-y-auto p-1.5">
          {rows.map((row, index) => {
            const header = heading(rows, index, raw);
            const Glyph =
              row.kind === "recent"
                ? ClockIcon
                : row.kind === "up"
                  ? CornerLeftUpIcon
                  : row.kind === "here"
                    ? FolderOpenIcon
                    : row.repo
                      ? FolderGit2Icon
                      : FolderIcon;
            const action = row.kind === "up" ? null : row.kind === "dir" && !row.repo ? "browse" : "open";
            return (
              <div key={row.key}>
                {header && <div className="px-2.5 pt-2 pb-1 text-[11px] text-text-muted">{header}</div>}
                <button
                  type="button"
                  data-index={index}
                  onMouseMove={() => setCursor(index)}
                  onClick={() => choose(row)}
                  className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left ${index === cursor ? "bg-hover" : ""}`}
                >
                  <Glyph className="size-4 shrink-0 text-icon" />
                  <span className="min-w-0 truncate">{row.label}</span>
                  {row.detail && <span className="min-w-0 truncate font-mono text-[11px] text-text-muted">{row.detail}</span>}
                  <span className="flex-1" />
                  {row.repo && row.kind === "dir" && index !== cursor && <span className="text-[11px] text-text-muted">git</span>}
                  {index === cursor && action && (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-text-muted">
                      {action} <Kbd keys="↵" />
                    </span>
                  )}
                </button>
              </div>
            );
          })}
          {rows.length === 0 && !loading && (
            <p className="px-2.5 py-6 text-center text-text-muted">
              {failed ?? "No folder here."} <Kbd keys="⌘↵" /> opens <span className="font-mono">{prettyPath(filter ? joinPath(dir, filter) : dir, home)}</span> anyway.
            </p>
          )}
        </div>
      )}
      {error && <p className="px-4 pb-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

function Offline({ env }: { env: EnvLink }) {
  const connecting = env.status === "connecting";
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {connecting ? <LoaderCircleIcon className="size-5 animate-spin text-text-muted" /> : <WifiOffIcon className="size-5 text-danger" />}
      <p className="font-medium">{connecting ? `Connecting to ${env.name}…` : env.mismatch ? `${env.name} needs an update` : `${env.name} is offline`}</p>
      <p className="max-w-72 text-[12px] text-text-muted">
        {env.mismatch
          ? "Its crewd speaks another protocol. Update it from Settings › Environments."
          : (env.error ?? `Crew can't reach ${env.host ?? "the machine"} on your tailnet. Check that it is on and Tailscale is running.`)}
      </p>
      {!connecting && !env.mismatch && (
        <Button variant="secondary" onClick={() => reconnect(env.id)}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** The quiet label above a run of rows: "Recent" over the recents, the folder over its children. */
function heading(rows: Row[], index: number, raw: string): string | null {
  const row = rows[index];
  const before = rows[index - 1];
  if (!row) return null;
  if (row.kind === "recent" && before?.kind !== "recent") return "Recent";
  if (row.kind === "dir" && before?.kind !== "dir" && (raw === "~/" || raw === "")) return "Home";
  return null;
}
