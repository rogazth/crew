import { ArrowLeftIcon, ChevronRightIcon, FolderOpenIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ConnectionLabel, EnvTile } from "./EnvBits";
import { whereOf } from "../lib/envText";
import { FolderBrowser } from "./FolderBrowser";
import { Kbd } from "./Kbd";
import { Footer, Overlay } from "./kit";
import { useEnvLinks } from "../hooks/useEnvLinks";
import * as api from "../lib/api";
import { LOCAL, type EnvLink } from "../lib/client/registry";
import { LAST_MACHINE } from "../lib/remoteUi";
import { nameFromPath } from "../lib/workspaces";

type Props = {
  /** A machine to go straight to its folders, as Settings' "Open workspace" does. */
  start: string | null;
  onThisMac: () => void;
  onOpen: (envId: string, path: string, name: string) => Promise<void>;
  onAdd: () => void;
  onClose: () => void;
};

/** ⌘O once there is a remote: where the workspace lives, then which folder. */
export function MachinePalette({ start, onThisMac, onOpen, onAdd, onClose }: Props) {
  const links = useEnvLinks();
  const machines = links.filter((link) => link.id === LOCAL).concat(links.filter((link) => link.id !== LOCAL));
  const [picked, setPicked] = useState<string | null>(start);
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const env = picked ? (links.find((link) => link.id === picked) ?? null) : null;
  const addIndex = machines.length;

  // The machine picked last time is where the cursor starts.
  useEffect(() => {
    let cancelled = false;
    void api.stateGet(LAST_MACHINE).then(
      (last) => {
        if (cancelled || !last) return;
        const index = machines.findIndex((link) => link.id === last);
        if (index >= 0) setCursor(index);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // Once, on open: the list itself changes with every latency tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!env) root.current?.focus();
  }, [env]);

  function choose(index: number) {
    if (index === addIndex) {
      onAdd();
      return;
    }
    const link = machines[index];
    if (!link || !selectable(link)) return;
    void api.stateSet(LAST_MACHINE, link.id).catch(() => {});
    if (link.id === LOCAL) onThisMac();
    else setPicked(link.id);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (env) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (start) onClose();
        else setPicked(null);
      }
      return;
    }
    const digit = Number(event.key);
    if (event.metaKey && digit >= 1 && digit <= machines.length) {
      event.preventDefault();
      event.stopPropagation();
      choose(digit - 1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => Math.min(value + 1, addIndex));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => Math.max(value - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      choose(cursor);
    }
  }

  return (
    <Overlay onClose={onClose} width="w-[520px]" label="Open workspace">
      <div ref={root} tabIndex={-1} onKeyDown={onKeyDown} className="flex min-h-0 flex-col outline-none">
        {env ? (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-3">
              <button
                type="button"
                onClick={() => (start ? onClose() : setPicked(null))}
                aria-label="Back"
                className="grid size-7 place-items-center rounded-md text-icon hover:bg-hover hover:text-text"
              >
                <ArrowLeftIcon className="size-4" />
              </button>
              <span className="font-medium">{env.name}</span>
              <ChevronRightIcon className="size-3.5 text-placeholder" />
              <span className="text-text-muted">Pick a folder</span>
              <span className="flex-1" />
              <ConnectionLabel link={env} />
            </div>
            <FolderBrowser env={env} onOpen={(path) => onOpen(env.id, path, nameFromPath(path) || env.name)} />
            <Footer hints={[["↵", "Open"], ["⇥", "Complete"], ["⌘↵", "Open typed path"], ["esc", start ? "Close" : "Back"]]} />
          </>
        ) : (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2 px-4">
              <FolderOpenIcon className="size-4.5 text-icon" />
              <span className="text-[15px] font-medium">Open workspace on…</span>
            </div>
            <div role="listbox" aria-label="Machines" className="border-t border-hairline p-1.5">
              {machines.map((link, index) => {
                const disabled = !selectable(link);
                const local = link.id === LOCAL;
                return (
                  <button
                    key={link.id}
                    type="button"
                    role="option"
                    aria-selected={index === cursor}
                    aria-disabled={disabled}
                    onMouseMove={() => setCursor(index)}
                    onClick={() => choose(index)}
                    className={`flex h-12 w-full items-center gap-3 rounded-lg px-2.5 text-left ${index === cursor ? "bg-hover" : ""} ${
                      disabled ? "cursor-default opacity-50" : ""
                    }`}
                  >
                    <EnvTile link={link} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{link.name}</span>
                      <span className="truncate text-[12px] text-text-muted">
                        {local
                          ? ["Local", link.info?.hostname].filter(Boolean).join(" · ")
                          : [whereOf(link), link.info?.os].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="flex-1" />
                    {!local && <ConnectionLabel link={link} />}
                    {index < 9 && <Kbd keys={`⌘${index + 1}`} />}
                  </button>
                );
              })}
            </div>
            <div className="border-t border-hairline p-1.5">
              <button
                type="button"
                onMouseMove={() => setCursor(addIndex)}
                onClick={onAdd}
                className={`flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left text-text-muted hover:text-text ${
                  cursor === addIndex ? "bg-hover text-text" : ""
                }`}
              >
                <PlusIcon className="size-4" />
                Add a machine…
                <span className="flex-1" />
                <span className="text-[11px]">Settings</span>
              </button>
            </div>
            <Footer hints={[["↑↓", "Move"], ["↵", "Choose"], ["esc", "Close"]]} />
          </>
        )}
      </div>
    </Overlay>
  );
}

/** This Mac always; a remote once it answers and speaks this app's protocol. */
function selectable(link: EnvLink): boolean {
  return link.id === LOCAL || (link.status !== "offline" && !link.mismatch);
}
