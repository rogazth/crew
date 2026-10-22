import { BotAvatar } from "../../chrome/BotAvatar";
import { FileTypeIcon } from "../../chrome/FileTypeIcon";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { agentKind } from "../../lib/agentMentions";
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
        <p className="px-3 py-2 text-[12px] leading-4 text-text-muted">No matching files</p>
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
              className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] ${
                index === active ? "bg-hover" : ""
              }`}
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

const KIND_LABEL: Record<string, string> = { bot: "Bot", session: "Session", subagent: "Subagent" };

type AgentProps = {
  results: Session[];
  active: number;
  onHover: (index: number) => void;
  onPick: (agent: Session) => void;
  left?: number | null;
};

/** The `#` menu: the workspace's bots and sessions, each with what it is and how it is now. */
export function AgentPicker({ results, active, onHover, onPick, left }: AgentProps) {
  return (
    <div role="listbox" aria-label="Bots and sessions" className="crew-popover crew-picker" style={pickerStyle(left)}>
      {results.length === 0 ? (
        <p className="px-3 py-2 text-[12px] leading-4 text-text-muted">No matching bots or sessions</p>
      ) : (
        results.map((agent, index) => (
          <button
            key={agent.id}
            type="button"
            role="option"
            aria-selected={index === active}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(agent)}
            className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] ${index === active ? "bg-hover" : ""}`}
          >
            {agent.kind === "bot" ? (
              <BotAvatar seed={agent.id} bare className="size-4 shrink-0" />
            ) : (
              <ProviderIcon provider={agent.provider} className="size-3.5" />
            )}
            <span className="min-w-0 truncate">{agent.name}</span>
            <span className="ml-auto shrink-0 text-[12px] text-text-muted">
              {KIND_LABEL[agentKind(agent)]}
              {agent.status !== "idle" && ` · ${agent.status}`}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
