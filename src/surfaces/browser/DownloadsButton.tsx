import { Popover } from "@base-ui/react/popover";
import { ArrowDownToLineIcon, FolderIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { useDownloads } from "../../hooks/useBrowserSignals";
import type { DownloadInfo } from "../../lib/browser/bridge";
import { downloads, downloadStatus, isRunning, overallProgress, progressOf } from "../../lib/browser/downloads";
import { browserHost } from "../../lib/host";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * The toolbar's download button, there once anything was downloaded in this
 * window: a ring while files come in, and the list of them under it.
 */
export function DownloadsButton({ open, onOpenChange }: Props) {
  const list = useDownloads();
  // Why an open or a reveal failed, by download, until the list closes.
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  if (list.length === 0) return null;
  const running = list.some(isRunning);
  const progress = overallProgress(list);

  const act = (info: DownloadInfo, action: "open" | "reveal" | "cancel") => {
    void browserHost()
      ?.downloadAction(info.id, action)
      .then((problem) => setProblems((current) => ({ ...current, [info.id]: problem })))
      .catch(() => {});
    if (action === "open") onOpenChange(false);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setProblems({});
        onOpenChange(next);
      }}
      modal={false}
    >
      <Popover.Trigger
        aria-label="Downloads"
        title="Downloads"
        // A toolbar click keeps the keyboard where it was: in the page or in the bar.
        onMouseDown={(event) => event.preventDefault()}
        className="relative flex size-7 shrink-0 items-center justify-center rounded-md text-icon outline-none transition-colors hover:bg-hover hover:text-text data-popup-open:bg-selected data-popup-open:text-text"
      >
        {running && <ProgressRing value={progress} />}
        <ArrowDownToLineIcon className={running ? "size-3" : "size-4"} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Popover.Popup
            initialFocus={false}
            className="flex max-h-[min(420px,70vh)] w-80 origin-(--transform-origin) flex-col overflow-hidden rounded-xl bg-surface text-text shadow-float outline-none transition-[opacity,scale] duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
          >
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-hairline pr-1.5 pl-3">
              <Popover.Title className="text-[12px] font-medium text-text-muted">Downloads</Popover.Title>
              <button
                type="button"
                disabled={list.every(isRunning)}
                onClick={() => downloads.clearFinished()}
                className="h-6 rounded-md px-2 text-[12px] text-text-muted outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50 disabled:pointer-events-none disabled:opacity-40"
              >
                Clear
              </button>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto p-1">
              {list.map((info) => (
                <Row key={info.id} info={info} problem={problems[info.id] || null} onAct={(action) => act(info, action)} />
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({
  info,
  problem,
  onAct,
}: {
  info: DownloadInfo;
  problem: string | null;
  onAct: (action: "open" | "reveal" | "cancel") => void;
}) {
  const running = isRunning(info);
  const done = info.state === "completed";
  const failed = info.state === "cancelled" || info.state === "interrupted";
  const fraction = progressOf(info);
  const name = info.filename || "Download";
  return (
    <li className="group relative flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-hover">
      {/* The whole row opens a finished file; the buttons at its end sit above this. */}
      {done && (
        <button
          type="button"
          aria-label={`Open ${name}`}
          onClick={() => onAct("open")}
          className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
        />
      )}
      <FileTypeIcon name={name} className={`size-5 ${failed ? "opacity-40" : ""}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`truncate ${failed ? "text-text-muted line-through decoration-text-muted/60" : ""}`} title={name}>
          {name}
        </span>
        {running && (
          <span aria-hidden className="relative h-1 overflow-hidden rounded-full bg-fill">
            {fraction === null ? (
              <span className="browser-progress absolute inset-0" />
            ) : (
              <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-200" style={{ width: `${fraction * 100}%` }} />
            )}
          </span>
        )}
        <span className={`truncate text-[11px] tabular-nums ${problem || info.state === "interrupted" ? "text-danger" : "text-text-muted"}`}>
          {problem ?? downloadStatus(info)}
        </span>
      </div>
      <div className="relative flex shrink-0 items-center">
        {running && <RowButton label={`Cancel ${name}`} icon={XIcon} onClick={() => onAct("cancel")} />}
        {done && <RowButton label="Show in Finder" icon={FolderIcon} onClick={() => onAct("reveal")} />}
        {failed && <RowButton label={`Remove ${name}`} icon={XIcon} onClick={() => downloads.remove(info.id)} />}
      </div>
    </li>
  );
}

function RowButton({ label, icon: Glyph, onClick }: { label: string; icon: typeof XIcon; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-icon outline-none transition-colors hover:bg-selected hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      <Glyph className="size-3.5" />
    </button>
  );
}

const RING = 2 * Math.PI * 9;

/** How far the running downloads are, around the button; a turning arc when their size is unknown. */
function ProgressRing({ value }: { value: number | null }) {
  return (
    <svg aria-hidden viewBox="0 0 22 22" className={`absolute size-[22px] -rotate-90 ${value === null ? "animate-spin" : ""}`}>
      <circle cx="11" cy="11" r="9" fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={2} />
      <circle
        cx="11"
        cy="11"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={RING}
        strokeDashoffset={RING * (1 - (value ?? 0.25))}
        className="transition-[stroke-dashoffset] duration-200"
      />
    </svg>
  );
}
