import { ArrowLeftIcon, BotIcon, GlobeIcon, InfoIcon, KeyboardIcon, PaletteIcon, SlidersHorizontalIcon, SquareTerminalIcon, type LucideIcon as Icon } from "lucide-react";
import { SidebarRow } from "./SidebarRow";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/settings";

const ICONS: Record<SettingsSectionId, Icon> = {
  general: SlidersHorizontalIcon,
  appearance: PaletteIcon,
  terminal: SquareTerminalIcon,
  browser: GlobeIcon,
  providers: BotIcon,
  keybindings: KeyboardIcon,
  about: InfoIcon,
};

type Props = {
  section: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  onClose: () => void;
};

/** Slides over the session panel while settings are open; the rail stays beside it. */
export function SettingsSidebar({ section, onSelect, onClose }: Props) {
  return (
    <>
      <div className="shrink-0 px-[11px] pt-2.5 pb-3">
        <SidebarRow label="Back" icon={ArrowLeftIcon} onClick={onClose} />
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-[11px]">
        <ul className="flex flex-col gap-0.5">
          {SETTINGS_SECTIONS.map((item) => (
            <li key={item.id}>
              <SidebarRow
                label={item.label}
                icon={ICONS[item.id]}
                active={item.id === section}
                onClick={() => onSelect(item.id)}
              />
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
