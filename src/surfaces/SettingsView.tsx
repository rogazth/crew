import type { ReactNode } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import { PAGES, PENDING } from "./settings/pages";
import { settingsSection, type SettingsSectionId } from "../lib/settings";
import type { Workspace } from "../lib/types";
import { AboutPage } from "./settings/AboutPage";
import { AppearancePage } from "./settings/AppearancePage";
import { BrowserSettings } from "./settings/BrowserSettings";
import { CommandLineSettings } from "./settings/CommandLineSettings";
import { EnvironmentsPage } from "./settings/EnvironmentsPage";
import { InstalledProviders } from "./settings/InstalledProviders";
import { KeybindingsPage } from "./settings/KeybindingsPage";
import { SettingsPage, Toasts } from "./settings/ui";
import { NotificationSettings } from "./NotificationSettings";
import { SessionSettings } from "./SessionSettings";
import { TerminalSettings } from "./TerminalSettings";

type Props = {
  section: SettingsSectionId;
  workspaces: Workspace[];
  onConfirm: (confirm: Confirm) => void;
  onOpenTerminal: (envId: string) => Promise<void>;
};

/**
 * One page per section. Appearance and Keybindings are the redesigned pages;
 * the rest are the components that work against the real daemon and host, in
 * the same frame, until streams S2–S5 of docs/plans/2026-10-19-design-system-finish.md
 * give Usage, Providers, Environments and General their redesigned,
 * real pages (see settings/pages.ts for the ones still pending).
 */
export function SettingsView({ section, workspaces, onConfirm, onOpenTerminal }: Props) {
  // A page that is still pending has no nav entry; a stale request for it lands on General.
  const shown = PENDING.includes(section) ? settingsSection("general").id : section;
  return (
    <>
      <Page key={shown} section={shown} workspaces={workspaces} onConfirm={onConfirm} onOpenTerminal={onOpenTerminal} />
      <Toasts />
    </>
  );
}

function Page({ section, workspaces, onConfirm, onOpenTerminal }: Props) {
  switch (section) {
    case "appearance":
      return <AppearancePage />;
    case "keybindings":
      return <KeybindingsPage />;
    case "general":
      return (
        <Framed section={section}>
          <SessionSettings onConfirm={onConfirm} />
          <CommandLineSettings />
        </Framed>
      );
    case "notifications":
      return (
        <Framed section={section}>
          <NotificationSettings />
        </Framed>
      );
    case "terminal":
      return (
        <Framed section={section}>
          <TerminalSettings />
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
      return (
        <Framed section={section}>
          <InstalledProviders />
        </Framed>
      );
    case "about":
      return <AboutPage />;
    case "usage":
      return null;
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
