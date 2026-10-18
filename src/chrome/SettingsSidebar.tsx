import { ArrowLeftIcon, BellIcon, BotIcon, GlobeIcon, InfoIcon, KeyboardIcon, PaletteIcon, ServerIcon, SlidersHorizontalIcon, SquareTerminalIcon, type LucideIcon as Icon } from "lucide-react";
import { lazy, Suspense } from "react";
import { SidebarRow } from "./SidebarRow";
import { useRedesign } from "../prototype/design-system/direction";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/settings";

const ICONS: Record<SettingsSectionId, Icon> = {
  general: SlidersHorizontalIcon,
  appearance: PaletteIcon,
  notifications: BellIcon,
  terminal: SquareTerminalIcon,
  browser: GlobeIcon,
  environments: ServerIcon,
  providers: BotIcon,
  keybindings: KeyboardIcon,
  about: InfoIcon,
};

type Props = {
  section: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  onClose: () => void;
};

// PROTOTYPE — throwaway: with a redesign direction on (dev only), the redesigned nav stands in.
const SettingsNav = lazy(() =>
  import("../prototype/design-system/settings/SettingsNav").then((m) => ({ default: m.SettingsNav })),
);

/** Slides over the session panel while settings are open; the rail stays beside it. */
export function SettingsSidebar(props: Props) {
  const redesign = useRedesign();
  if (redesign)
    return (
      <Suspense>
        <SettingsNav {...props} />
      </Suspense>
    );
  return <ClassicSettingsSidebar {...props} />;
}

function ClassicSettingsSidebar({ section, onSelect, onClose }: Props) {
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
