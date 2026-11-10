// What the user writes about a workspace for every session and bot in it, over its settings page's General: the
// instructions (`crew_core::workspace::description`) and the rules (`w3`), which only the user writes. Crew hands
// them to its bots every turn, to a subagent on its first, and to a session of the user's when it starts.
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "./kit";
import { Kept, Section } from "./SettingsSection";
import { useRules } from "../hooks/useRules";
import * as api from "../lib/api";
import { newRuleRow } from "../lib/rules";
import type { Workspace } from "../lib/types";

export function WorkspaceProfileSections({ workspace }: { workspace: Workspace }) {
  return (
    <>
      <Instructions workspace={workspace} />
      <Rules workspace={workspace} />
    </>
  );
}

/** Free text, kept when the edit ends; the repo's AGENTS.md and CLAUDE.md are read besides it. */
function Instructions({ workspace }: { workspace: Workspace }) {
  const [description, setDescription] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getWorkspaceProfile(workspace.id)
      .then((profile) => !cancelled && setDescription(profile.description))
      .catch(() => !cancelled && setError("The instructions could not be read."));
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  const keep = (text: string) => {
    setDescription(text);
    setError(null);
    api
      .saveWorkspaceProfile(workspace.id, { description: text, add: [], edit: [], remove: [] })
      .then((profile) => setDescription(profile.description))
      .catch((failure) => setError(failure instanceof Error ? failure.message : String(failure)));
  };

  return (
    <Section title="Instructions">
      <div className="rounded-xl bg-card px-4">
        {description === null && !error ? (
          <p className="py-3.5 text-[13px] text-text-muted">Reading…</p>
        ) : (
          <Kept
            value={description ?? ""}
            onKeep={keep}
            onEmpty={() => description && keep("")}
            placeholder="What every agent here should know about this project."
            className="block min-h-[132px] w-full py-3.5 text-[13.5px] leading-[21px]"
          />
        )}
      </div>
      <p className="mt-1.5 text-[11.5px] text-text-muted">
        Every bot and session here reads these, besides the repo's AGENTS.md and CLAUDE.md.
      </p>
      {error && <p className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </Section>
  );
}

/** One rule a row, edited in place; emptied, it goes. */
function Rules({ workspace }: { workspace: Workspace }) {
  const { rows, error, commit } = useRules({ kind: "workspace", id: workspace.id });
  const [adding, setAdding] = useState(false);
  return (
    <Section title="Rules">
      <div className="rounded-xl bg-card px-4 [&>*+*]:border-t [&>*+*]:border-hairline">
        {rows === null && !error && <p className="py-3 text-[13px] text-text-muted">Reading…</p>}
        {rows?.map((row) => (
          <div key={row.key} className="group flex items-start gap-3 py-2">
            <Kept
              single
              value={row.text}
              onKeep={(text) => void commit(rows.map((other) => (other.key === row.key ? { ...other, text } : other)))}
              onEmpty={() => void commit(rows.filter((other) => other.key !== row.key))}
              className="min-w-0 flex-1 py-1 text-[13px] leading-[18px]"
            />
            <IconButton
              icon={Trash2Icon}
              label="Remove rule"
              className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => void commit(rows.filter((other) => other.key !== row.key))}
            />
          </div>
        ))}
        {rows &&
          (adding ? (
            <div className="py-2">
              <Kept
                autoFocus
                single
                value=""
                placeholder="Never deploy on Fridays"
                onKeep={(text) => {
                  setAdding(false);
                  void commit([...rows, { ...newRuleRow(), text }]);
                }}
                onEmpty={() => setAdding(false)}
                className="w-full py-1 text-[13px] leading-[18px]"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex h-11 w-full items-center gap-2 text-[13px] text-text-muted hover:text-text"
            >
              <PlusIcon className="size-4" /> Add a rule
            </button>
          ))}
      </div>
      {error && <p className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </Section>
  );
}
