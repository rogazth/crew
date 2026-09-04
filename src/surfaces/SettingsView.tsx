import { Select } from "@cloudflare/kumo";
import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
import { useAgentTheme } from "../hooks/useAgentTheme";
import { AGENT_THEMES, type AgentThemeId } from "../lib/agentTheme";
import { COMMANDS, COMMAND_IDS, commandKeys } from "../lib/commands";
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
          {section === "appearance" && <Appearance />}
          {section === "keybindings" && <Keybindings />}
          {section === "terminal" && <TerminalSettings />}
          {section !== "appearance" && section !== "keybindings" && section !== "terminal" && (
            <Pending label={meta.label} />
          )}
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
