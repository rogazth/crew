import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowClockwiseIcon, FolderOpenIcon } from "@phosphor-icons/react";
import { Button } from "../chrome/kit";
import { useCommands } from "../hooks/useCommand";
import { FILES_PARTITION, fileView, previewRoot } from "../lib/browser/files";
import { createGuest, type Guest, type GuestEvents } from "../lib/browser/webview";
import { commandKeys } from "../lib/commands";
import { browserHost, filesHost } from "../lib/host";
import { FileEditor } from "./FileEditor";
import { ImageView } from "./ImageView";
import type { ProjectFile } from "../lib/types";

type Props = {
  path: string;
  relative: string;
  files: ProjectFile[];
  onOpenPath: (path: string) => void;
};

type Mode = "preview" | "source";

/** What each page file was last shown as, so coming back to its tab keeps it. */
const modes = new Map<string, Mode>();

/** A file tab: pages and media render, with an HTML or SVG file's source a toggle away; text opens in the editor. */
export function FileView(props: Props) {
  const view = fileView(props.relative);
  const [mode, setMode] = useState<Mode>(() => modes.get(props.path) ?? "preview");
  const choose = (next: Mode) => {
    modes.set(props.path, next);
    setMode(next);
  };

  if (view === "text") return <FileEditor {...props} />;
  if (view === "image") return <ImageView path={props.path} relative={props.relative} actions={<RevealButton path={props.path} />} />;
  const toggle = view === "page" ? <ModeToggle mode={mode} onChange={choose} /> : null;
  if (view === "page" && mode === "source") return <FileEditor {...props} actions={toggle} />;
  return <FilePreview path={props.path} relative={props.relative} actions={toggle} />;
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const options: [Mode, string][] = [
    ["preview", "Preview"],
    ["source", "Source"],
  ];
  return (
    <div role="radiogroup" aria-label="Show as" className="-mr-2 inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-card p-0.5">
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          onClick={() => onChange(value)}
          className="flex h-6 items-center rounded-[5px] px-2 text-[12px] text-kumo-subtle outline-none transition-colors hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-focus/50 aria-checked:bg-kumo-base aria-checked:text-kumo-default aria-checked:shadow-sm"
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const HEADER_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-kumo-subtle hover:bg-hover hover:text-kumo-default";

/** Reveals the file in Finder. */
function RevealButton({ path }: { path: string }) {
  const host = filesHost();
  if (!host) return null;
  return (
    <button type="button" aria-label="Show in Finder" title="Show in Finder" onClick={() => void host.reveal(path)} className={HEADER_BUTTON}>
      <FolderOpenIcon className="size-4" />
    </button>
  );
}

const IGNORE: GuestEvents = {
  attach: () => {},
  navigate: () => {},
  start: () => {},
  loading: () => {},
  title: () => {},
  favicon: () => {},
  fail: () => {},
  gone: () => {},
  devtools: () => {},
  media: () => {},
  focus: () => {},
  found: () => {},
};

/**
 * The file rendered by Chromium, in the previews' own session, served from the
 * folder it was opened from so its relative links load. Main reloads it when
 * the file changes on disk.
 */
function FilePreview({ path, relative, actions }: { path: string; relative: string; actions: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const guest = useRef<Guest | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const root = previewRoot(path, relative);

  useEffect(() => {
    const host = filesHost();
    const container = box.current;
    if (!host || !container) {
      setProblem("Previews need the desktop app.");
      return;
    }
    let gone = false;
    void host
      .url(root, path)
      .then((url) => {
        if (gone) return;
        if (!url) {
          setProblem("This file can't be previewed.");
          return;
        }
        guest.current = createGuest(container, url, FILES_PARTITION, {
          ...IGNORE,
          fail: (failure) => {
            // -3 is a load cut short by the next one, a reload over a reload.
            if (failure.isMainFrame && failure.errorCode !== -3) setProblem(failure.errorDescription || "It didn't load.");
          },
          gone: () => setProblem("The preview stopped."),
        });
      })
      .catch((error: unknown) => !gone && setProblem(String(error)));
    return () => {
      gone = true;
      guest.current?.destroy();
      guest.current = null;
    };
  }, [root, path]);

  const reload = () => {
    setProblem(null);
    guest.current?.reload();
  };
  useCommands({
    "browser-reload": reload,
    "browser-hard-reload": () => guest.current?.hardReload(),
    "browser-devtools": () => {
      const id = guest.current?.webContentsId();
      if (id != null) void browserHost()?.toggleDevTools(id);
    },
  });

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4 text-text-muted">
        <span className="truncate">{relative}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Reload"
            title={`Reload (${commandKeys("browser-reload")})`}
            onClick={reload}
            className={HEADER_BUTTON}
          >
            <ArrowClockwiseIcon className="size-4" />
          </button>
          <RevealButton path={path} />
          {actions}
        </span>
      </div>
      <div ref={box} className="relative min-h-0 flex-1">
        {problem && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
            <p className="max-w-sm text-text-muted">{problem}</p>
            <Button onClick={reload}>Try again</Button>
          </div>
        )}
      </div>
    </div>
  );
}
