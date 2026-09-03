import { Sidebar } from "@cloudflare/kumo";
import { SessionSidebar, type SessionSidebarProps } from "./SessionSidebar";
import { SettingsSidebar } from "./SettingsSidebar";
import { SETTINGS_DEFAULT, type SettingsSectionId } from "../lib/settings";

type Props = {
  settings: SettingsSectionId | null;
  onSelectSettings: (section: SettingsSectionId) => void;
  onCloseSettings: () => void;
  sessions: SessionSidebarProps;
};

/** One sidebar shell; settings slide over the session list rather than opening a tab. */
export function AppSidebar({ settings, onSelectSettings, onCloseSettings, sessions }: Props) {
  return (
    <Sidebar contentClassName="flex h-full flex-col">
      <Sidebar.SlidingViews activeKey={settings ? "settings" : "sessions"}>
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

      <Sidebar.ResizeHandle />
    </Sidebar>
  );
}
