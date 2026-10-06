import { Collapsible } from "@base-ui/react/collapsible";
import { BotIcon, ChevronDownIcon, EyeIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Kbd } from "../../chrome/Kbd";
import { useNow } from "../../hooks/useBackground";
import * as api from "../../lib/api";
import { isRunning, plainText, stateLabel, traySummary } from "../../lib/background";
import type { Block } from "../../lib/blocks";
import type { BackgroundCommand, BackgroundKind, BackgroundOutput } from "../../lib/protocol";
import { clock } from "../../lib/time";
import { useBackgroundScope } from "./context";

/** How often an open output is read again while its command runs. */
const POLL_MS = 1000;
const NEAR_BOTTOM_PX = 16;

/** A command's state at a glance: running pulses, a clean end is a still dot, a failure red. */
export function CommandDot({ command }: { command: BackgroundCommand }) {
  if (isRunning(command)) return <span className="crew-bg-dot" aria-hidden />;
  const failed = command.state === "failed" || (command.exitCode !== undefined && command.exitCode !== 0);
  const tone = command.state === "stopped" ? "bg-placeholder" : failed ? "bg-danger" : "bg-text-muted";
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${tone}`} />;
}

function KindIcon({ kind, className }: { kind: BackgroundKind; className: string }) {
  if (kind === "subagent") return <BotIcon className={className} />;
  if (kind === "monitor") return <EyeIcon className={className} />;
  return <TerminalIcon className={className} />;
}

/** A subagent's output is its report, which lands in the transcript; the rest can be read. */
const readable = (command: BackgroundCommand) => command.kind !== "subagent";

/** Stops one command; what went wrong, if anything, for the row to say. */
function useStop(sessionId: string) {
  const [failed, setFailed] = useState<Record<string, string>>({});
  const stop = (id: string) => {
    setFailed(({ [id]: _, ...rest }) => rest);
    void api.backgroundStop(sessionId, id).catch((error: unknown) =>
      setFailed((prev) => ({ ...prev, [id]: error instanceof Error ? error.message : String(error) })),
    );
  };
  return { failed, stop };
}

type TrayProps = {
  sessionId: string;
  commands: readonly BackgroundCommand[];
  /** The CLI that runs them is up: they can be stopped. */
  live: boolean;
  /** A terminal's: listed from its hooks, nothing to read or stop from here. */
  readOnly?: boolean;
  onOpen?: (id: string) => void;
};

/**
 * What the chat left running, above the composer: it stays put however far
 * the transcript scrolls. Folded by default to one line; a row opens its
 * output, and Stop is the one action.
 */
export function BackgroundTray({ sessionId, commands, live, readOnly = false, onOpen }: TrayProps) {
  const [open, setOpen] = useState(false);
  const running = commands.some(isRunning);
  const now = useNow(1000, open && running);
  const { failed, stop } = useStop(sessionId);
  return (
    <div className="mx-auto w-full max-w-[760px] shrink-0 px-6 pb-2" data-background-tray>
      <Collapsible.Root open={open} onOpenChange={setOpen} className="rounded-2xl bg-card">
        <Collapsible.Trigger className="group flex h-9 w-full items-center gap-2 rounded-2xl px-3.5 text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-focus/50">
          <TerminalIcon className="size-3.5 text-icon" />
          <span className="text-text">Background</span>
          <span className="text-text-muted">· {traySummary(commands)}</span>
          <span className="flex-1" />
          <ChevronDownIcon className={`size-3.5 text-icon transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
        </Collapsible.Trigger>
        <Collapsible.Panel className="crew-phase-panel">
          <div className="flex max-h-[40vh] flex-col overflow-y-auto px-1.5 pb-1.5">
            {commands.map((command) => (
              <TrayRow
                key={command.id}
                command={command}
                now={now}
                error={failed[command.id]}
                {...(onOpen && !readOnly && readable(command) ? { onOpen: () => onOpen(command.id) } : {})}
                {...(!readOnly && live && isRunning(command) ? { onStop: () => stop(command.id) } : {})}
              />
            ))}
          </div>
        </Collapsible.Panel>
      </Collapsible.Root>
    </div>
  );
}

function TrayRow({
  command,
  now,
  error,
  onOpen,
  onStop,
}: {
  command: BackgroundCommand;
  now: number;
  error: string | undefined;
  onOpen?: () => void;
  onStop?: () => void;
}) {
  const press = (event: KeyboardEvent) => {
    if (!onOpen || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onOpen();
  };
  return (
    <div
      {...(onOpen ? { role: "button", tabIndex: 0, onClick: onOpen, onKeyDown: press, title: "Open its output" } : {})}
      className={`flex h-8 items-center gap-2.5 rounded-lg px-2 outline-none transition-colors ${
        onOpen ? "cursor-default hover:bg-hover focus-visible:bg-hover" : ""
      }`}
    >
      <span className="grid size-3.5 shrink-0 place-items-center">
        <CommandDot command={command} />
      </span>
      <KindIcon kind={command.kind} className="size-3.5 shrink-0 text-icon" />
      <span
        title={command.description ?? command.command}
        className={`min-w-0 truncate font-mono text-[12px] ${isRunning(command) ? "text-text" : "text-text-muted"}`}
      >
        {command.command}
      </span>
      <span className="shrink-0 text-[11.5px] text-text-muted tabular-nums">{stateLabel(command, now)}</span>
      <span className="flex-1" />
      {error && (
        <span title={error} className="min-w-0 truncate text-[11.5px] text-danger">
          {error}
        </span>
      )}
      {onStop && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onStop();
          }}
          className="flex h-6 shrink-0 items-center rounded-md px-2 text-[12px] text-text-muted transition-colors hover:bg-selected hover:text-text"
        >
          Stop
        </button>
      )}
    </div>
  );
}

/**
 * Where a command went to the background, in the transcript: one quiet line
 * that opens its output. It stays out of a folded turn, like a checkpoint.
 */
export const BackgroundMarker = memo(function BackgroundMarker({ block }: { block: Block }) {
  const { calls, open } = useBackgroundScope();
  const command = block.tool ? calls.get(block.tool.callId) : undefined;
  if (!command) return null;
  const canOpen = readable(command);
  return (
    <button
      type="button"
      disabled={!canOpen}
      onClick={() => open(command.id)}
      title={canOpen ? "Open its output" : (command.description ?? command.command)}
      className="group flex min-h-[26px] w-full items-center gap-2 py-0.5 text-left text-[13px] leading-[18px] disabled:cursor-default"
    >
      <span className="crew-node">
        <KindIcon kind={command.kind} className="size-3.5" />
      </span>
      <span className="shrink-0 text-text-muted transition-colors group-enabled:group-hover:text-text">
        {command.kind === "subagent" ? "Sent a subagent to the background" : "Sent to the background"}
      </span>
      <span className="flex h-5 min-w-0 items-center gap-1.5 rounded-md bg-card px-1.5 font-mono text-[11.5px] text-text-muted transition-colors group-enabled:group-hover:text-text">
        <CommandDot command={command} />
        <span className="truncate">{command.command}</span>
      </span>
      <span className="h-px min-w-4 flex-1 bg-hairline" />
      <span className="shrink-0 text-[11px] text-placeholder tabular-nums">{clock(command.startedAt)}</span>
    </button>
  );
});

type OutputProps = {
  sessionId: string;
  command: BackgroundCommand;
  live: boolean;
  /** False while the tab sits behind another one: Esc is the shown one's. */
  active: boolean;
  onClose: () => void;
};

/**
 * One command's output over the transcript, in the reading column: the end
 * of what it wrote, read again every second while it runs. Esc or Close goes
 * back to where the reader was.
 */
export function BackgroundOutputView({ sessionId, command, live, active, onClose }: OutputProps) {
  const [output, setOutput] = useState<BackgroundOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const running = isRunning(command);
  const following = running && live;
  const now = useNow(1000, running);
  const { failed, stop } = useStop(sessionId);

  // Read now, and again while it runs; once it has ended, once more for its last words.
  useEffect(() => {
    let cancelled = false;
    const read = () =>
      void api
        .backgroundOutput(sessionId, command.id)
        .then((next) => {
          if (cancelled) return;
          setOutput(next);
          setError(null);
        })
        .catch((reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    read();
    if (!following) return () => void (cancelled = true);
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [command.id, following, sessionId]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose]);

  // It follows the output while the reader is at its end.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  const text = plainText(output?.output ?? "");
  return (
    <div className="crew-thread absolute inset-0 z-20 flex flex-col bg-canvas" data-background-output={command.id}>
      <div
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="pointer-events-none sticky top-0 z-10 flex justify-center bg-linear-to-b from-canvas via-canvas/90 to-transparent px-6 pt-3 pb-6">
          <div className="pointer-events-auto flex h-10 max-w-full items-center gap-1 rounded-full bg-surface px-1.5 shadow-float">
            <span className="flex h-7 min-w-0 items-center gap-2 px-2 text-[13px]">
              <KindIcon kind={command.kind} className="size-3.5 shrink-0 text-icon" />
              <span className="truncate font-mono text-[12.5px]">{command.command}</span>
            </span>
            <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-card px-2.5 text-[12px] text-text-muted tabular-nums">
              <CommandDot command={command} />
              {stateLabel(command, now)}
            </span>
            {following && (
              <button
                type="button"
                onClick={() => stop(command.id)}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] text-text transition-colors hover:bg-hover"
              >
                <SquareIcon className="size-3" />
                Stop
              </button>
            )}
          </div>
        </div>
        <div className="mx-auto w-full max-w-[760px] px-6 pb-28">
          <p className="mb-2 px-1 text-[12px] text-text-muted">
            Started {clock(command.startedAt)} · {following ? "following its output" : "its last output"}
            {output?.truncated ? " · only the end" : ""}
          </p>
          {(error ?? failed[command.id]) && <p className="mb-2 px-1 text-[12px] text-danger">{error ?? failed[command.id]}</p>}
          <pre
            data-selectable
            className="overflow-x-auto rounded-xl border border-border bg-sidebar px-4 py-3 font-mono text-[12.5px] leading-[19px] whitespace-pre-wrap text-text"
          >
            {text || (output ? <span className="text-text-muted">No output yet.</span> : <span className="text-text-muted">Reading…</span>)}
          </pre>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-linear-to-t from-canvas via-canvas/90 to-transparent pt-10 pb-4">
        <button
          type="button"
          onClick={onClose}
          className="pointer-events-auto flex h-9 items-center gap-2 rounded-full bg-surface pr-2.5 pl-4 text-[13px] shadow-float transition-colors hover:bg-hover"
        >
          Close
          <Kbd keys="esc" />
        </button>
      </div>
    </div>
  );
}
