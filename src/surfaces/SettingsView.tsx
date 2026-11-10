import { useEffect, useState, type ReactNode } from "react";
import { PAGES, PENDING } from "./settings/pages";
import { settingsSection, type SettingsSectionId } from "../lib/settings";
import { settingsWarm, warmSettings } from "../lib/settingsReads";
import type { Session, Workspace } from "../lib/types";
import { AboutPage } from "./settings/AboutPage";
import { BrowserSettings } from "./settings/BrowserSettings";
import { EnvironmentsPage } from "./settings/EnvironmentsPage";
import { GeneralPage } from "./settings/GeneralPage";
import { KeybindingsPage } from "./settings/KeybindingsPage";
import { ProvidersPage } from "./settings/ProvidersPage";
import { SettingsPage, Toasts } from "./settings/ui";
import { UsagePage } from "./settings/UsagePage";
import { NotificationSettings } from "./NotificationSettings";
import { IntegrationsPage } from "./settings/integrations/IntegrationsPage";
import type { OpenSignIn } from "./settings/integrations/project";

type Props = {
  section: SettingsSectionId;
  workspaces: Workspace[];
  onOpenTerminal: (envId: string, input?: string) => Promise<void>;
  onOpenSignIn: OpenSignIn;
  /** On Connectors: the session whose status line led here, for what its project has. */
  session?: Session;
};

/**
 * One page per section. Keybindings, About, General, Usage and
 * Environments are the redesigned pages; the rest are the components that work
 * against the real daemon and host, in the same frame (settings/pages.ts lists
 * any section still pending).
 */
export function SettingsView({ section, workspaces, onOpenTerminal, onOpenSignIn, session }: Props) {
  // A page that is still pending has no nav entry; a stale request for it lands on General.
  const shown = PENDING.includes(section) ? settingsSection("general").id : section;
  // The first open waits for the pages' reads, so the first page paints whole, its switches already set.
  const [warm, setWarm] = useState(settingsWarm);
  useEffect(() => {
    if (!warm) void warmSettings().then(() => setWarm(true));
  }, [warm]);
  return (
    <div className="relative h-full">
      {warm && <Page key={shown} section={shown} workspaces={workspaces} onOpenTerminal={onOpenTerminal} onOpenSignIn={onOpenSignIn} {...(session && { session })} />}
      <Toasts />
    </div>
  );
}

function Page({ section, workspaces, onOpenTerminal, onOpenSignIn, session }: Props) {
  switch (section) {
    case "keybindings":
      return <KeybindingsPage />;
    case "general":
      return <GeneralPage />;
    case "notifications":
      return (
        <Framed section={section}>
          <NotificationSettings />
        </Framed>
      );
    case "browser":
      return (
        <Framed section={section}>
          <BrowserSettings />
        </Framed>
      );
    case "environments":
      return <EnvironmentsPage workspaces={workspaces} onOpenTerminal={onOpenTerminal} />;
    case "providers":
      return <ProvidersPage onOpenTerminal={onOpenTerminal} />;
    case "about":
      return <AboutPage />;
    case "usage":
      return <UsagePage />;
    case "connectors":
      return <IntegrationsPage workspaces={workspaces} {...(session && { session })} onOpenSignIn={onOpenSignIn} />;
  }
}

/** A section's components in the redesigned page frame. */
function Framed({ section, children }: { section: SettingsSectionId; children: ReactNode }) {
  return (
    <SettingsPage title={PAGES[section].label}>
      <div className="flex flex-col gap-8">{children}</div>
    </SettingsPage>
  );
}
