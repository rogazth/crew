import {
  BotIcon,
  EyeIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  LayersIcon,
  PanelLeftIcon,
  PanelTopIcon,
  SearchIcon,
  SettingsIcon,
  TextCursorInputIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback } from "react";
import { Kbd } from "./Kbd";
import { Overlay } from "./kit";
import { sheetColumns, type Section } from "../lib/commandGroups";

/** Each section wears a mark; the ones that work only with the focus somewhere wear that place's, so their titles stay names. */
const SECTION_ICONS: Record<Section, LucideIcon> = {
  tabs: PanelTopIcon,
  workspaces: FolderIcon,
  bots: BotIcon,
  services: LayersIcon,
  finding: SearchIcon,
  view: EyeIcon,
  app: SettingsIcon,
  sidebar: PanelLeftIcon,
  prompt: TextCursorInputIcon,
  editor: FileTextIcon,
  browser: GlobeIcon,
};

/** Built from the live bindings and the keybindings page's sections, so a rebinding shows up here without a second list to keep. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const box = useCallback((node: HTMLDivElement | null) => node?.focus(), []);
  return (
    <Overlay onClose={onClose} width="w-[760px]">
      <div
        ref={box}
        tabIndex={-1}
        aria-label="Keyboard shortcuts"
        className="flex max-h-[76vh] items-start gap-8 overflow-y-auto p-5 outline-none"
      >
        {sheetColumns().map((column, index) => (
          <div key={index} className="flex min-w-0 flex-1 flex-col gap-5">
            {column.map((group) => {
              const Mark = SECTION_ICONS[group.id];
              return (
                <div key={group.id} className="flex flex-col">
                  <h3 className="flex items-center gap-1.5 pb-1 text-[11px] font-medium text-text-muted">
                    <Mark className="size-3.5" aria-hidden />
                    {group.title}
                  </h3>
                  {group.rows.map((row) => (
                    <div key={row.label} className="flex h-6.5 items-center gap-3">
                      <span className="min-w-0 flex-1 truncate">{row.label}</span>
                      <span className="flex shrink-0 gap-1">
                        {row.keys.map((chord, index) => (
                          <Kbd key={index} keys={chord} className="h-5 px-1.5 text-[11px]" />
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Overlay>
  );
}
