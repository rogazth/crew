import { useRef, type ComponentProps } from "react";
import { SessionSidebar, type SessionSidebarProps } from "./SessionSidebar";
import { SettingsSidebar } from "./SettingsSidebar";
import { SidebarShell, SlidingViews } from "./SidebarShell";
import { TOGGLE_RESERVE } from "../lib/chrome";
import { WorkspaceRail } from "./WorkspaceRail";
import { useSpatialKeys } from "../hooks/useSpatialKeys";
import { SETTINGS_DEFAULT, type SettingsSectionId } from "../lib/settings";

type Props = {
  open: boolean;
  width: number;
  onResize: (width: number) => void;
  settings: SettingsSectionId | null;
  onSelectSettings: (section: SettingsSectionId) => void;
  onCloseSettings: () => void;
  rail: ComponentProps<typeof WorkspaceRail>;
  sessions: SessionSidebarProps;
};

/**
 * The rail of workspaces stays put; the panel beside it is the workspace, or
 * settings sliding over it. One set of arrow keys walks both.
 */
export function AppSidebar({ open, width, onResize, settings, onSelectSettings, onCloseSettings, rail, sessions }: Props) {
  const root = useRef<HTMLDivElement>(null);
  useSpatialKeys(root);

  return (
    <SidebarShell open={open} width={width} minWidth={200} maxWidth={560} onResize={onResize}>
      {/* The traffic lights' strip: a drag region under the lights and the toggle. */}
      {/* 39px, not 40: the panel's top border then lands on the tab strip's bottom border, pixel for pixel. */}
      <div data-tauri-drag-region className="flex h-[39px] shrink-0 items-center">
        {/* The traffic lights and the window-pinned toggle sit over this. */}
        <div className={`h-full shrink-0 ${TOGGLE_RESERVE}`} />
      </div>

      <div ref={root} className="flex min-h-0 flex-1">
        <WorkspaceRail {...rail} />
        <SlidingViews
          active={settings ? "settings" : "sessions"}
          className="min-w-0 rounded-tl-xl border-t border-l border-border bg-canvas/40"
          views={[
            { key: "sessions", node: <SessionSidebar {...sessions} /> },
            {
              key: "settings",
              node: (
                <SettingsSidebar
                  section={settings ?? SETTINGS_DEFAULT}
                  onSelect={onSelectSettings}
                  onClose={onCloseSettings}
                />
              ),
            },
          ]}
        />
      </div>
    </SidebarShell>
  );
}
