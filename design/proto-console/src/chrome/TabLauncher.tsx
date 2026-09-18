import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";
import { STUB_KINDS, STUB_LABELS, fuzzyMatch } from "@crew/fixtures";
import { CommandKbd, Dialog, Kbd, ProviderMark, TerminalMark } from "@/ui";
import { store, useApp } from "@/lib/store";

type Entry = { id: string; label: string; detail?: string; mark: React.ReactNode; run: () => void };

export function TabLauncher() {
  const state = useApp();
  const open = state.overlay?.kind === "launcher";
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [
      {
        id: "new-agent",
        label: "New agent",
        mark: <Mark>+</Mark>,
        run: () => store.openOverlay({ kind: "sheet", sessionId: null }),
      },
      {
        id: "new-session",
        label: "New session",
        detail: "a shell in this workspace",
        mark: <Mark>+</Mark>,
        run: () => {
          const session = store.createSession({ kind: "terminal", name: `shell ${state.sessions.length}` });
          store.openSession(session.id);
        },
      },
      ...STUB_KINDS.map((stub) => ({
        id: `stub-${stub}`,
        label: STUB_LABELS[stub] ?? stub,
        detail: "placeholder surface",
        mark: <Mark>{stub.slice(0, 2)}</Mark>,
        run: () => store.openStub(stub, STUB_LABELS[stub] ?? stub),
      })),
      ...state.sessions
        .filter((session) => session.workspaceId === state.workspaceId)
        .map((session) => ({
          id: session.id,
          label: session.name,
          detail: session.kind === "agent" ? session.description : "terminal",
          mark:
            session.kind === "terminal" ? (
              <TerminalMark />
            ) : (
              <ProviderMark provider={session.provider} />
            ),
          run: () => store.openSession(session.id),
        })),
    ];
    if (!query.trim()) return out;
    return out
      .map((entry) => ({ entry, hit: fuzzyMatch(query, entry.label) }))
      .filter((scored) => scored.hit)
      .sort((a, b) => (b.hit?.score ?? 0) - (a.hit?.score ?? 0))
      .map((scored) => scored.entry);
  }, [state.sessions, state.workspaceId, query]);

  const close = () => store.closeOverlay();

  return (
    <Dialog open={open} onClose={close} label="New tab" top className="max-w-[460px]">
      <div className="flex h-[var(--h-tabs)] shrink-0 items-center gap-2 border-b border-rule px-3">
        <span className="font-mono text-xs tracking-wide text-ink-4 uppercase">New tab</span>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setCursor((held) =>
                entries.length === 0 ? 0 : (((held + delta) % entries.length) + entries.length) % entries.length,
              );
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const entry = entries[cursor];
              if (entry) {
                close();
                entry.run();
              }
            }
          }}
          placeholder="Filter…"
          aria-label="Filter"
          className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-ink-4"
        />
        <CommandKbd id="open-launcher" />
      </div>
      <div className="scroll min-h-0 flex-1 py-1">
        {entries.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            onMouseMove={() => setCursor(index)}
            onClick={() => {
              close();
              entry.run();
            }}
            className={clsx(
              "flex h-[var(--row-h)] w-full items-center gap-2 px-3 text-left",
              index === cursor && "bg-raised",
            )}
          >
            {entry.mark}
            <span className="truncate text-md">{entry.label}</span>
            {entry.detail ? (
              <span className="truncate font-mono text-xs text-ink-4">{entry.detail}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-rule px-3 py-1.5 font-mono text-xs text-ink-4">
        <span className="flex items-center gap-1">
          <Kbd>↑↓</Kbd> Select
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⏎</Kbd> Open
        </span>
      </div>
    </Dialog>
  );
}

function Mark({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid size-[14px] shrink-0 place-items-center rounded-[var(--r)] bg-sunken font-mono text-[8px] leading-none text-ink-3">
      {children}
    </span>
  );
}
