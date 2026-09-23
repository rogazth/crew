import { Select } from "@cloudflare/kumo";
import { ModelPicker } from "../chrome/ModelPicker";
import { ProviderIcon } from "../chrome/ProviderIcon";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import { useAgentTheme } from "../hooks/useAgentTheme";
import { useDefaultAgent } from "../hooks/useDefaultAgent";
import { AGENT_THEMES, type AgentThemeId } from "../lib/agentTheme";
import { COMMANDS, COMMAND_IDS, commandKeys } from "../lib/commands";
import { PROVIDERS } from "../lib/providers";
import { settingsSection, type SettingsSectionId } from "../lib/settings";
import { settingsBody } from "../lib/settingsView";
import { TerminalSettings } from "./TerminalSettings";

export function SettingsView({ section }: { section: SettingsSectionId }) {
  const meta = settingsSection(section);
  const body = settingsBody(section);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-10 py-12">
        <h1 className="px-2.5 text-[20px] leading-tight font-semibold tracking-[-0.26px]">
          {meta.label}
        </h1>
        <div className="flex flex-col gap-8">
          {body === "appearance" && <Appearance />}
          {body === "keybindings" && <Keybindings />}
          {body === "terminal" && <TerminalSettings />}
          {body === "providers" && <Providers />}
          {body === "pending" && <Pending label={meta.label} />}
        </div>
      </div>
    </div>
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
