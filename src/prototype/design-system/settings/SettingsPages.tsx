// PROTOTYPE — throwaway. One redesigned settings page per section: the new
// pages, and today's components for the rest inside the new frame. Mounted by
// SettingsView when a direction is on, and by the standalone `?prototype=settings`.
import { MonitorSmartphoneIcon } from "lucide-react";
import { Component, type ReactNode } from "react";
import type { ProviderId } from "../../../lib/providers";
import type { SettingsSectionId } from "../../../lib/settings";
import type { Workspace } from "../../../lib/types";
import { NotificationSettings } from "../../../surfaces/NotificationSettings";
import { BrowserSettings } from "../../../surfaces/SettingsView";
import { TerminalSettings } from "../../../surfaces/TerminalSettings";
import { AboutPage } from "./AboutPage";
import { AppearancePage } from "./AppearancePage";
import { EnvironmentsPage } from "./EnvironmentsPage";
import { GeneralPage } from "./GeneralPage";
import { KeybindingsPage } from "./KeybindingsPage";
import { PAGES } from "./pages";
import { ProvidersPage } from "./ProvidersPage";
import { SettingsPage, Toasts } from "./ui";

export type RedesignedSettingsProps = {
  section: SettingsSectionId;
  workspaces?: Workspace[] | undefined;
  onOpenTerminal?: ((envId: string) => Promise<void>) | undefined;
  /** What `which` found, in the app; the mock decides in the browser. */
  installed?: ProviderId[] | undefined;
  /** No Electron host and no daemon: pages that need them say so instead of hanging. */
  standalone?: boolean | undefined;
};

export function RedesignedSettingsPage({ section, workspaces = [], onOpenTerminal, installed, standalone = false }: RedesignedSettingsProps) {
  return (
    <>
      <Page
        key={section}
        section={section}
        workspaces={workspaces}
        onOpenTerminal={onOpenTerminal}
        installed={installed}
        standalone={standalone}
      />
      <Toasts />
    </>
  );
}

function Page({ section, installed, standalone }: RedesignedSettingsProps) {
  switch (section) {
    case "general":
      return <GeneralPage />;
    case "appearance":
      return <AppearancePage />;
    case "providers":
      return <ProvidersPage installed={installed} />;
    case "keybindings":
      return <KeybindingsPage />;
    case "about":
      return <AboutPage />;
    case "notifications":
      return (
        <Legacy section={section} standalone={standalone}>
          <NotificationSettings />
        </Legacy>
      );
    case "terminal":
      return (
        <Legacy section={section} standalone={standalone}>
          <TerminalSettings />
        </Legacy>
      );
    case "browser":
      return (
        <Legacy section={section} standalone={standalone}>
          <BrowserSettings />
        </Legacy>
      );
    case "environments":
      return <EnvironmentsPage />;
  }
}

/** Today's settings components, in the new frame. */
function Legacy({
  section,
  standalone,
  needs,
  children,
}: {
  section: SettingsSectionId;
  standalone?: boolean | undefined;
  needs?: "host" | "daemon";
  children: ReactNode;
}) {
  const meta = PAGES[section];
  const missing = standalone && needs !== undefined;
  return (
    <SettingsPage title={meta.label}>
      <div className="flex flex-col gap-8">
        {missing ? <NeedsApp label={meta.label} what={needs!} /> : <Guard label={meta.label}>{children}</Guard>}
      </div>
    </SettingsPage>
  );
}

function NeedsApp({ label, what }: { label: string; what: "host" | "daemon" }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl bg-card px-6 py-12 text-center">
      <span className="grid size-10 place-items-center rounded-[12px] bg-fill text-icon">
        <MonitorSmartphoneIcon className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="font-medium">{label} needs the app</p>
        <p className="max-w-sm text-[12px] text-text-muted">
          {what === "daemon" ? "Requires crewd. Open in the Crew app." : "Requires macOS access. Open in the Crew app."}
        </p>
      </div>
    </div>
  );
}

/** A page that throws without its host shows the placeholder, not a blank sheet. */
class Guard extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <NeedsApp label={this.props.label} what="host" /> : this.props.children;
  }
}
