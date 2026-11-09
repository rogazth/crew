// A workspace's connectors: the app's accounts (Settings › Connectors), each switched on or off for this workspace
// alone. An account is for every workspace (`null`, those added later too) or for a list; switching it off here
// turns "every one" into every one but this. Signing in, adding and removing stay on the app's page.
import { useEffect } from "react";
import { Button, Switch } from "../../../chrome/kit";
import type { Workspace } from "../../../lib/types";
import { brandOf } from "./brand";
import { ACCOUNT_PROBLEM } from "./lib";
import { ServiceMark } from "./mark";
import { actions, setWorkspaces, useIntegrations, type Account } from "./store";

const onHere = (account: Account, id: string) => account.workspaces === null || account.workspaces.includes(id);

export function WorkspaceConnectors({
  workspace,
  workspaces,
  onManage,
}: {
  workspace: Workspace;
  /** Every workspace: what "every one but this" lists. */
  workspaces: Workspace[];
  /** Opens Settings › Connectors. */
  onManage: () => void;
}) {
  const s = useIntegrations();
  // The store names the workspaces an account is for; the app's page sets them too.
  useEffect(() => setWorkspaces(workspaces.map((w) => ({ id: w.id, name: w.name }))), [workspaces]);
  const rows = s.connectors.flatMap((connector) => connector.accounts.map((account) => ({ connector, account })));

  const toggle = (account: Account, on: boolean) => {
    const now = account.workspaces ?? workspaces.map((w) => w.id);
    actions.setWorkspaces(account.id, on ? [...new Set([...now, workspace.id])] : now.filter((id) => id !== workspace.id));
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium">Accounts</h3>
        {rows.length > 0 && (
          <button type="button" onClick={onManage} className="text-[12px] text-text-muted outline-none hover:text-text focus-visible:text-text">
            Manage
          </button>
        )}
      </div>
      {!s.loaded ? null : s.error ? (
        <p className="px-1 text-[12.5px] text-danger">Couldn’t read the connectors: {s.error}</p>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl bg-card px-4 py-3.5">
          <p className="min-w-0 flex-1 text-[12.5px] text-text-muted">No connectors yet. Add them once in Settings, then choose where each one is on.</p>
          <Button size="sm" onClick={onManage}>
            Add connectors
          </Button>
        </div>
      ) : (
        <div className="rounded-xl bg-card px-4 [&>*+*]:border-t [&>*+*]:border-hairline">
          {rows.map(({ connector, account }) => {
            const problem = ACCOUNT_PROBLEM[account.state];
            return (
              <label key={account.id} className="flex min-h-12 cursor-pointer items-center gap-3 py-2.5 select-none">
                <ServiceMark brand={brandOf(connector)} size={28} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] leading-[18px] font-medium">{connector.name}</span>
                  <span className={`truncate text-[12px] leading-4 ${problem ? "text-warning" : "text-text-muted"}`}>
                    {problem ? `${account.identity ?? account.label} · ${problem}` : (account.identity ?? account.label)}
                  </span>
                </span>
                <Switch label={`${connector.name}, ${account.label}`} checked={onHere(account, workspace.id)} onChange={(on) => toggle(account, on)} />
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}
