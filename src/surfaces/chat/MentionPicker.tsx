import { BotAvatar } from "../../chrome/BotAvatar";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { ChevronRightIcon, FileIcon, GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { TreeMention } from "../../lib/agentMentions";
import { useNow } from "../../hooks/useNow";
import { elapsed } from "../../lib/time";
import type { ProjectFile, Session } from "../../lib/types";
import { pickerStyle } from "./usePickerAnchor";

type Props = {
  results: ProjectFile[];
  active: number;
  onHover: (index: number) => void;
  onPick: (file: ProjectFile) => void;
  /** Where its trigger sits, from the well's left edge. */
  left?: number | null;
};

/** Sits above the well while an `@` is being typed. The keyboard lives in the composer. */
export function MentionPicker({ results, active, onHover, onPick, left }: Props) {
  return (
    <div role="listbox" aria-label="Files" className="crew-popover crew-picker" style={pickerStyle(left)}>
      {results.length === 0 ? (
        <p className="px-2 py-2 text-[12px] leading-4 text-text-muted">No matching files</p>
      ) : (
        results.map((file, index) => {
          const dir = file.relative.slice(0, -file.name.length);
          return (
            <button
              key={file.path}
              type="button"
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(file)}
              className={`flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] ${index === active ? "bg-hover" : ""}`}
            >
              <FileTypeIcon name={file.name} className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                <span>{file.name}</span>
                {dir && <span className="ml-2 text-text-muted">{dir.replace(/\/$/, "")}</span>}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

type AgentProps = {
  results: Session[];
  /** The repo's worktrees that match, after the agents. */
  trees?: TreeMention[];
  /** The files that match what is typed, after the worktrees. */
  files?: ProjectFile[];
  active: number;
  onHover: (index: number) => void;
  onPick: (target: Session | TreeMention) => void;
  onPickFile: (file: ProjectFile) => void;
  /** The last row: the same `@` searches the files alone. */
  onFiles: () => void;
  left?: number | null;
};

const ROW = "flex h-8 w-full items-center gap-1.5 px-2 text-left text-[13px]";

/**
 * The `@` menu: the workspace's bots and sessions, its repo's worktrees and the files that match, then a row
 * into the files alone. The icon says what each is; an agent's right edge says how it is now, or when it last moved.
 */
export function AgentPicker({ results, trees = [], files = [], active, onHover, onPick, onPickFile, onFiles, left }: AgentProps) {
  const now = useNow(60_000);
  const treesAt = results.length;
  const filesAt = treesAt + trees.length;
  const moreAt = filesAt + files.length;
  const row = (index: number, key: string, onClick: () => void, icon: ReactNode, name: ReactNode, aside?: ReactNode) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={index === active}
      onMouseEnter={() => onHover(index)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`${ROW} ${index === active ? "bg-hover" : ""}`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 truncate">{name}</span>
      {aside && <span className="ml-auto flex shrink-0 items-center pl-2 text-[12px] text-text-muted">{aside}</span>}
    </button>
  );
  return (
    <div role="listbox" aria-label="Mentions" className="crew-popover crew-picker" style={pickerStyle(left)}>
      {results.map((agent, index) =>
        row(
          index,
          agent.id,
          () => onPick(agent),
          agent.kind === "bot" ? (
            <BotAvatar seed={agent.id} bare className="size-4" />
          ) : (
            <ProviderIcon provider={agent.provider} className="size-3.5" />
          ),
          agent.name,
          agent.status !== "idle" ? agent.status.replace(/-/g, " ") : elapsed(agent.updatedAt, now),
        ),
      )}
      {trees.map((tree, index) =>
        row(
          treesAt + index,
          tree.path,
          () => onPick(tree),
          <GitBranchIcon className="size-3.5 text-icon" aria-hidden />,
          tree.name,
        ),
      )}
      {files.map((file, index) => {
        const dir = file.relative.slice(0, -file.name.length).replace(/\/$/, "");
        return row(
          filesAt + index,
          file.path,
          () => onPickFile(file),
          <FileTypeIcon name={file.name} className="size-3.5" />,
          <>
            {file.name}
            {dir && <span className="ml-2 text-text-muted">{dir}</span>}
          </>,
        );
      })}
      {moreAt > 0 && <div role="separator" className="mx-2 my-1 h-px bg-hairline" />}
      {row(
        moreAt,
        "files",
        onFiles,
        <FileIcon className="size-3.5 text-icon" aria-hidden />,
        "Files",
        <ChevronRightIcon className="size-3.5" aria-hidden />,
      )}
    </div>
  );
}
