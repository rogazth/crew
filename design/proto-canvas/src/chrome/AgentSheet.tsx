import { useMemo, useState } from "react";
import { formatChord, type Session } from "@crew/fixtures";
import { useStore } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Icon } from "@/ui/Icon";
import { Input, Textarea } from "@/ui/Input";
import { Kbd } from "@/ui/Kbd";
import { Toggle } from "@/ui/Toggle";
import { ModelPicker } from "./ModelPicker";

export function AgentSheet({ mode, sessionId }: { mode: "create" | "edit"; sessionId?: string }) {
  const { sessions, sessionById, createSession, updateSession, setDrawer, setPage, openSession, toast } = useStore();
  const existing = sessionId ? sessionById(sessionId) : undefined;

  const [name, setName] = useState(existing?.name ?? "");
  const [provider, setProvider] = useState(existing?.provider ?? "claude");
  const [model, setModel] = useState(existing?.model ?? "claude-opus-5");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [autonomy, setAutonomy] = useState((existing?.autonomy ?? "ask") === "full");
  const [notifications, setNotifications] = useState(existing?.notifications ?? true);

  const duplicate = useMemo(
    () =>
      name.trim().length > 0 &&
      sessions.some((s) => s.id !== existing?.id && s.name.toLowerCase() === name.trim().toLowerCase()),
    [name, sessions, existing],
  );

  const valid = name.trim().length > 0 && !duplicate;

  const submit = () => {
    if (!valid) return;
    const patch: Partial<Session> = {
      name: name.trim(),
      provider,
      model,
      description,
      autonomy: autonomy ? "full" : "ask",
      notifications,
    };
    if (mode === "edit" && existing) {
      updateSession(existing.id, patch);
      toast(`Saved ${patch.name}`);
    } else {
      const created = createSession({ ...patch, name: name.trim() });
      openSession(created.id);
      toast(`Created ${created.name}`);
    }
    setDrawer(null);
  };

  return (
    <form
      className="flex h-full flex-col"
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
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--line-soft)] px-4">
        <h2 className="flex-1 text-md font-semibold">{mode === "edit" ? "Edit agent" : "New agent"}</h2>
        <button
          type="button"
          onClick={() => setDrawer(null)}
          aria-label="Close"
          className="rise-1 grid size-7 place-items-center rounded-chip text-ink-52 hover:bg-sunken hover:text-ink"
        >
          <Icon name="x" size={15} />
        </button>
      </header>

      <div className="scroller min-h-0 flex-1 px-4 py-5">
        <div className="mb-5 flex items-center gap-3.5">
          <span className="rounded-full bg-raised p-1 el-2">
            <Avatar seed={name.trim() || "new agent"} size={64} />
          </span>
          <div className="min-w-0">
            <p className="text-base font-medium text-ink">{name.trim() || "Unnamed agent"}</p>
            <p className="mt-0.5 text-sm text-ink-52">
              The face is generated from the name — rename and it changes.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <Field
            label="Name"
            htmlFor="agent-name"
            {...(duplicate ? { error: "Another agent already has that name." } : {})}
          >
            <Input
              id="agent-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="harness"
            />
          </Field>

          <Field label="Model">
            <ModelPicker
              provider={provider}
              model={model}
              onChange={(nextProvider, nextModel) => {
                setProvider(nextProvider);
                setModel(nextModel);
              }}
            />
          </Field>

          <Field label="Description" hint="What this agent owns. Shown in the sidebar and the palette.">
            <Textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Owns the provider harness: adapters, streaming, tool normalisation."
            />
          </Field>

          <SwitchCard
            title="Run autonomously"
            description="Skip the approval card for tools this agent is allowed to use."
            checked={autonomy}
            onChange={setAutonomy}
          />
          <SwitchCard
            title="Notifications"
            description="Tell me when this agent finishes a turn or needs an answer."
            checked={notifications}
            onChange={setNotifications}
          />

          {mode === "edit" && (
            <Button
              icon="repeat"
              variant="default"
              block
              onClick={() => {
                setDrawer(null);
                setPage({ kind: "routines" });
              }}
            >
              New routine
            </Button>
          )}
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--line-soft)] px-4 py-3">
        <Button variant="ghost" onClick={() => setDrawer(null)} trailing={<Kbd>Esc</Kbd>}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!valid}
          trailing={<Kbd tone="on-accent">{formatChord({ key: "Enter", mod: true })}</Kbd>}
        >
          {mode === "edit" ? "Save" : "Create"}
        </Button>
      </footer>
    </form>
  );
}

function SwitchCard({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-card bg-raised px-3.5 py-3 el-1">
      <div className="min-w-0">
        <p className="text-base text-ink">{title}</p>
        <p className="mt-0.5 text-sm text-ink-52">{description}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  );
}
