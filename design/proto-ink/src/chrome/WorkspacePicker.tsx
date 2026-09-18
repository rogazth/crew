import { useRef, useState } from "react";
import { commandKeys } from "@crew/fixtures";
import type { Workspace } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { useApp } from "@/lib/store";
import { Button, Dialog, Field, Input, Menu, MenuItem, MenuSeparator, Popover } from "@/ui";

/**
 * The workspace row at the top of the sidebar: switch, create, rename, delete and
 * drag-reorder, all from one anchored popover.
 */
export function WorkspacePicker({ inset }: { inset: number }) {
  const { workspaces, activeWorkspaceId, workspace, actions, workspacePicker } = useApp();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [draft, setDraft] = useState({ name: "", path: "" });
  const dragIndex = useRef<number | null>(null);

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1" style={{ paddingTop: inset }}>
        <Popover
          open={open || workspacePicker}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) actions.setWorkspacePicker(false);
          }}
          align="start"
          sideOffset={4}
          width={280}
          trigger={
            <button
              type="button"
              className={cx(
                "group flex h-8 min-w-0 flex-1 items-center gap-2 rounded-row px-1.5 text-left",
                "transition-colors duration-[var(--dur-2)] hover:bg-[var(--fill-tertiary)]",
                "data-[popup-open]:bg-[var(--fill-tertiary)]",
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-[var(--fill-tertiary)] text-icon-faint">
                <Icon name="workspace" size={13} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-[var(--weight-medium)] text-primary">
                  {workspace.name}
                </span>
              </span>
              <Icon name="chevronDown" size={14} className="shrink-0 text-icon-faint" />
            </button>
          }
        >
          <div className="flex flex-col p-1">
            <p className="px-2 pb-1 pt-1.5 text-micro uppercase tracking-[0.06em] text-quaternary">
              Workspaces
            </p>
            {workspaces.map((item, index) => (
              <div
                key={item.id}
                draggable
                onDragStart={() => (dragIndex.current = index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (dragIndex.current !== null) actions.reorderWorkspaces(dragIndex.current, index);
                  dragIndex.current = null;
                }}
                className="group/row flex items-center"
              >
                <button
                  type="button"
                  onClick={() => {
                    actions.setWorkspace(item.id);
                    setOpen(false);
                  }}
                  className={cx(
                    "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left",
                    "transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-tertiary)]",
                    item.id === activeWorkspaceId && "bg-[var(--fill-tertiary)]",
                  )}
                >
                  <Icon
                    name="gripVertical"
                    size={14}
                    className="shrink-0 cursor-grab text-icon-faint opacity-0 transition-opacity group-hover/row:opacity-100"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-primary">{item.name}</span>
                    <span className="block truncate font-mono text-micro text-quaternary">
                      {item.path}
                    </span>
                  </span>
                  <span className="w-4 shrink-0 text-micro text-quaternary tnum">
                    {index < 9 ? index + 1 : ""}
                  </span>
                </button>
                <Menu
                  align="end"
                  trigger={
                    <button
                      type="button"
                      aria-label={`${item.name} options`}
                      className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-icon-faint opacity-0 transition-opacity hover:bg-[var(--fill-tertiary)] group-hover/row:opacity-100 data-[popup-open]:opacity-100"
                    >
                      <Icon name="ellipsis" size={14} />
                    </button>
                  }
                >
                  <MenuItem
                    icon="edit"
                    onClick={() => {
                      setRenaming(item);
                      setDraft({ name: item.name, path: item.path });
                    }}
                  >
                    Rename
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    icon="trash"
                    destructive
                    disabled={workspaces.length <= 1}
                    onClick={() =>
                      actions.confirm({
                        title: `Delete ${item.name}?`,
                        description:
                          "The folder stays on disk. Its sessions and tabs are forgotten.",
                        confirmLabel: "Delete workspace",
                        destructive: true,
                        onConfirm: () => actions.deleteWorkspace(item.id),
                      })
                    }
                  >
                    Delete
                  </MenuItem>
                </Menu>
              </div>
            ))}
            <div className="my-1 h-px bg-[var(--stroke-tertiary)]" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setCreating(true);
                setDraft({ name: "", path: "" });
              }}
              className="flex h-8 items-center gap-2 rounded-md px-2 text-body text-secondary transition-colors hover:bg-[var(--fill-tertiary)] hover:text-primary"
            >
              <Icon name="plus" size={14} />
              Open folder…
              <span className="ml-auto text-micro text-quaternary">{commandKeys("open-workspace")}</span>
            </button>
          </div>
        </Popover>
      </div>

      <Dialog open={creating} onOpenChange={setCreating} width={400}>
        <WorkspaceForm
          title="Open workspace"
          confirmLabel="Open"
          draft={draft}
          setDraft={setDraft}
          onCancel={() => setCreating(false)}
          onSubmit={() => {
            if (!draft.name.trim()) return;
            actions.createWorkspace(draft.name.trim(), draft.path.trim() || `/Users/you/${draft.name.trim()}`);
            setCreating(false);
          }}
        />
      </Dialog>

      <Dialog open={renaming !== null} onOpenChange={(next) => !next && setRenaming(null)} width={400}>
        <WorkspaceForm
          title="Rename workspace"
          confirmLabel="Rename"
          draft={draft}
          setDraft={setDraft}
          pathReadOnly
          onCancel={() => setRenaming(null)}
          onSubmit={() => {
            if (renaming && draft.name.trim()) actions.renameWorkspace(renaming.id, draft.name.trim());
            setRenaming(null);
          }}
        />
      </Dialog>
    </>
  );
}

function WorkspaceForm({
  title,
  confirmLabel,
  draft,
  setDraft,
  onCancel,
  onSubmit,
  pathReadOnly,
}: {
  title: string;
  confirmLabel: string;
  draft: { name: string; path: string };
  setDraft: (next: { name: string; path: string }) => void;
  onCancel: () => void;
  onSubmit: () => void;
  pathReadOnly?: boolean;
}) {
  return (
    <form
      className="flex flex-col gap-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <h2 className="text-body font-[var(--weight-medium)] text-primary">{title}</h2>
      <Field label="Name">
        <Input
          autoFocus
          size="lg"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="crew"
        />
      </Field>
      <Field label="Path" hint={pathReadOnly ? "The folder on disk does not move." : undefined}>
        <Input
          size="lg"
          readOnly={pathReadOnly}
          className="font-mono"
          value={draft.path}
          onChange={(event) => setDraft({ ...draft, path: event.target.value })}
          placeholder="/Users/you/crew"
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" tone="primary" disabled={!draft.name.trim()}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}
