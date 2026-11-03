// Where the sign-ins are kept: one machine, picked from the others. Change stays
// off until another is picked, and asks first: no sign-in leaves its machine, so
// every account signs in again on the new one.
import { Select as BaseSelect } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon, LaptopIcon, LockIcon, ServerIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import { Button, PANEL, ROW } from "../../../chrome/kit";
import { LOCAL } from "../../../lib/client/route";
import { Dialog, DialogFooter, DialogHeader } from "./dialog";
import { plural, ui } from "./lib";
import { reload } from "./store";
import { changeVault, needsTailscale, refreshVault, useVault, type Machine } from "./vault";

/** One line on where a machine stands with the vault. */
function standing(machine: Machine, vaultEnv: string): string {
  if (!machine.online) return "Offline";
  const status = machine.status;
  if (machine.envId === vaultEnv) {
    const using = status?.machines.length ?? 0;
    const grants = status?.grants ?? 0;
    return [grants > 0 ? plural(grants, "account") : "No accounts", using > 0 ? `${plural(using, "machine")} connected` : null].filter(Boolean).join(" · ");
  }
  if (!status) return "Can’t be reached";
  if (status.holds) return status.grants > 0 ? `Has ${plural(status.grants, "other account")}` : "Not connected";
  return status.online ? `Connected to ${status.vaultName ?? "the vault"}` : `Can’t reach ${status.vaultName ?? "the vault"}`;
}

/** The confirmation's one line: what changing the vault to `to` signs out. */
function costOf(to: Machine, from: Machine | undefined): string {
  const own = to.status?.holds && to.status.grants > 0 ? ` Accounts already on ${to.name} will be removed.` : "";
  if (!from) return `You’ll need to sign in to all accounts again.${own}`;
  if (!from.online) return `You’ll need to sign in to all accounts again. ${from.name} removes its accounts when it’s back online.${own}`;
  return `All accounts will be signed out. You’ll need to sign in to them again.${own}`;
}


/** A machine as the box and its list show it: its mark, its name, where it stands. */
function MachineLine({ machine, vaultEnv }: { machine: Machine; vaultEnv: string }) {
  const Icon = machine.envId === LOCAL ? LaptopIcon : ServerIcon;
  return (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface shadow-[0_0_0_1px_var(--color-hairline)]">
        <Icon className="size-4 text-icon" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{machine.envId === LOCAL ? "This Mac" : machine.name}</span>
        <span className="truncate text-[12px] text-text-muted">{needsTailscale(machine.envId) ? "Needs Tailscale" : standing(machine, vaultEnv)}</span>
      </span>
    </>
  );
}

/** The dialog's box, the picked machine in it: a click drops the others below it. */
function MachinePicker({ machines, vaultEnv, value, onChange }: { machines: Machine[]; vaultEnv: string; value: string; onChange: (envId: string) => void }) {
  const current = machines.find((m) => m.envId === value);
  return (
    <BaseSelect.Root value={value} onValueChange={(next) => next !== null && onChange(next)}>
      <BaseSelect.Trigger
        aria-label="Vault"
        className="flex min-h-14 w-full items-center gap-3 rounded-xl bg-card px-3 py-2 text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50 data-popup-open:bg-hover"
      >
        {current && <MachineLine machine={current} vaultEnv={vaultEnv} />}
        <ChevronDownIcon className="size-4 shrink-0 text-icon" />
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50">
          <BaseSelect.Popup className={`${PANEL} w-(--anchor-width) max-w-none!`}>
            {machines.map((m) => (
              <BaseSelect.Item
                key={m.envId}
                value={m.envId}
                disabled={!(m.envId === vaultEnv || (m.online && !needsTailscale(m.envId) && (m.envId === LOCAL || !!m.address)))}
                className={`${ROW} h-auto! gap-3! py-1.5 data-disabled:opacity-50`}
              >
                <MachineLine machine={m} vaultEnv={vaultEnv} />
                <BaseSelect.ItemIndicator>
                  <CheckIcon className="size-4 shrink-0" />
                </BaseSelect.ItemIndicator>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

export function VaultDialog() {
  const v = useVault();
  const [picked, setPicked] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  useEffect(() => void refreshVault(), []);
  const vault = v.machines.find((m) => m.envId === v.vaultEnv);
  const selected = picked ?? v.vaultEnv;
  const target = selected === v.vaultEnv ? undefined : v.machines.find((m) => m.envId === selected);
  const change = () => {
    if (!target) return;
    const name = target.envId === LOCAL ? "this Mac" : target.name;
    setConfirm({
      title: `Use ${name} as your vault?`,
      description: costOf(target, vault),
      action: `Use ${name}`,
      onConfirm: async () => {
        await changeVault(target.envId, () => void reload());
        ui.close();
      },
    });
  };
  return (
    <Dialog label="Vault">
      <DialogHeader
        mark={
          <span className="grid size-10 place-items-center rounded-[26%] bg-card">
            <LockIcon className="size-5 text-icon" />
          </span>
        }
        title="Vault"
        subtitle="Stores your accounts. Your other machines use it."
      />
      <div className="px-4 pb-5">
        <MachinePicker machines={v.machines} vaultEnv={v.vaultEnv} value={selected} onChange={setPicked} />
      </div>
      <DialogFooter start={target?.envId === LOCAL && <span className="min-w-0 truncate text-[12px] text-text-muted">Other machines need this Mac awake</span>}>
        <Button variant="ghost" onClick={ui.close}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!target || !!v.busy} onClick={change}>
          Change
        </Button>
      </DialogFooter>
      <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
    </Dialog>
  );
}
