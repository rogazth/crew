import { Sidebar } from "@cloudflare/kumo";
import {
  ArrowLeftIcon,
  InfoIcon,
  KeyboardIcon,
  PaletteIcon,
  RobotIcon,
  SlidersHorizontalIcon,
  TerminalWindowIcon,
  type Icon,
} from "@phosphor-icons/react";
import { IS_MAC } from "../lib/hotkey";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/settings";

const ICONS: Record<SettingsSectionId, Icon> = {
  general: SlidersHorizontalIcon,
  appearance: PaletteIcon,
  terminal: TerminalWindowIcon,
  providers: RobotIcon,
  keybindings: KeyboardIcon,
  about: InfoIcon,
};

type Props = {
  section: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  onClose: () => void;
};

/** Replaces the session list while settings are open; R1's SettingsRail. */
export function SettingsSidebar({ section, onSelect, onClose }: Props) {
  return (
    <>
      {/* The traffic lights keep their strip, so leaving settings starts below them
          and both sidebar views share one hairline while they slide. */}
      <Sidebar.Header
        data-tauri-drag-region
        className="h-10 shrink-0 border-b border-border p-0"
      >
        {IS_MAC && <div className="h-full w-[78px]" />}
      </Sidebar.Header>

      {/* Its own block, so the rule under it runs the full width of the rail the way
          every other hairline in the chrome does. `px-[11px]` is kumo's own content
          inset, which Sidebar.Content adds inside whatever padding it is given. */}
      <div className="shrink-0 border-b border-border px-[11px] py-2">
        <Row label="Back to app" icon={ArrowLeftIcon} onClick={onClose} />
      </div>

      <Sidebar.Content className="min-h-0 flex-1">
        <Sidebar.Menu className="gap-0.5">
          {SETTINGS_SECTIONS.map((item) => (
            <Sidebar.MenuItem key={item.id}>
              <Row
                label={item.label}
                icon={ICONS[item.id]}
                active={item.id === section}
                onClick={() => onSelect(item.id)}
              />
            </Sidebar.MenuItem>
          ))}
        </Sidebar.Menu>
      </Sidebar.Content>
    </>
  );
}

function Row({
  label,
  icon: Glyph,
  active = false,
  onClick,
}: {
  label: string;
  icon: Icon;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors ${
        active
          ? "bg-selected text-kumo-default before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-kumo-default"
          : "text-kumo-subtle hover:bg-hover hover:text-kumo-default"
      }`}
    >
      <Glyph className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
    </button>
  );
}
