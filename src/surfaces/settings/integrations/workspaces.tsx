// Which workspaces an account is for, the one say Crew has on where a
// connector reaches: a workspace no account of it is for doesn't get it.
// Installing a connector and adding an account ask first, all picked; an
// account's ⋯ changes it later. With one workspace nothing asks. All of them
// is every workspace, the ones added later too. A workspace on a machine
// reached over ssh gets no connectors (vault.ts), and says so.
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../chrome/kit";
import { Dialog, DialogBody, DialogFooter, DialogGroup, DialogHeader } from "./dialog";
import { brandOf, type Brand } from "./brand";
import { ServiceMark } from "./mark";
import { envOf } from "../../../lib/client/registry";
import { startAddAccount, ui } from "./lib";
import { needsTailscale } from "./vault";
import { accountOf, actions, connectorOf, useIntegrations, type Source } from "./store";

function Check({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={`grid size-[18px] shrink-0 place-items-center rounded-[5px] transition-colors ${checked ? "bg-accent text-inverse" : "ring-1 ring-border ring-inset"}`}
    >
      {checked && <CheckIcon className="size-3" strokeWidth={3} />}
    </span>
  );
}

function CheckRow({ checked, onClick, title, subtitle }: { checked: boolean; onClick: () => void; title: string; subtitle?: string | undefined }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onClick}
      className="flex min-h-12 w-full items-center gap-3 border-t border-hairline py-2 text-left outline-none first:border-t-0 focus-visible:bg-hover"
    >
      <Check checked={checked} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{title}</span>
        {subtitle && <span className="truncate text-[12px] text-text-muted">{subtitle}</span>}
      </span>
    </button>
  );
}

/**
 * All on top, then each workspace; unpicking one out of all keeps the rest. A workspace another account of the
 * connector is already for says so: picked here too, its sessions get both.
 */
function Picker({ connectorId, accountId, value, onChange }: { connectorId: string | null; accountId: string | null; value: string[] | null; onChange: (next: string[] | null) => void }) {
  const s = useIntegrations();
  const others = (connectorOf(s, connectorId ?? undefined)?.accounts ?? []).filter((a) => a.id !== accountId && a.state !== "pending");
  const picked = value ?? s.workspaces.map((w) => w.id);
  const flip = (id: string) => onChange(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  return (
    <DialogGroup>
      <CheckRow checked={value === null} onClick={() => onChange(value === null ? [] : null)} title="All workspaces" subtitle="Including new ones" />
      {s.workspaces.map((w) => {
        const also = others.filter((a) => a.workspaces === null || a.workspaces.includes(w.id)).map((a) => a.label);
        // On a machine reached over ssh its sessions get no connectors, picked or not.
        const subtitle = needsTailscale(envOf(w.id)) ? "Needs Tailscale" : also.length ? `Also uses ${also.join(", ")}` : undefined;
        return <CheckRow key={w.id} checked={picked.includes(w.id)} onClick={() => flip(w.id)} title={w.name} subtitle={subtitle} />;
      })}
    </DialogGroup>
  );
}

/** The one sheet every flow asks in: installing, adding an account, an account's ⋯. */
function WorkspacesSheet({
  brand,
  title,
  subtitle,
  connectorId,
  accountId = null,
  initial = null,
  action,
  onDone,
}: {
  brand: Brand;
  title: string;
  subtitle: string;
  connectorId: string | null;
  accountId?: string | null;
  initial?: string[] | null;
  action: string;
  onDone: (workspaces: string[] | null) => void;
}) {
  const [value, setValue] = useState<string[] | null>(initial);
  const none = value !== null && value.length === 0;
  return (
    <Dialog label={title}>
      <DialogHeader mark={<ServiceMark brand={brand} size={40} />} title={title} subtitle={subtitle} />
      <DialogBody>
        <Picker connectorId={connectorId} accountId={accountId} value={value} onChange={setValue} />
      </DialogBody>
      <DialogFooter start={none && <span className="text-[12px] text-warning">Pick at least one workspace</span>}>
        <Button variant="ghost" onClick={ui.close}>
          Cancel
        </Button>
        <Button variant="primary" disabled={none} onClick={() => onDone(value)}>
          {action}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Installing: the workspaces first, then the connect sheet again with them, which signs in. */
export function InstallWorkspacesDialog({ source, brand }: { source: Source; brand: Brand }) {
  return (
    <WorkspacesSheet
      brand={brand}
      title={`Install ${brand.name}`}
      subtitle="Choose workspaces"
      connectorId={null}
      action="Sign in"
      onDone={(workspaces) => ui.open({ kind: "connect", source: { ...source, workspaces } })}
    />
  );
}

/** A new account: its workspaces first, then the sign-in. A built-in goes on to its own sheet, which may ask "Continue as". */
export function AddAccountDialog({ connectorId }: { connectorId: string }) {
  const s = useIntegrations();
  const connector = connectorOf(s, connectorId);
  if (!connector) return null;
  return (
    <WorkspacesSheet
      brand={brandOf(connector)}
      title={connector.accounts.length === 0 ? `Add an account to ${connector.name}` : `Add another ${connector.name} account`}
      subtitle="Choose workspaces"
      connectorId={connectorId}
      action="Sign in"
      onDone={(workspaces) => startAddAccount(s, connectorId, workspaces)}
    />
  );
}

export function AccountWorkspacesDialog({ accountId }: { accountId: string }) {
  const s = useIntegrations();
  const account = accountOf(s, accountId);
  const connector = connectorOf(s, account?.connectorId);
  if (!account || !connector) return null;
  return (
    <WorkspacesSheet
      brand={brandOf(connector)}
      title={`Workspaces for ${account.label}`}
      subtitle={account.identity ?? connector.name}
      connectorId={connector.id}
      accountId={accountId}
      initial={account.workspaces}
      action="Save"
      onDone={(workspaces) => {
        actions.setWorkspaces(accountId, workspaces);
        ui.close();
      }}
    />
  );
}
