import { Input, Select, Switch } from "@cloudflare/kumo";
import { useState } from "react";
import { ModelPicker } from "../chrome/ModelPicker";
import { ProviderIcon } from "../chrome/ProviderIcon";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import { useAgentTheme } from "../hooks/useAgentTheme";
import { useBrowserPrefs } from "../hooks/useBrowserPrefs";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import { useFilePrefs } from "../hooks/useFilePrefs";
import { AGENT_THEMES, type AgentThemeId } from "../lib/agentTheme";
import { KEEP_CHOICES, SEARCH_ENGINES } from "../lib/browserPrefs";
import { COMMANDS, COMMAND_IDS, commandKeys } from "../lib/commands";
import { BROWSER_CLICK } from "../lib/external";
import { parseFolders } from "../lib/filePrefs";
import { PROVIDERS } from "../lib/providers";
import { settingsSection, type SettingsSectionId } from "../lib/settings";
import { TerminalSettings } from "./TerminalSettings";

export function SettingsView({ section }: { section: SettingsSectionId }) {
  const meta = settingsSection(section);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-10 py-12">
        <h1 className="px-2.5 text-[20px] leading-tight font-semibold tracking-[-0.26px]">
          {meta.label}
        </h1>
        <div className="flex flex-col gap-8">
          {section === "general" && <General />}
          {section === "appearance" && <Appearance />}
          {section === "keybindings" && <Keybindings />}
          {section === "terminal" && <TerminalSettings />}
          {section === "browser" && <Browser />}
          {section === "providers" && <Providers />}
          {section !== "general" &&
            section !== "appearance" &&
            section !== "keybindings" &&
            section !== "terminal" &&
            section !== "browser" &&
            section !== "providers" && (
            <Pending label={meta.label} />
          )}
        </div>
      </div>
    </div>
  );
}

function General() {
  const { prefs, update } = useFilePrefs();
  const saved = prefs.include.join(", ");
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    update({ include: parseFolders(draft) });
    setDraft(null);
  };
  return (
    <SettingsSection title="Files">
      <SettingsRow
        label="Always include"
        description="Folders that file search indexes even when git ignores them. Separate them with commas."
      >
        <Input
          aria-label="Always include"
          size="sm"
          className="w-56"
          placeholder=".ai, .claude"
          value={draft ?? saved}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => event.key === "Enter" && save()}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

function Appearance() {
  const { theme, update } = useAgentTheme();
  return (
    <SettingsSection title="Agents">
      <SettingsRow label="Agent theme" description="Layout and chrome for every agent chat.">
        <Select
          aria-label="Agent theme"
          size="sm"
          className="w-40"
          value={theme}
          onValueChange={(value) => value && update(value as AgentThemeId)}
          items={AGENT_THEMES.map((item) => ({ value: item.id, label: item.label }))}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

function Browser() {
  const { prefs, update } = useBrowserPrefs();
  return (
    <>
      <SettingsSection title="Links">
        <SettingsRow
          label="Open links in Crew"
          description={
            prefs.openLinksInCrew
              ? `Links in agent chats and terminals open as a new page here. ${BROWSER_CLICK}-click one to open it in your default browser instead.`
              : "Links in agent chats and terminals open as a new page here. Off sends them to your default browser."
          }
        >
          <Switch
            aria-label="Open links in Crew"
            variant="neutral"
            checked={prefs.openLinksInCrew}
            onCheckedChange={(checked) => update({ ...prefs, openLinksInCrew: checked })}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Pages">
        <SettingsRow label="Search engine" description="Where the address bar sends anything that isn't an address.">
          <Select
            aria-label="Search engine"
            size="sm"
            className="w-40"
            value={prefs.searchTemplate}
            onValueChange={(value) => value && update({ ...prefs, searchTemplate: value })}
            items={SEARCH_ENGINES.map((engine): { value: string; label: string } => ({
              value: engine.template,
              label: engine.label,
            }))}
          />
        </SettingsRow>
        <SettingsRow
          label="Background pages"
          description="Hidden tabs that stay loaded for an instant switch back. Each one is a process; the rest reload when shown."
        >
          <Select
            aria-label="Background pages"
            size="sm"
            className="w-40"
            value={String(prefs.keep)}
            onValueChange={(value) => value && update({ ...prefs, keep: Number(value) })}
            items={KEEP_CHOICES.map((keep) => ({ value: String(keep), label: String(keep) }))}
          />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

function Providers() {
  const { preferred, installed, update } = useDefaultAgent();
  return (
    <>
      <SettingsSection title="New sessions">
        <SettingsRow
          label="Default agent"
          description={`What ${commandKeys("new-session")} opens. Default runs the model the CLI is configured with.`}
        >
          <div className="w-72">
            <ModelPicker
              provider={preferred.provider}
              model={preferred.model}
              onChange={(provider, model) => update({ provider, model })}
            />
          </div>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Installed">
        {PROVIDERS.map((provider) => {
          const found = installed.includes(provider);
          return (
            <SettingsRow key={provider.id} label={provider.label} description={provider.binary}>
              <ProviderIcon provider={provider.id} className="size-4" />
              <span className={found ? "text-kumo-default" : "text-kumo-subtle"}>
                {found ? "Installed" : "Not found"}
              </span>
            </SettingsRow>
          );
        })}
      </SettingsSection>
    </>
  );
}

function Keybindings() {
  return (
    <SettingsSection>
      {COMMAND_IDS.map((id) => (
        <SettingsRow key={id} label={COMMANDS[id].label}>
          <kbd className="font-sans text-[12px] text-kumo-subtle tabular-nums">
            {commandKeys(id)}
          </kbd>
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}

function Pending({ label }: { label: string }) {
  return (
    <SettingsSection>
      <p className="py-4 text-kumo-subtle">{label} settings are not built yet.</p>
    </SettingsSection>
  );
}
