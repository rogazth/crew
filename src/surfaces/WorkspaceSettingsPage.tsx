// A workspace's settings, the page its sidebar's Settings opens: its face and its name heading it (the name edited
// in place), General and Connectors under them as pill tabs. General says where it lives and removes it; Connectors
// switches the app's accounts on or off for it alone. General opens with the instructions and rules every bot and
// session here reads; an icon of its own comes from workspaceProfile.ts, the initials until the daemon keeps one.
// Home has the same page with the rail's mark, its name fixed and no way to remove it.
import { Tabs } from "@base-ui/react/tabs";
import { CopyIcon, LaptopIcon, ServerIcon } from "lucide-react";
import { useState } from "react";
import { Button, PillTabs } from "../chrome/kit";
import { CrewGlyph } from "../chrome/CrewGlyph";
import { DangerAction, Kept, Section } from "../chrome/SettingsSection";
import { WorkspaceIconEditor } from "../chrome/workspaceProfile";
import { WorkspaceProfileSections } from "../chrome/WorkspaceProfileSections";
import { WorkspaceTile } from "../chrome/WorkspaceTile";
import type { EnvLink } from "../lib/client/registry";
import type { Workspace } from "../lib/types";
import { WorkspaceConnectors } from "./settings/integrations/WorkspaceConnectors";

type Page = "general" | "connectors";

const PAGES: { key: Page; label: string }[] = [
  { key: "general", label: "General" },
  { key: "connectors", label: "Connectors" },
];

export function WorkspaceSettingsPage({
  workspace,
  workspaces,
  remote,
  onRename,
  onRemove,
  onManageConnectors,
}: {
  workspace: Workspace;
  /** Every workspace: an account switched off here stays on for the others. */
  workspaces: Workspace[];
  remote: EnvLink | null;
  onRename: (name: string) => void;
  onRemove: () => void;
  /** Opens Settings › Connectors. */
  onManageConnectors: () => void;
}) {
  const [page, setPage] = useState<Page>("general");
  return (
    <div className="h-full overflow-y-auto">
      <Tabs.Root value={page} onValueChange={(next) => setPage(next as Page)} className="mx-auto flex max-w-[720px] flex-col px-10 pt-12 pb-28">
        <header className="pb-3">
          <div className="flex items-center gap-3.5">
            {workspace.home ? (
              <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-[15px] bg-card ring-1 ring-border">
                <CrewGlyph className="size-9" />
              </span>
            ) : WorkspaceIconEditor ? (
              <WorkspaceIconEditor workspace={workspace} />
            ) : (
              <WorkspaceTile workspace={workspace} size="lg" />
            )}
            {/* Home is the window's own: its name stays, and it cannot be removed. */}
            {workspace.home ? (
              <h1 className="h-10 min-w-0 flex-1 py-1.5 text-[22px] leading-7 font-semibold tracking-[-0.02em]">Home</h1>
            ) : (
              <Kept
                single
                value={workspace.name}
                onKeep={onRename}
                className="-mx-2 h-10 min-w-0 flex-1 rounded-lg px-2 py-1.5 text-[22px] leading-7 font-semibold tracking-[-0.02em] hover:bg-hover focus:bg-hover"
              />
            )}
          </div>
          <PillTabs value={page} tabs={PAGES} className="mt-4 -ml-0.5" />
        </header>
        <div className="pt-4">
          {page === "general" ? (
            <>
              <WorkspaceProfileSections workspace={workspace} />
              <Location workspace={workspace} remote={remote} />
              {!workspace.home && <DangerAction onClick={onRemove}>Remove workspace</DangerAction>}
            </>
          ) : (
            <WorkspaceConnectors workspace={workspace} workspaces={workspaces} onManage={onManageConnectors} />
          )}
        </div>
      </Tabs.Root>
    </div>
  );
}

/** Its folder, to copy, and the machine it is on. */
function Location({ workspace, remote }: { workspace: Workspace; remote: EnvLink | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <Section title="Location">
      <div className="rounded-xl bg-card px-4 [&>*+*]:border-t [&>*+*]:border-hairline">
        <div className="flex min-h-12 items-center gap-3 py-2.5">
          <span className="w-16 shrink-0 text-[12px] text-text-muted">Folder</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={workspace.path}>
            {workspace.path}
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon={CopyIcon}
            onClick={() => {
              void navigator.clipboard.writeText(workspace.path);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="flex min-h-12 items-center gap-3 py-2.5">
          <span className="w-16 shrink-0 text-[12px] text-text-muted">Machine</span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
            {remote ? <ServerIcon className="size-3.5 text-icon" /> : <LaptopIcon className="size-3.5 text-icon" />}
            {remote ? remote.name : "This Mac"}
          </span>
        </div>
      </div>
    </Section>
  );
}
