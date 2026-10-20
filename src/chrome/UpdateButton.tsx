// An app update as news, not an interruption: a mark at the rail's foot that
// walks through the update (available → downloading → ready) and opens what
// changed. `UpdateButton` takes the update as props; `RailUpdate` feeds it the
// real updater.
import { Popover } from "@base-ui/react/popover";
import { ArrowDownToLineIcon, RotateCwIcon, XIcon } from "lucide-react";
import { useUpdateActions, useUpdateState } from "../hooks/useUpdate";
import { dateLabel, sizeLabel, type ReleaseNote } from "../lib/update";
import { CrewGlyph } from "./CrewGlyph";
import { Button, IconButton } from "./kit";

export type UpdatePhase = "available" | "downloading" | "ready";

export type Release = {
  version: string;
  /** The version running now. */
  current: string;
  size: string | null;
  date: string | null;
  notes: readonly ReleaseNote[];
};

type UpdateProps = {
  release: Release;
  phase: UpdatePhase;
  /** Share downloaded, 0‥1. */
  progress: number;
  onDownload: () => void;
  onSkip: () => void;
  onRestart: () => void;
  onCancel?: () => void;
};

const KIND: Record<string, { label: string; tone: string }> = {
  new: { label: "New", tone: "bg-accent/12 text-accent" },
  improved: { label: "Better", tone: "bg-info/12 text-info" },
  fixed: { label: "Fixed", tone: "bg-success/12 text-success" },
};

/** The mark in the rail, on the real updater: nothing until a release is offered. */
export function RailUpdate() {
  const state = useUpdateState();
  const { download, skip, restart, cancel } = useUpdateActions();
  if (
    state.phase !== "available" &&
    state.phase !== "downloading" &&
    state.phase !== "staging" &&
    state.phase !== "ready"
  ) {
    return null;
  }
  const { offer } = state;
  const release: Release = {
    version: offer.version,
    current: offer.current,
    size: offer.size === null ? null : sizeLabel(offer.size),
    date: offer.date === null ? null : dateLabel(offer.date) || null,
    notes: offer.notes,
  };
  const phase: UpdatePhase = state.phase === "available" ? "available" : state.phase === "ready" ? "ready" : "downloading";
  const progress =
    state.phase === "downloading" ? (state.total ? state.received / state.total : 0) : state.phase === "available" ? 0 : 1;
  return <UpdateButton release={release} phase={phase} progress={progress} onDownload={download} onSkip={skip} onRestart={restart} onCancel={cancel} />;
}

export function UpdateButton(props: UpdateProps) {
  const { release, phase: update, progress } = props;
  const label =
    update === "ready"
      ? `Restart for Crew ${release.version}`
      : update === "downloading"
        ? `Downloading Crew ${release.version}, ${Math.round(progress * 100)}%`
        : `Crew ${release.version} available`;
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        title={label}
        data-tauri-drag-region="false"
        className={`relative grid size-9 shrink-0 place-items-center rounded-xl outline-none transition-[background-color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-focus/50 active:scale-95 ${
          update === "ready"
            ? "bg-accent text-inverse shadow-[0_6px_16px_-6px_var(--color-accent)]"
            : "bg-accent/12 text-accent hover:bg-accent/18"
        }`}
      >
        {update === "downloading" ? (
          <Ring value={progress} />
        ) : update === "ready" ? (
          <RotateCwIcon className="size-[17px]" />
        ) : (
          <ArrowDownToLineIcon className="size-[17px]" />
        )}
        {update === "available" && (
          <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-accent ring-2 ring-sidebar" />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="right" align="end" sideOffset={12} className="z-50">
          <Popover.Popup className="w-[360px] origin-(--transform-origin) overflow-hidden rounded-float bg-surface text-text shadow-float outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <ReleaseCard {...props} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** What changed, and the one thing to do about it. Shared with the About page. */
export function ReleaseCard({ release, phase: update, progress, onDownload, onSkip, onRestart, onCancel, onClose }: UpdateProps & { onClose?: () => void }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3 p-4 pb-3">
        <CrewGlyph className="size-9" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Crew {release.version}</span>
          <span className="text-[12px] text-text-muted">
            You have {release.current}
            {[release.size, release.date].filter(Boolean).map((part) => ` · ${part}`)}
          </span>
        </div>
        {onClose && <IconButton icon={XIcon} label="Close" className="size-7" onClick={onClose} />}
      </div>
      {release.notes.length > 0 && (
        <ul className="mx-3 flex max-h-64 flex-col gap-1 overflow-y-auto rounded-xl bg-card p-1.5">
          {release.notes.map((note) => (
            <li key={note.text} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5">
              <span className={`mt-px shrink-0 rounded-md px-1.5 py-px text-[11px] font-medium ${KIND[note.kind]!.tone}`}>
                {KIND[note.kind]!.label}
              </span>
              <span className="leading-[18px]">{note.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 p-3 pl-4">
        {update === "downloading" ? (
          <>
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="flex justify-between text-[12px] text-text-muted">
                <span>Downloading</span>
                <span className="tabular-nums">{Math.round(progress * 100)}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-selected">
                <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
              </div>
            </div>
            {onCancel && (
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </>
        ) : (
          <>
            <span className="flex-1" />
            {update === "ready" ? (
              <Button variant="primary" onClick={onRestart}>
                Restart to install
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={onSkip}>
                  Skip
                </Button>
                <Button variant="primary" onClick={onDownload}>
                  Download
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Ring({ value }: { value: number }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 22 22" className="size-[22px] -rotate-90" aria-hidden>
      <circle cx="11" cy="11" r={r} fill="none" strokeWidth="2.25" className="stroke-accent/20" />
      <circle
        cx="11"
        cy="11"
        r={r}
        fill="none"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
        className="stroke-accent transition-[stroke-dashoffset] duration-200"
      />
    </svg>
  );
}
