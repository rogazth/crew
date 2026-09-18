import { useEffect, useMemo, useState } from "react";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, identityFor } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { Icon } from "@/lib/icon";
import { useApp } from "@/lib/store";
import { Avatar, Button, Dialog, Field, Input, Kbd, SettingRow, Switch, Textarea } from "@/ui";
import { ModelField } from "./ModelPicker";
import { CreatedByLine } from "./SidebarRow";

type Draft = {
  name: string;
  provider: string;
  model: string;
  description: string;
  autonomy: "ask" | "full";
  notifications: boolean;
};

const EMPTY: Draft = {
  name: "",
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  description: "",
  autonomy: "ask",
  notifications: true,
};

/**
 * The right-side drawer. It is elevation 3 with a backdrop because it is modal;
 * everything inside it stays at levels 0 and 1, so the sheet reads as one plane.
 */
export function AgentSheet() {
  const { sheet, sessions, actions } = useApp();
  const editing = useMemo(
    () => sessions.find((s) => s.id === sheet.sessionId) ?? null,
    [sessions, sheet.sessionId],
  );
  const [draft, setDraft] = useState<Draft>(EMPTY);

  useEffect(() => {
    if (!sheet.open) return;
    setDraft(
      editing
        ? {
            name: editing.name,
            provider: editing.provider,
            model: editing.model,
            description: editing.description,
            autonomy: editing.autonomy,
            notifications: editing.notifications,
          }
        : EMPTY,
    );
  }, [sheet.open, editing]);

  const duplicate = sessions.some(
    (s) => s.id !== editing?.id && s.name.trim().toLowerCase() === draft.name.trim().toLowerCase(),
  );
  const valid = draft.name.trim().length > 0 && !duplicate;

  const submit = () => {
    if (!valid) return;
    if (editing) {
      actions.updateSession(editing.id, {
        name: draft.name.trim(),
        provider: draft.provider,
        model: draft.model,
        description: draft.description,
        autonomy: draft.autonomy,
        notifications: draft.notifications,
      });
    } else {
      actions.createSession({
        name: draft.name.trim(),
        provider: draft.provider,
        model: draft.model,
        description: draft.description,
        autonomy: draft.autonomy,
        notifications: draft.notifications,
      });
    }
    actions.closeSheet();
  };

  const seed = draft.name.trim() || "new agent";

  return (
    <Dialog
      open={sheet.open}
      onOpenChange={(next) => !next && actions.closeSheet()}
      side="right"
      width={380}
    >
      <form
        className="flex h-full min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      >
        <header className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--stroke-tertiary)] px-3">
          <h2 className="text-body font-[var(--weight-medium)] text-primary">
            {editing ? "Edit agent" : "New agent"}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => actions.closeSheet()}
            className="flex size-6 items-center justify-center rounded-md text-icon-faint transition-colors hover:bg-[var(--fill-tertiary)] hover:text-icon"
          >
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="ink-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
          <div className="flex items-center gap-3">
            <Avatar seed={seed} size={48} />
            <div className="min-w-0">
              <p className="text-body text-primary">{draft.name.trim() || "Unnamed agent"}</p>
              <p className="text-micro text-tertiary">
                Mark derived from the name · hue {identityFor(seed).hue}°
              </p>
              {editing && <CreatedByLine session={editing} />}
            </div>
          </div>

          <Field
            label="Name"
            {...(duplicate ? { error: "Another agent already has this name." } : {})}
          >
            <Input
              autoFocus
              size="lg"
              value={draft.name}
              invalid={duplicate}
              placeholder="harness"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </Field>

          <Field label="Model">
            <ModelField
              value={{ provider: draft.provider, model: draft.model }}
              onChange={(next) => setDraft({ ...draft, provider: next.provider, model: next.model })}
            />
          </Field>

          <Field label="Description" hint="What this agent owns. Other agents read it.">
            <Textarea
              rows={4}
              value={draft.description}
              placeholder="Owns the provider harness: adapters, streaming, tool normalisation."
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </Field>

          <div className="overflow-hidden rounded-card bg-chrome hairline [&>*+*]:border-t [&>*+*]:border-[var(--stroke-tertiary)]">
            <SettingRow
              label="Run autonomously"
              description="Never asks permission before a tool call."
              control={
                <Switch
                  checked={draft.autonomy === "full"}
                  onCheckedChange={(next) => setDraft({ ...draft, autonomy: next ? "full" : "ask" })}
                />
              }
            />
            <SettingRow
              label="Notifications"
              description="Tell me when this agent finishes or needs input."
              control={
                <Switch
                  checked={draft.notifications}
                  onCheckedChange={(next) => setDraft({ ...draft, notifications: next })}
                />
              }
            />
          </div>

          {editing && (
            <Button
              icon="routine"
              block
              onClick={() => {
                actions.closeSheet();
                actions.openRoutines(null);
              }}
            >
              New routine
            </Button>
          )}
        </div>

        <footer className="flex h-12 shrink-0 items-center justify-end gap-2 border-t border-[var(--stroke-tertiary)] px-3">
          <Button type="button" onClick={() => actions.closeSheet()} trailing={<Kbd className="ml-1">Esc</Kbd>}>
            Cancel
          </Button>
          <Button
            type="submit"
            tone="primary"
            disabled={!valid}
            trailing={<Kbd className={cx("ml-1", "bg-[var(--fill-secondary)]")}>⌘⏎</Kbd>}
          >
            {editing ? "Save" : "Create"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
