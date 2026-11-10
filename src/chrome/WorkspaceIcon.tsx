// A workspace's icon on its settings page (WorkspaceSettingsPage.tsx): the face heading it. A press (or a drop)
// uploads an image, kept by the daemon that holds the workspace, never in the repo; a small × on its corner goes back
// to the default, the repo's best image, else the initials.
import { XIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { EditableFace } from "./SettingsDialog";
import { WorkspaceTile } from "./WorkspaceTile";
import { UPLOAD_TYPES, iconOf, pick, problemOf, refresh, snapshot, subscribe, upload } from "../lib/workspaceIcons";
import type { Workspace } from "../lib/types";

/** The face heading the page: a press opens the file picker, an image dropped on it is uploaded. */
export function WorkspaceIconButton({ workspace }: { workspace: Workspace }) {
  useSyncExternalStore(subscribe, snapshot);
  const [over, setOver] = useState(false);
  const { id } = workspace;
  useEffect(() => {
    void refresh(id);
  }, [id]);
  const choice = iconOf(id)?.choice ?? "auto";
  const corner =
    "absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-surface text-icon opacity-0 shadow-[0_0_0_1px_var(--color-hairline),0_1px_3px_oklch(0%_0_0/0.15)] transition-opacity group-hover/icon:opacity-100 hover:text-text focus-visible:opacity-100";
  return (
    <span className="group/icon relative shrink-0">
      <EditableFace
        label="Change icon"
        size="size-12 rounded-[15px]"
        over={over}
        onClick={() => chooseImage((file) => void upload(id, file))}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const file = event.dataTransfer.files[0];
          if (file) void upload(id, file);
        }}
      >
        <WorkspaceTile workspace={workspace} size="lg" />
      </EditableFace>
      {choice !== "auto" && (
        <button type="button" aria-label="Remove icon" title="Remove icon" onClick={() => void pick(id, { choice: "auto" })} className={corner}>
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  );
}

/** What went wrong with the last upload, said under the heading; nothing when all went well. */
export function WorkspaceIconProblem({ workspace }: { workspace: Workspace }) {
  useSyncExternalStore(subscribe, snapshot);
  const problem = problemOf(workspace.id);
  return problem ? (
    <p role="alert" className="mt-2 text-[12px] text-danger">
      {problem}
    </p>
  ) : null;
}

/** Opens the file picker on an input made for the one pick. */
function chooseImage(take: (file: File) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = UPLOAD_TYPES;
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) take(file);
  };
  input.click();
}
