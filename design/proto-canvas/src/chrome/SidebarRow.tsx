import { memo, useEffect, useRef, useState, type MouseEvent } from "react";
import { elapsed, providerLine, type Session, type SessionStatus } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useStore } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { Icon } from "@/ui/Icon";
import { ContextItem, ContextMenuRoot, ContextSep } from "@/ui/Menu";
import { StatusDot } from "./StatusDot";

export type SidebarRowProps = {
  session: Session;
  status: SessionStatus;
  /** Letters queued for this agent. A badge on the face, not a separate row. */
  waiting: number;
  active: boolean;
  selected: boolean;
  renaming: boolean;
  draggable: boolean;
  onOpen: (event: MouseEvent) => void;
  onRename: (name: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDrop?: () => void;
};

export const SidebarRow = memo(function SidebarRow({
  session,
  status,
  waiting,
  active,
  selected,
  renaming,
  draggable,
  onOpen,
  onRename,
  onStartRename,
  onCancelRename,
  onDelete,
  onEdit,
  onDragStart,
  onDragOver,
  onDrop,
}: SidebarRowProps) {
  const { prefs, selection } = useStore();
  const [draft, setDraft] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      setDraft(session.name);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [renaming, session.name]);

  const second =
    session.kind === "terminal"
      ? session.description || "shell"
      : providerLine(session.provider, session.model);

  const row = (
    <div
      role="option"
      aria-selected={active || selected}
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={(event) => {
        if (!draggable) return;
        event.preventDefault();
        onDragOver?.();
      }}
      onDrop={onDrop}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(event as unknown as MouseEvent);
        if (event.key === "F2") {
          event.preventDefault();
          onStartRename();
        }
        if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onDelete();
        }
      }}
      className={cx(
        "rise-1 group relative flex h-11 w-full cursor-default select-none items-center gap-2.5 rounded-control px-2",
        active
          ? "bg-raised el-1"
          : selected
            ? "bg-accent-soft"
            : "bg-transparent hover:bg-raised hover:el-1",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent"
        />
      )}

      {prefs.show.avatar ? (
        session.kind === "terminal" ? (
          <span className="relative grid size-9 shrink-0 place-items-center">
            <span className="grid size-7 place-items-center rounded-[8px] bg-sunken text-ink-52 el-1">
              <Icon name="terminal" size={15} />
            </span>
            {prefs.show.status && status !== "idle" && (
              <span className="absolute -bottom-0.5 -right-0.5">
                <StatusDot status={status} />
              </span>
            )}
          </span>
        ) : (
          <Avatar seed={session.name} size={28} status={prefs.show.status ? status : undefined} badge={waiting} />
        )
      ) : (
        prefs.show.status && <StatusDot status={status} className="ml-1" />
      )}

      <span className="flex min-w-0 flex-1 flex-col justify-center">
        {renaming ? (
          <input
            ref={inputRef}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onBlur={() => onRename(draft)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") onRename(draft);
              if (event.key === "Escape") onCancelRename();
            }}
            className="w-full rounded-chip bg-raised px-1 py-0.5 text-base outline-none el-2"
          />
        ) : (
          <span className="truncate text-base font-medium text-ink">{session.name}</span>
        )}
        {prefs.show.provider && !renaming && (
          <span
            className={cx(
              "truncate text-xs",
              status === "working" ? "shimmer" : "text-ink-52",
            )}
          >
            {status === "working" ? "working…" : second}
          </span>
        )}
      </span>

      {prefs.show.updated && !renaming && (
        <span className="shrink-0 text-xs tabular-nums text-ink-38">{elapsed(session.updatedAt)}</span>
      )}
    </div>
  );

  const many = selected && selection.length > 1;

  return (
    <ContextMenuRoot trigger={row}>
      {session.kind === "agent" ? (
        <ContextItem icon="pencil" onClick={onEdit}>
          Edit agent
        </ContextItem>
      ) : (
        <ContextItem icon="type" onClick={onStartRename} keys="F2">
          Rename
        </ContextItem>
      )}
      <ContextItem icon="copy" onClick={() => navigator.clipboard?.writeText(session.id)}>
        Copy session id
      </ContextItem>
      <ContextSep />
      <ContextItem icon="trash" danger onClick={onDelete}>
        {many ? `Delete ${selection.length} items` : "Delete"}
      </ContextItem>
    </ContextMenuRoot>
  );
});
