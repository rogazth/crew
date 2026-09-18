import { useRef, useState } from "react";
import { GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { formatChord } from "@crew/fixtures";
import { Button, Input, Kbd, Popover } from "@/ui";
import { store, useApp } from "@/lib/store";

export function WorkspacePicker({ anchor }: { anchor: HTMLElement | null }) {
  const state = useApp();
  const open = state.overlay?.kind === "workspaces";
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const dragging = useRef<number | null>(null);

  const close = () => {
    setRenaming(null);
    setCreating(false);
    store.closeOverlay();
  };

  return (
    <Popover
      open={open}
      anchor={anchor}
      onClose={close}
      side="bottom"
      align="start"
      label="Workspaces"
      className="w-[320px] py-1"
    >
      <div className="px-2 pt-1 pb-1 font-mono text-xs tracking-wide text-ink-4 uppercase">
        Workspaces
      </div>
      {state.workspaces.map((workspace, index) => {
        const active = workspace.id === state.workspaceId;
        const chord = formatChord({ key: String(index + 1), mod: true, ctrl: true });
        if (renaming === workspace.id) {
          return (
            <form
              key={workspace.id}
              className="px-2 py-1"
              onSubmit={(event) => {
                event.preventDefault();
                if (draft.trim()) store.renameWorkspace(workspace.id, draft.trim());
                setRenaming(null);
              }}
            >
              <Input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => setRenaming(null)}
                aria-label="Workspace name"
              />
            </form>
          );
        }
        return (
          <div
            key={workspace.id}
            draggable
            onDragStart={() => {
              dragging.current = index;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragging.current !== null) store.reorderWorkspaces(dragging.current, index);
              dragging.current = null;
            }}
            className={`group flex h-[var(--row-h)] items-center gap-2 px-2 ${
              active ? "bg-raised" : "hover:bg-raised"
            }`}
          >
            <GripVertical
              size={12}
              strokeWidth={1.25}
              className="shrink-0 cursor-grab text-ink-4 opacity-0 group-hover:opacity-100"
            />
            <button
              type="button"
              onClick={() => {
                store.setWorkspace(workspace.id);
                close();
              }}
              className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
            >
              <span className="shrink-0 font-mono text-sm text-ink-4">{index + 1}</span>
              <span className="truncate text-md text-ink">{workspace.name}</span>
              <span className="truncate font-mono text-xs text-ink-4">{workspace.path}</span>
            </button>
            <span className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
              <button
                type="button"
                aria-label={`Rename ${workspace.name}`}
                onClick={() => {
                  setDraft(workspace.name);
                  setRenaming(workspace.id);
                }}
                className="grid size-4 place-items-center text-ink-3 hover:text-ink"
              >
                <Pencil size={12} strokeWidth={1.25} />
              </button>
              <button
                type="button"
                aria-label={`Delete ${workspace.name}`}
                disabled={state.workspaces.length < 2}
                onClick={() => {
                  close();
                  store.confirm({
                    title: `Delete ${workspace.name}?`,
                    description: "Its sessions and tabs go with it. This cannot be undone.",
                    action: "Delete workspace",
                    destructive: true,
                    onConfirm: () => store.deleteWorkspace(workspace.id),
                  });
                }}
                className="grid size-4 place-items-center text-ink-3 hover:text-red-ink disabled:opacity-30"
              >
                <Trash2 size={12} strokeWidth={1.25} />
              </button>
            </span>
            <Kbd className="shrink-0 opacity-0 group-hover:opacity-100">{chord}</Kbd>
          </div>
        );
      })}
      <div className="mt-1 border-t border-rule p-2">
        {creating ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const name = draft.trim();
              if (name) store.createWorkspace(name, `/Users/you/${name}`);
              setCreating(false);
              close();
            }}
          >
            <Input
              autoFocus
              value={draft}
              placeholder="Folder name"
              onChange={(event) => setDraft(event.target.value)}
              aria-label="New workspace name"
            />
            <Button type="submit" variant="primary">
              Open
            </Button>
          </form>
        ) : (
          <Button
            block
            icon={<Plus size={13} strokeWidth={1.25} />}
            onClick={() => {
              setDraft("");
              setCreating(true);
            }}
          >
            Open workspace…
          </Button>
        )}
      </div>
    </Popover>
  );
}
