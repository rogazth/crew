import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { elapsed, providerLine } from "@crew/fixtures";
import type { Session } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { useApp } from "@/lib/store";
import type { SidebarPrefs } from "@/lib/sidebar";
import { Avatar, ContextMenu, MenuItem, MenuSeparator, StatusDot, Tooltip } from "@/ui";

export type SidebarRowProps = {
  session: Session;
  prefs: SidebarPrefs;
  active: boolean;
  selected: boolean;
  draggable: boolean;
  /** Letters queued for this agent because it is mid-turn. */
  waiting: number;
  onDragStart?: () => void;
  onDragOver?: (event: MouseEvent) => void;
  onDrop?: () => void;
};

export const SidebarRow = memo(function SidebarRow({
  session,
  prefs,
  active,
  selected,
  draggable,
  waiting,
  onDragStart,
  onDragOver,
  onDrop,
}: SidebarRowProps) {
  const { actions, selection } = useApp();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(session.name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  const twoLine = prefs.showProvider && session.kind === "agent";

  const commit = () => {
    const name = draft.trim();
    if (name) actions.renameSession(session.id, name);
    else setDraft(session.name);
    setRenaming(false);
  };

  const remove = () => {
    const ids = selection.length > 1 && selection.includes(session.id) ? selection : [session.id];
    actions.confirm({
      title: ids.length > 1 ? `Delete ${ids.length} items?` : `Delete ${session.name}?`,
      description:
        ids.length > 1
          ? "Their transcripts go with them. This cannot be undone."
          : "Its transcript goes with it. This cannot be undone.",
      confirmLabel: ids.length > 1 ? `Delete ${ids.length} items` : "Delete",
      destructive: true,
      onConfirm: () => actions.deleteSessions(ids),
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "F2") {
      event.preventDefault();
      setDraft(session.name);
      setRenaming(true);
      return;
    }
    if (event.key === "Escape") {
      actions.clearSelection();
      return;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      remove();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      actions.openSession(session.id);
    }
  };

  const onClick = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey) {
      actions.select(session.id, "toggle");
      return;
    }
    if (event.shiftKey) {
      actions.select(session.id, "range");
      return;
    }
    actions.select(session.id, "replace");
    actions.openSession(session.id);
  };

  const row = (
    <div
      role="option"
      aria-selected={active}
      tabIndex={0}
      data-session={session.id}
      draggable={draggable && !renaming}
      onDragStart={onDragStart}
      onDragOver={onDragOver as never}
      onDrop={onDrop}
      onClick={onClick}
      onDoubleClick={() => {
        setDraft(session.name);
        setRenaming(true);
      }}
      onKeyDown={onKeyDown}
      className={cx(
        "group relative flex cursor-default select-none items-center gap-2 rounded-row pl-2.5 pr-2",
        "ink-skip transition-colors duration-[var(--dur-2)]",
        twoLine ? "h-[42px]" : "h-[30px]",
        active
          ? "bg-[var(--fill-tertiary)]"
          : selected
            ? "bg-[var(--fill-quaternary)]"
            : "hover:bg-[var(--fill-quaternary)]",
        session.status === "working" && "ink-sweep",
      )}
      style={{ containIntrinsicSize: `auto ${twoLine ? 42 : 30}px` }}
    >
      {/* Selection is a 2px rail marker, not a filled row: the canvas stays loudest. */}
      <span
        aria-hidden
        className={cx(
          "absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full transition-opacity duration-[var(--dur-2)]",
          active ? "bg-[var(--accent)] opacity-100" : "opacity-0",
        )}
      />
      {prefs.showAvatar && (
        <Avatar
          seed={session.name}
          kind={session.kind === "terminal" ? "terminal" : "agent"}
          size={twoLine ? 22 : 18}
        />
      )}
      <span className="min-w-0 flex-1">
        {renaming ? (
          <input
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") commit();
              if (event.key === "Escape") {
                setDraft(session.name);
                setRenaming(false);
              }
            }}
            className="w-full rounded-sm bg-canvas px-1 py-px text-body text-primary outline-none e1"
          />
        ) : (
          <span className="block truncate text-body text-primary">{session.name}</span>
        )}
        {twoLine && !renaming && (
          <span className="block truncate text-micro text-tertiary">
            {providerLine(session.provider, session.model)}
          </span>
        )}
      </span>
      {waiting > 0 && (
        <Tooltip content={`${waiting} letter${waiting === 1 ? "" : "s"} waiting in its box`}>
          <span className="flex h-4 shrink-0 items-center gap-0.5 rounded-sm bg-[var(--attention-fill)] px-1 text-micro leading-none text-[var(--status-attention)] tnum">
            <Icon name="inbox" size={10} />
            {waiting}
          </span>
        </Tooltip>
      )}
      {prefs.showUpdated && (
        <span className="shrink-0 text-micro text-quaternary tnum group-hover:hidden">
          {elapsed(session.updatedAt)}
        </span>
      )}
      {prefs.showStatus && (
        <span className="flex w-2 shrink-0 justify-center">
          <StatusDot status={session.status} />
        </span>
      )}
    </div>
  );

  return (
    <ContextMenu trigger={row}>
      {selection.length > 1 && selection.includes(session.id) ? (
        <>
          <MenuItem icon="inbox" disabled>
            {selection.length} selected
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon="trash" destructive onClick={remove}>
            Delete {selection.length} items
          </MenuItem>
        </>
      ) : (
        <>
          {session.kind === "agent" ? (
            <MenuItem icon="edit" onClick={() => actions.openSheet(session.id)}>
              Edit agent…
            </MenuItem>
          ) : (
            <MenuItem
              icon="edit"
              onClick={() => {
                setDraft(session.name);
                setRenaming(true);
              }}
            >
              Rename
            </MenuItem>
          )}
          <MenuItem icon="external" onClick={() => actions.openSession(session.id)}>
            Open in tab
          </MenuItem>
          {session.kind === "agent" && (
            <MenuItem icon="routine" onClick={() => actions.openRoutines(null)}>
              Routines…
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon="trash" destructive onClick={remove}>
            Delete
          </MenuItem>
        </>
      )}
    </ContextMenu>
  );
});

export function CreatedByLine({ session }: { session: Session }) {
  const { actions } = useApp();
  if (!session.createdBy) return null;
  return (
    <button
      type="button"
      onClick={() => actions.openSession(session.createdBy!.id)}
      className="inline-flex items-center gap-1 text-micro text-tertiary transition-colors hover:text-primary"
    >
      <Icon name="bot" size={12} className="opacity-70" />
      Created by
      <Avatar seed={session.createdBy.name} size={13} />
      <span className="underline decoration-[var(--stroke-secondary)] underline-offset-2">
        {session.createdBy.name}
      </span>
    </button>
  );
}
