import { COMMANDS, COMMAND_IDS, commandKeys } from "../lib/commands";
import { settingsSection, type SettingsSectionId } from "../lib/settings";
import { TerminalSettings } from "./TerminalSettings";

export function SettingsView({ section }: { section: SettingsSectionId }) {
  const meta = settingsSection(section);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-[20px] leading-tight font-semibold">{meta.label}</h1>
          <p className="text-kumo-subtle">{meta.blurb}</p>
        </header>
        {section === "keybindings" && <Keybindings />}
        {section === "terminal" && <TerminalSettings />}
        {section !== "keybindings" && section !== "terminal" && <Pending label={meta.label} />}
      </div>
    </div>
  );
}

function Keybindings() {
  return (
    <div className="overflow-hidden rounded-lg ring ring-kumo-line">
      {COMMAND_IDS.map((id, index) => (
        <div
          key={id}
          className={`flex h-9 items-center gap-4 px-3 ${index > 0 ? "border-t border-border" : ""}`}
        >
          <span className="min-w-0 flex-1 truncate">{COMMANDS[id].label}</span>
          <kbd className="shrink-0 font-sans text-[11px] text-kumo-subtle tabular-nums">
            {commandKeys(id)}
          </kbd>
        </div>
      ))}
    </div>
  );
}

function Pending({ label }: { label: string }) {
  return (
    <p className="rounded-lg bg-kumo-fill px-4 py-6 text-placeholder">
      {label} settings are not built yet.
    </p>
  );
}
