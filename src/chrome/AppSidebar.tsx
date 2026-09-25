import { Sidebar } from "@cloudflare/kumo";
import { useRef, type ComponentProps } from "react";
import { SessionSidebar, type SessionSidebarProps } from "./SessionSidebar";
import { SettingsSidebar } from "./SettingsSidebar";
import { TOGGLE_RESERVE } from "../lib/chrome";
import { WorkspaceRail } from "./WorkspaceRail";
import { useSpatialKeys } from "../hooks/useSpatialKeys";
import { SETTINGS_DEFAULT, type SettingsSectionId } from "../lib/settings";

type Props = {
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
export function AppSidebar({ settings, onSelectSettings, onCloseSettings, rail, sessions }: Props) {
  const root = useRef<HTMLDivElement>(null);
  useSpatialKeys(root);

  return (
    <Sidebar contentClassName="flex h-full flex-col">
      {/* The traffic lights' strip: a drag region under the lights and the toggle. */}
      <Sidebar.Header data-tauri-drag-region className="h-10 shrink-0 items-center gap-0 border-b-0 p-0">
        {/* The traffic lights and the window-pinned toggle sit over this. */}
        <div className={`h-full shrink-0 ${TOGGLE_RESERVE}`} />
      </Sidebar.Header>

      <div ref={root} className="flex min-h-0 flex-1">
        <WorkspaceRail {...rail} />
        <Sidebar.SlidingViews
          activeKey={settings ? "settings" : "sessions"}
          className="min-w-0 rounded-tl-xl border-t border-l border-hairline bg-canvas/40"
        >
          <Sidebar.SlidingView value="sessions">
            <SessionSidebar {...sessions} />
          </Sidebar.SlidingView>
          <Sidebar.SlidingView value="settings">
            <SettingsSidebar
              section={settings ?? SETTINGS_DEFAULT}
              onSelect={onSelectSettings}
              onClose={onCloseSettings}
            />
          </Sidebar.SlidingView>
        </Sidebar.SlidingViews>
      </div>

      <Sidebar.ResizeHandle />
    </Sidebar>
  );
}
