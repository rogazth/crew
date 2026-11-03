// One account on a connector's page: its name (editable), how many workspaces
// it's for (when there are several), where it stands only when something's
// off (a dot and a word), its one fix on the row, and the rest (its
// workspaces, rename, remove) behind ⋯.
import { useState } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import type { MenuAction } from "../../../lib/menu";
import { AccountName, Dot, RowAction, RowMenu } from "./bits";
import { ACCOUNT_PROBLEM, ACCOUNT_TONE, ui, workspacesLine } from "./lib";
import { listJoin } from "./servers";
import { actions, cancelFlow, flowLine, siblingsOf, signingIn, useIntegrations, waitsInBrowser, type Account } from "./store";

export function AccountRow({ account }: { account: Account }) {
  const s = useIntegrations();
  const [rename, setRename] = useState(0);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const flow = signingIn(s, account.id);
  const busy = !!flow;
  const tone = ACCOUNT_TONE[account.state];
  // A grant that ran out, or one short of scope, signs in again; a server that couldn't be reached is tried again.
  const fix =
    account.state === "expired" || account.state === "needs-scope" || account.state === "pending"
      ? { label: "Sign in", run: () => void actions.reconnect(account.id) }
      : account.state === "failed"
        ? { label: "Try now", run: () => void actions.refresh(account.id) }
        : null;
  const problem = account.state === "failed" ? (account.error ?? ACCOUNT_PROBLEM.failed) : ACCOUNT_PROBLEM[account.state];
  // A Google account other apps share stays signed in for them, which removing it says.
  const siblings = siblingsOf(s, account);
  // Named after who signed in, the account doesn't say it twice.
  const line = busy
    ? flowLine(flow)
    : [problem, account.identity === account.label ? null : account.identity, problem || s.workspaces.length < 2 ? null : workspacesLine(account, s.workspaces)]
        .filter(Boolean)
        .join(" · ");
  const remove = () =>
    setConfirm({
      title: `Remove ${account.label}?`,
      description: siblings.length > 0 ? `${listJoin(siblings)} ${siblings.length === 1 ? "stays" : "stay"} connected.` : "Signs out this account.",
      action: "Remove",
      onConfirm: () => actions.removeAccount(account.id),
    });
  const menu: Omit<MenuAction, "hotkey">[] = [
    ...(s.workspaces.length > 1 ? [{ id: "workspaces", label: "Workspaces", icon: "settings" as const }] : []),
    { id: "rename", label: "Rename", icon: "edit" },
    { id: "remove", label: "Remove", icon: "delete", danger: true },
  ];
  const pick = (id: string) => {
    if (id === "workspaces") ui.open({ kind: "account-workspaces", accountId: account.id });
    else if (id === "rename") setRename((n) => n + 1);
    else remove();
  };
  return (
    <div className={`flex items-center gap-3 ${line ? "h-14" : "h-12"}`}>
      <div className="flex min-w-0 flex-1 flex-col">
        <AccountName account={account} edit={rename} />
        {line && (
          <span className={`flex min-w-0 items-center gap-1.5 text-[12px] text-text-muted`} title={account.error ?? undefined}>
            {!busy && tone !== "success" && <Dot tone={tone} />}
            <span className={`truncate ${busy ? "crew-shimmer" : ""}`}>{line}</span>
          </span>
        )}
      </div>
      {fix && !busy && <RowAction label={fix.label} onClick={fix.run} />}
      {flow && waitsInBrowser(flow) && <RowAction label="Cancel" onClick={() => cancelFlow(flow.id)} />}
      <RowMenu label={`More for ${account.label}`} actions={menu} onPick={pick} />
      <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
