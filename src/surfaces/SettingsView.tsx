import { SettingsRow, SettingsSection } from "../chrome/SettingsRow";
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
          {section === "keybindings" && <Keybindings />}
          {section === "terminal" && <TerminalSettings />}
          {section !== "keybindings" && section !== "terminal" && <Pending label={meta.label} />}
        </div>
      </div>
    </div>
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
