import { useState } from "react";
import { commandKeys } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useStore } from "@/lib/store";
import { Button } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { Kbd } from "@/ui/Kbd";
import { Pop } from "@/ui/Popover";
import { Input } from "@/ui/Input";

export function WorkspacePicker({ collapsed }: { collapsed?: boolean }) {
  const {
    workspaces,
    workspaceId,
    setWorkspaceId,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    moveWorkspace,
    wsPicker,
    setWsPicker,
    setConfirmRequest,
  } = useStore();
  const [mode, setMode] = useState<"list" | "create" | "rename">("list");
  const [draft, setDraft] = useState("");
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const active = workspaces.find((w) => w.id === workspaceId);

  const close = () => {
    setWsPicker(false);
    setMode("list");
  };

  const trigger = (
    <button
      type="button"
      className={cx(
        "rise-1 flex h-10 items-center gap-2 rounded-control px-2 text-left hover:bg-raised hover:el-1",
        collapsed ? "w-10 justify-center" : "w-full",
      )}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-accent-soft text-accent-text">
        <Icon name="folder" size={14} />
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold text-ink">{active?.name ?? "No workspace"}</span>
          </span>
          <Icon name="chevrons" size={14} className="shrink-0 text-ink-38" />
        </>
      )}
    </button>
  );

  return (
    <Pop
      trigger={trigger}
      open={wsPicker}
      onOpenChange={(open) => (open ? setWsPicker(true) : close())}
      width={300}
      align="start"
      className="p-1.5"
    >
      {mode === "list" && (
        <>
          <div className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-38">
            Workspaces
          </div>
          <ul className="scroller flex max-h-[42vh] flex-col gap-0.5">
            {workspaces.map((workspace, index) => (
              <li key={workspace.id}>
                <button
                  type="button"
                  draggable
                  onDragStart={() => setDragFrom(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragFrom !== null) moveWorkspace(dragFrom, index);
                    setDragFrom(null);
                  }}
                  onClick={() => {
                    setWorkspaceId(workspace.id);
                    close();
                  }}
                  className={cx(
                    "rise-1 flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left",
                    workspace.id === workspaceId ? "bg-accent-soft" : "hover:bg-sunken",
                  )}
                >
                  <Icon name="grip" size={13} className="shrink-0 cursor-grab text-ink-38" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base text-ink">{workspace.name}</span>
                    <span className="block truncate font-mono text-xs text-ink-38">{workspace.path}</span>
                  </span>
                  {index < 3 && <Kbd>{commandKeys(`workspace-${index + 1}` as "workspace-1")}</Kbd>}
                </button>
              </li>
            ))}
          </ul>
          <div className="my-1.5 h-px bg-[var(--line-soft)]" />
          <div className="flex flex-col gap-0.5">
            <PickerAction icon="plus" label="New workspace…" keys={commandKeys("open-workspace")} onClick={() => { setDraft(""); setMode("create"); }} />
            <PickerAction icon="pencil" label="Rename workspace…" onClick={() => { setDraft(active?.name ?? ""); setMode("rename"); }} />
            <PickerAction
              icon="trash"
              label="Delete workspace…"
              danger
              onClick={() => {
                close();
                if (!active) return;
                setConfirmRequest({
                  title: `Delete ${active.name}?`,
                  description: "Its sessions and tabs go with it. This cannot be undone.",
                  actionLabel: "Delete workspace",
                  destructive: true,
                  onConfirm: () => deleteWorkspace(active.id),
                });
              }}
            />
          </div>
        </>
      )}

      {mode !== "list" && (
        <form
          className="flex flex-col gap-2 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.trim()) return;
            if (mode === "create") createWorkspace(draft.trim(), `/Users/you/${draft.trim()}`);
            else if (active) renameWorkspace(active.id, draft.trim());
            close();
          }}
        >
          <p className="text-sm font-medium text-ink-70">
            {mode === "create" ? "New workspace" : "Rename workspace"}
          </p>
          <Input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="name" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setMode("list")}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit">
              {mode === "create" ? "Create" : "Rename"}
            </Button>
          </div>
        </form>
      )}
    </Pop>
  );
}

function PickerAction({
  icon,
  label,
  keys,
  onClick,
  danger,
}: {
  icon: "plus" | "pencil" | "trash";
  label: string;
  keys?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "rise-1 flex h-8 items-center gap-2.5 rounded-[8px] px-2 text-base",
        danger ? "text-[var(--danger)] hover:bg-danger-soft" : "text-ink hover:bg-sunken",
      )}
    >
      <Icon name={icon} size={15} className="opacity-70" />
      <span className="flex-1 text-left">{label}</span>
      {keys && <Kbd>{keys}</Kbd>}
    </button>
  );
}
