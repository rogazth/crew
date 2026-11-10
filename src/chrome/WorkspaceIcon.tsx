// A workspace's icon on its settings page (WorkspaceSettingsPage.tsx): the face heading it, which opens the card to
// change it and takes an image dropped on it, and that card. The icon is the best image the repo offers, another of
// its images, one uploaded (kept by the daemon that holds the workspace, never in the repo), or the initials.
import { CheckIcon, RotateCwIcon, UploadIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AddRow, PaneCard } from "./BotPaneParts";
import { Button } from "./kit";
import { EditableFace } from "./SettingsDialog";
import { WorkspaceTile } from "./WorkspaceTile";
import { UPLOAD_TYPES, iconOf, pick, problemOf, refresh, snapshot, subscribe, upload } from "../lib/workspaceIcons";
import type { Workspace } from "../lib/types";
import { workspaceMark } from "../lib/workspaces";

/** The face heading the page: a press opens or closes the card to change it, an image dropped on it is uploaded. */
export function WorkspaceIconButton({ workspace, picking, onPicking }: { workspace: Workspace; picking: boolean; onPicking: (open: boolean) => void }) {
  const [over, setOver] = useState(false);
  return (
    <EditableFace
      label="Change icon"
      size="size-12 rounded-[15px]"
      over={over || picking}
      onClick={() => onPicking(!picking)}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (!file) return;
        // Open, so what goes wrong is said where it can be read.
        onPicking(true);
        void upload(workspace.id, file);
      }}
    >
      <WorkspaceTile workspace={workspace} size="lg" />
    </EditableFace>
  );
}

/**
 * The card to change it, at the top of General: the repo's best (Automatic),
 * each image the repo offers, the one uploaded, and the initials, one of
 * them chosen. Under them, another upload, and a look in the repo again.
 */
export function WorkspaceIconPicker({ workspace }: { workspace: Workspace }) {
  useSyncExternalStore(subscribe, snapshot);
  const [looking, setLooking] = useState(false);
  const { id } = workspace;
  useEffect(() => {
    void refresh(id, { choices: true });
  }, [id]);
  const icon = iconOf(id);
  const problem = problemOf(id);
  const choice = icon?.choice ?? "auto";
  const found = icon?.found ?? [];
  const best = found[0];
  const initials = <Tile>{workspaceMark(workspace.name)}</Tile>;

  return (
    <div>
      <PaneCard label="Icon">
        <div role="radiogroup" aria-label="Icon" className="contents">
          <Option
            label="Automatic"
            line={best ? `The repo's best: ${best.path}` : "Nothing in the repo, so the initials"}
            on={choice === "auto"}
            onPick={() => void pick(id, { choice: "auto" })}
            preview={best ? <Tile image={best.image} /> : initials}
          />
          {found.map((file) => (
            <Option
              key={file.path}
              label={file.path.split("/").pop() ?? file.path}
              line={file.path}
              on={choice === "repo" && icon?.path === file.path}
              onPick={() => void pick(id, { choice: "repo", path: file.path })}
              preview={<Tile image={file.image} />}
            />
          ))}
          {icon?.uploaded && (
            <Option
              label="Uploaded image"
              line="Kept by Crew, not in the repo"
              on={choice === "upload"}
              onPick={() => void pick(id, { choice: "upload" })}
              preview={<Tile image={icon.uploaded} />}
            />
          )}
          <Option label="Initials" line={workspace.name} on={choice === "initials"} onPick={() => void pick(id, { choice: "initials" })} preview={initials} />
        </div>
        <AddRow onClick={() => chooseImage((file) => void upload(id, file))}>
          <UploadIcon className="size-4 shrink-0" />
          {icon?.uploaded ? "Upload another image" : "Upload an image"}
        </AddRow>
      </PaneCard>
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <p role={problem ? "alert" : undefined} className={`min-w-0 text-[12px] ${problem ? "text-danger" : "text-text-muted"}`}>
          {problem ?? "Favicons, logos and app icons, from the repo's root, public, assets and the like."}
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={RotateCwIcon}
          loading={looking}
          onClick={() => {
            setLooking(true);
            void refresh(id, { look: true, choices: true }).finally(() => setLooking(false));
          }}
        >
          Look again
        </Button>
      </div>
    </div>
  );
}

/** One icon to choose: its preview, what it is, and a check when it is the one. */
function Option({ label, line, on, onPick, preview }: { label: string; line: string; on: boolean; onPick: () => void; preview: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={label}
      onClick={onPick}
      className="group flex min-h-12 w-full items-center gap-3 py-2 text-left outline-none focus-visible:[&_[data-option-label]]:underline"
    >
      {preview}
      <span className="flex min-w-0 flex-1 flex-col">
        <span data-option-label className="truncate text-[13px] leading-[18px] font-medium">
          {label}
        </span>
        <span className="truncate text-[12px] leading-4 text-text-muted">{line}</span>
      </span>
      <CheckIcon aria-hidden className={`size-4 shrink-0 text-text ${on ? "" : "invisible"}`} />
    </button>
  );
}

/** A small tile as the rail draws it: the image contained, never cropped, or the initials on ink. */
function Tile({ image, children }: { image?: string; children?: ReactNode }) {
  return image ? (
    <img src={image} alt="" draggable={false} className="size-7 shrink-0 rounded-lg object-contain" />
  ) : (
    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent text-[10px] font-semibold tracking-wide text-inverse">{children}</span>
  );
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
