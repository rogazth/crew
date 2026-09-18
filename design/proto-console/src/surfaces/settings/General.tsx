import { PROVIDERS, modelsOf } from "@crew/fixtures";
import { Card, Row, Select, Switch, type SelectOption } from "@/ui";
import { ModelPicker } from "@/chrome/ModelPicker";
import { useApp } from "@/lib/store";
import { setLocal, useLocal } from "./local";

const PROVIDER_OPTIONS: Array<SelectOption<string>> = PROVIDERS.map((provider) => ({
  id: provider.id,
  label: provider.label,
  note: provider.binary,
}));

export function General() {
  const state = useApp();
  const local = useLocal();
  const workspace = state.workspaces.find((w) => w.id === state.workspaceId);
  const count = state.workspaces.length;

  return (
    <>
      <Card title="Workspace">
        <Row
          label="Active workspace"
          description={`Sessions, tabs and routines are scoped to it. ${count} workspaces are open in this window; ⇧⌘O switches.`}
          control={
            <span className="font-mono text-sm text-ink-3">{workspace?.path ?? "—"}</span>
          }
        />
      </Card>

      <Card title="Defaults">
        <Row
          label="Default provider"
          description="Which CLI a new agent runs on when the launcher does not say otherwise."
          control={
            <Select
              value={local.defaultProvider}
              options={PROVIDER_OPTIONS}
              onChange={(next) =>
                setLocal({
                  defaultProvider: next,
                  defaultModel: modelsOf(next)[0]?.id ?? "",
                })
              }
              label="Default provider"
              shape="chip"
            />
          }
        />
        <Row
          label="Default model"
          description="What a new agent opens with. Choosing a model from another provider moves the default provider with it."
          control={
            <ModelPicker
              provider={local.defaultProvider}
              model={local.defaultModel}
              shape="chip"
              onChange={(next) =>
                setLocal({ defaultProvider: next.provider, defaultModel: next.model })
              }
            />
          }
        />
      </Card>

      <Card title="Startup">
        <Row
          label="Reopen last workspace on launch"
          description="Start where you left off, with the tab strip restored. Off means Crew opens on the workspace list."
          control={
            <Switch
              label="Reopen last workspace on launch"
              checked={local.reopenWorkspace}
              onChange={(next) => setLocal({ reopenWorkspace: next })}
            />
          }
        />
        <Row
          label="Confirm before closing a live session"
          description="A tab that is still working, or waiting on an answer, asks first. The session keeps running either way."
          control={
            <Switch
              label="Confirm before closing a live session"
              checked={local.confirmLiveClose}
              onChange={(next) => setLocal({ confirmLiveClose: next })}
            />
          }
        />
        <Row
          label="Send anonymous usage"
          description="Counts only: sessions started, tools run, errors seen. Never prompts, code, paths or file names."
          control={
            <Switch
              label="Send anonymous usage"
              checked={local.telemetry}
              onChange={(next) => setLocal({ telemetry: next })}
            />
          }
        />
      </Card>

      <p className="text-sm text-ink-4">
        The defaults and the three switches above are remembered by this window only — the daemon
        has nowhere to store them yet, so they reset when Crew quits.
      </p>
    </>
  );
}
