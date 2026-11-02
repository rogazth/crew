import { XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Confirm } from "../chrome/ConfirmDialog";
import { IconButton, PageHeadingContext, Tooltip, type PageHeading } from "../chrome/kit";
import { TOGGLE_RESERVE } from "../lib/chrome";
import { commandKeys } from "../lib/commands";
import type { RoutineDraft } from "../lib/routines";
import { settingsSection, type SettingsSectionId } from "../lib/settings";
import type { Session, Workspace } from "../lib/types";
import { RoutinesView } from "./RoutinesView";
import { IntegrationsPage } from "./settings/integrations/IntegrationsPage";
import { useIntegrationsTrail } from "./settings/integrations/lib";
import { SettingsView } from "./SettingsView";

/** A page covers the workspace instead of living in a tab. */
export type Page =
  | { kind: "workspace" }
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "routines"; draft: RoutineDraft | null }
  | { kind: "integrations" };

type Props = {
  page: Page;
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  sessions: Session[];
  onConfirm: (confirm: Confirm) => void;
  onOpenTerminal: (envId: string, input?: string) => Promise<void>;
  /** The sidebar is closed: the strip leaves room for its toggle, as the tabs do. */
  inset: boolean;
  onClose: () => void;
};

/**
 * Everything that is not the workspace itself. Kept out of `App` so adding a
 * page is a branch here rather than another fork in the shell.
 */
export function Pages({
  page,
  workspaces,
  activeWorkspace,
  sessions,
  onConfirm,
  onOpenTerminal,
  inset,
  onClose,
}: Props) {
  const bots = sessions.filter((session) => session.kind === "bot");
  const integrations = useIntegrationsTrail();
  const [heading, setHeading] = useState<PageHeading | null>(null);
  // The page is a sheet laid over the chrome, like the workspace under the tabs,
  // and its strip stands where the tabs were, so the sheet does not jump.
  const sheet = (children: ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageStrip trail={page.kind === "integrations" ? integrations : trail(page)} heading={heading} inset={inset} onClose={onClose} />
      <div data-sheet="page" className="min-h-0 flex-1">
        <PageHeadingContext.Provider value={setHeading}>{children}</PageHeadingContext.Provider>
      </div>
    </div>
  );
  if (page.kind === "settings") {
    return sheet(
      <SettingsView
        section={page.section}
        workspaces={workspaces}
        onOpenTerminal={onOpenTerminal}
      />,
    );
  }
  if (page.kind === "routines" && activeWorkspace) {
    return sheet(
      <RoutinesView
        // A draft arriving from the bot drawer has to reopen the editor even
        // when the page is already up.
        key={page.draft?.key ?? "routines"}
        draft={page.draft}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspace.id}
        bots={bots}
        onConfirm={onConfirm}
      />,
    );
  }
  if (page.kind === "integrations")
    return sheet(<IntegrationsPage workspaces={workspaces} />);
  return null;
}

/**
 * Where the page is. Settings swaps the sidebar for its sections, so the strip
 * says whose they are and which is on screen; Routines and Integrations already
 * head the sheet with their own name, so the strip leaves it out.
 */
/** A step in the strip: its name, and where a click on it goes, if anywhere. */
export type Crumb = string | { label: string; onClick: () => void };

function trail(page: Page): Crumb[] {
  return page.kind === "settings" ? ["Settings", settingsSection(page.section).label] : [];
}

/**
 * The tabs' place while a page covers them: a drag strip that says where you are, and the way back.
 * A page with no trail heads itself, so once its title scrolls away the strip fades it in instead.
 */
function PageStrip({
  trail,
  heading,
  inset,
  onClose,
}: {
  trail: Crumb[];
  heading: PageHeading | null;
  inset: boolean;
  onClose: () => void;
}) {
  return (
    <div data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-1 bg-sidebar pr-2">
      {inset ? <div className={`shrink-0 ${TOGGLE_RESERVE}`} /> : <div className="w-3 shrink-0" />}
      {trail.length === 0 && heading && (
        <span
          aria-hidden={!heading.hidden}
          className={`min-w-0 truncate font-medium text-text transition-[opacity,translate] duration-150 ease-out motion-reduce:transition-none ${
            heading.hidden ? "translate-y-px opacity-100" : "pointer-events-none translate-y-1 opacity-0"
          }`}
        >
          {heading.title}
        </span>
      )}
      <nav aria-label="Breadcrumb" className="flex min-w-0 translate-y-px items-center gap-1.5 text-icon">
        {trail.map((part, index) => {
          const label = typeof part === "string" ? part : part.label;
          return (
            <span key={label} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && <span aria-hidden>›</span>}
              {typeof part === "string" ? (
                <span className={`truncate ${index === trail.length - 1 ? "font-medium text-text" : ""}`}>{label}</span>
              ) : (
                <button type="button" data-tauri-drag-region="false" onClick={part.onClick} className="truncate rounded outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50">
                  {label}
                </button>
              )}
            </span>
          );
        })}
      </nav>
      <div className="flex-1" />
      <Tooltip
        content={<span className="flex items-center gap-2">Close<span className="tracking-wide opacity-60">{commandKeys("close")}</span></span>}
        side="bottom"
        render={<IconButton icon={XIcon} label="Close" data-tauri-drag-region="false" className="size-7" onClick={onClose} />}
      />
    </div>
  );
}

