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
import { SidebarRow } from "./SidebarRow";
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
      <Sidebar.Header data-tauri-drag-region className="h-10 shrink-0 border-b-0 p-0">
        {IS_MAC && <div className="h-full w-[78px]" />}
      </Sidebar.Header>

      <div className="shrink-0 px-[11px] pb-3">
        <SidebarRow label="Back" icon={ArrowLeftIcon} onClick={onClose} />
      </div>

      <Sidebar.Content className="min-h-0 flex-1">
        <Sidebar.Menu className="gap-0.5">
          {SETTINGS_SECTIONS.map((item) => (
            <Sidebar.MenuItem key={item.id}>
              <SidebarRow
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
