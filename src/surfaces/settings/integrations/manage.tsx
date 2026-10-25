// One account on a connector's page: its name (editable), where it stands only
// when something's off (a dot and a word), its one fix on the row, and the
// rest (rename, list the tools again, remove) behind ⋯.
import { useState } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import type { MenuAction } from "../../../lib/menu";
import { AccountName, Dot, RowAction, RowMenu } from "./bits";
import { ACCOUNT_PROBLEM, ACCOUNT_TONE } from "./lib";
import { actions, signingIn, useIntegrations, type Account } from "./store";

export function AccountRow({ account }: { account: Account }) {
  const s = useIntegrations();
  const [rename, setRename] = useState(0);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const busy = signingIn(s, account.id);
  const tone = ACCOUNT_TONE[account.state];
  // A grant that ran out, or one short of scope, signs in again; a server that couldn't be reached is tried again.
  const fix =
    account.state === "expired" || account.state === "needs-scope" || account.state === "pending"
      ? { label: "Authenticate", run: () => void actions.reconnect(account.id) }
      : account.state === "failed"
        ? { label: "Try now", run: () => void actions.refresh(account.id) }
        : null;
  const problem = account.state === "failed" ? (account.error ?? ACCOUNT_PROBLEM.failed) : ACCOUNT_PROBLEM[account.state];
  const remove = () =>
    setConfirm({
      title: `Remove ${account.label}?`,
      description: "Signs out at the service. Can’t be undone.",
      action: "Remove",
      onConfirm: () => actions.removeAccount(account.id),
    });
  const menu: Omit<MenuAction, "hotkey">[] = [
    { id: "rename", label: "Rename", icon: "edit" },
    ...(account.state === "connected" ? [{ id: "refresh", label: "Refresh tools", icon: "reopen" as const }] : []),
    { id: "remove", label: "Remove", icon: "delete", danger: true },
  ];
  const pick = (id: string) => {
    if (id === "rename") setRename((n) => n + 1);
    else if (id === "refresh") void actions.refresh(account.id);
    else remove();
  };
  return (
    <div className="flex h-14 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <AccountName account={account} edit={rename} />
        <span className={`flex min-w-0 items-center gap-1.5 text-[12px] text-text-muted`} title={account.error ?? undefined}>
          {!busy && tone !== "success" && <Dot tone={tone} />}
          <span className={`truncate ${busy ? "crew-shimmer" : ""}`}>{busy ? "Authenticating…" : [problem, account.identity].filter(Boolean).join(" · ")}</span>
        </span>
      </div>
      {fix && !busy && <RowAction label={fix.label} onClick={fix.run} />}
      <RowMenu label={`More for ${account.label}`} actions={menu} onPick={pick} />
      <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
