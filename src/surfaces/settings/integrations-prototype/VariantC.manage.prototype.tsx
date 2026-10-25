// PROTOTYPE — throwaway. One account on a connector's page: its name (editable),
// where it stands only when something's off (a dot and a word), its one fix on
// the row, and the rest (rename, remove) behind ⋯.
import { LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import { AccountName, Dot, RowAction, RowMenu } from "./VariantC.bits.prototype";
import { ACCOUNT_TONE } from "./VariantC.lib.prototype";
import { actions, useIntegrations, type Account } from "./store.prototype";

/** What's off; all well says nothing but who it is. */
const STATUS: Partial<Record<Account["state"], string>> = {
  expired: "Needs authentication",
  "needs-scope": "Missing permissions",
  "lease-ending": "Stops soon",
  "vault-offline": "Paused",
};

export function AccountRow({ account }: { account: Account }) {
  const s = useIntegrations();
  const [rename, setRename] = useState(0);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const busy = s.flows.some((f) => f.kind === "account" && f.target === account.id && f.stage !== "done" && f.stage !== "failed");
  const needs = account.state === "expired" || account.state === "needs-scope";
  const tone = ACCOUNT_TONE[account.state];
  const remove = () =>
    setConfirm({
      title: `Remove ${account.label}?`,
      description: "This action can’t be undone.",
      action: "Remove",
      onConfirm: () => actions.disconnect(account.id),
    });
  return (
    <div className="flex h-14 items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <AccountName account={account} edit={rename} />
        <span className={`flex min-w-0 items-center gap-1.5 text-[12px] ${busy ? "text-info" : "text-text-muted"}`}>
          {busy ? <LoaderCircleIcon className="size-3 shrink-0 animate-spin" /> : tone !== "success" && <Dot tone={tone} />}
          <span className="truncate">{busy ? "Authenticating…" : [STATUS[account.state], account.identity].filter(Boolean).join(" · ")}</span>
        </span>
      </div>
      {needs && !busy && <RowAction label="Authenticate" onClick={() => actions.reconnect(account.id)} />}
      <RowMenu
        label={`More for ${account.label}`}
        actions={[
          { id: "rename", label: "Rename", icon: "edit" },
          { id: "remove", label: "Remove", icon: "delete", danger: true },
        ]}
        onPick={(id) => (id === "rename" ? setRename((n) => n + 1) : remove())}
      />
      <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
