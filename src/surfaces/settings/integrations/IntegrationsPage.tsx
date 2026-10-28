// The Connectors page: Crew's connectors (the tiles), each signed in to once
// per account through the vault on this Mac, and the servers each provider
// CLI already has on one machine (the chips, clis.tsx). A click opens a
// connector's page (detail.tsx) with its accounts, where it's on and its
// tools, or a server's, with its copy in each CLI. Browse swaps the page for
// the registry; installing signs in at once, in a sheet over it. A vault on
// another machine and duplicates come with later phases
// (docs/plans/2026-10-23-integrations.md).
import { useEffect } from "react";
import { Button } from "../../../chrome/kit";
import type { Session, Workspace } from "../../../lib/types";
import { SettingsPage } from "../ui";
import { ConnectDialog } from "./connect";
import { DetailPage } from "./detail";
import { CustomDialog, DirectoryPage, SummaryDialog } from "./directory";
import { KEYFRAMES, ui, useUi, type Sheet } from "./lib";
import { FromProviders } from "./clis";
import { Installed } from "./sections";
import { BuiltInDialog, BuiltinSummaryDialog } from "./builtin";
import { VaultDialog } from "./vault-dialog";
import { setConsumers, useIntegrations, type Consumer, type Source } from "./store";

type Props = { workspaces: Workspace[]; bots: Session[] };

export function IntegrationsPage({ workspaces, bots }: Props) {
  const { sheet, view, detail } = useUi();
  const s = useIntegrations();
  // With no connector yet, the empty state carries the one way to the registry.
  const empty = s.loaded && s.connectors.length === 0 && !s.error;
  // Who an account can be turned on for: every workspace, and its bots under it.
  useEffect(() => {
    const consumers: Consumer[] = [
      ...workspaces.map((w): Consumer => ({ kind: "workspace", id: w.id, name: w.name })),
      ...bots.map((b): Consumer => ({ kind: "bot", id: b.id, name: b.name, workspace: b.workspaceId })),
    ];
    setConsumers(consumers);
  }, [workspaces, bots]);
  // The page always opens on the connectors: closing it forgets the detail or directory it was on.
  useEffect(() => ui.reset, []);
  if (view === "directory" || (view === "detail" && detail))
    return (
      <>
        <style>{KEYFRAMES}</style>
        {view === "detail" && detail ? <DetailPage key={JSON.stringify(detail)} detail={detail} /> : <DirectoryPage />}
        {sheet && <Sheets sheet={sheet} />}
      </>
    );
  return (
    <SettingsPage
      title="Connectors"
      actions={
        !empty && (
          <Button variant="primary" onClick={() => ui.go("directory")}>
            Browse connectors
          </Button>
        )
      }
    >
      <style>{KEYFRAMES}</style>
      <Installed />
      <FromProviders />
      {sheet && <Sheets sheet={sheet} />}
    </SettingsPage>
  );
}

/** One connect sheet per source: picking an account for a built-in starts a new one. */
const sourceKey = (source: Source) =>
  source.kind === "registry"
    ? source.server.name
    : source.kind === "builtin"
      ? `${source.builtin.id}:${source.loginHint === undefined ? "?" : (source.loginHint ?? "new")}`
      : source.url;

function Sheets({ sheet }: { sheet: Sheet }) {
  switch (sheet.kind) {
    case "connect":
      return <ConnectDialog key={sourceKey(sheet.source)} source={sheet.source} />;
    case "summary":
      return <SummaryDialog key={sheet.server.name} server={sheet.server} back={sheet.back} />;
    case "custom":
      return <CustomDialog />;
    case "builtin-summary":
      return <BuiltinSummaryDialog key={sheet.builtin.id} builtin={sheet.builtin} />;
    case "built-in":
      return <BuiltInDialog />;
    case "vault":
      return <VaultDialog />;
  }
}
