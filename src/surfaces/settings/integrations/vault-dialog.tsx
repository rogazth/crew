// Where the sign-ins are kept: one machine, picked from the others. Change stays
// off until another is picked, and asks first: no sign-in leaves its machine, so
// every account signs in again on the new one.
import { LaptopIcon, LockIcon, ServerIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import { Button } from "../../../chrome/kit";
import { LOCAL } from "../../../lib/client/route";
import { Dialog, DialogFooter, DialogGroup, DialogHeader } from "./dialog";
import { plural, ui } from "./lib";
import { reload } from "./store";
import { changeVault, needsTailscale, refreshVault, useVault, type Machine } from "./vault";

function Glyph({ envId }: { envId: string }) {
  const Icon = envId === LOCAL ? LaptopIcon : ServerIcon;
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface shadow-[0_0_0_1px_var(--color-hairline)]">
      <Icon className="size-4 text-icon" />
    </span>
  );
}

/** One line on where a machine stands with the vault. */
function standing(machine: Machine, vaultEnv: string): string {
  if (!machine.online) return "Offline";
  if (needsTailscale(machine.envId)) return "Reached over SSH";
  const status = machine.status;
  if (machine.envId === vaultEnv) {
    const using = status?.machines.length ?? 0;
    return [`Keeps ${plural(status?.grants ?? 0, "sign-in")}`, using > 0 ? `${plural(using, "machine")} ${using === 1 ? "uses" : "use"} it` : null]
      .filter(Boolean)
      .join(" · ");
  }
  if (!status) return "Can’t be reached";
  if (status.holds) return status.grants > 0 ? `Keeps ${plural(status.grants, "sign-in")} of its own` : "Not joined yet";
  return status.online ? `Uses ${status.vaultName ?? "the vault"}` : `Can’t reach ${status.vaultName ?? "the vault"}`;
}

const capitalized = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** The confirmation's one line: what changing the vault to `to` signs out. */
function costOf(to: Machine, from: Machine | undefined): string {
  const own = to.status?.holds && to.status.grants > 0 ? ` ${capitalized(to.name)}’s own sign-ins are removed.` : "";
  if (!from) return `Every account signs in again on ${to.name}.${own}`;
  if (!from.online) return `Every account signs in again on ${to.name}. ${capitalized(from.name)} deletes its sign-ins when it’s back.${own}`;
  return `Signs out every account on ${from.name}. Each signs in again on ${to.name}.${own}`;
}

/** Who else this choice reaches, under the choice. */
function noteOf(machine: Machine): string {
  return machine.envId === LOCAL ? "Other machines need this Mac awake" : "Readable by its user and root";
}

function MachineOption({ machine, checked, enabled, subtitle, onPick }: { machine: Machine; checked: boolean; enabled: boolean; subtitle: string; onPick: () => void }) {
  return (
    <label
      className={`flex min-h-14 items-center gap-3 border-t border-hairline py-2 first:border-t-0 has-[:focus-visible]:bg-hover ${enabled ? "cursor-pointer" : "opacity-50"}`}
    >
      <Glyph envId={machine.envId} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{machine.envId === LOCAL ? "This Mac" : machine.name}</span>
        <span className="truncate text-[12px] text-text-muted">{subtitle}</span>
      </span>
      <input type="radio" name="vault-machine" className="sr-only" checked={checked} disabled={!enabled} onChange={onPick} />
      <span aria-hidden className={`grid size-[18px] shrink-0 place-items-center rounded-full transition-colors ${checked ? "bg-accent" : "ring-1 ring-border ring-inset"}`}>
        {checked && <span className="size-1.5 rounded-full bg-inverse" />}
      </span>
    </label>
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
    setConfirm({
      title: `Make ${target.envId === LOCAL ? "this Mac" : target.name} the vault?`,
      description: costOf(target, vault),
      action: "Change",
      onConfirm: async () => {
        await changeVault(target.envId, () => void reload());
        ui.close();
      },
    });
  };
  return (
    <Dialog label="Where sign-ins are kept">
      <DialogHeader
        mark={
          <span className="grid size-10 place-items-center rounded-[26%] bg-card">
            <LockIcon className="size-5 text-icon" />
          </span>
        }
        title="Where sign-ins are kept"
        subtitle="One machine keeps them for the others."
      />
      <div role="radiogroup" aria-label="Where sign-ins are kept">
        <DialogGroup>
          {v.machines.map((m) => (
            <MachineOption
              key={m.envId}
              machine={m}
              checked={m.envId === selected}
              enabled={m.envId === v.vaultEnv || (m.online && !needsTailscale(m.envId) && (m.envId === LOCAL || !!m.address))}
              subtitle={needsTailscale(m.envId) ? "Needs Tailscale" : standing(m, v.vaultEnv)}
              onPick={() => setPicked(m.envId)}
            />
          ))}
        </DialogGroup>
      </div>
      <DialogFooter start={target && <span className="min-w-0 truncate text-[12px] text-text-muted">{noteOf(target)}</span>}>
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
