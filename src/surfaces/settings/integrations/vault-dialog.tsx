// Where the sign-ins are kept: the machines, which one is the vault, and
// moving it. Choosing another machine says first what it costs: who can read
// the sign-ins there, and what stops working when this Mac is off.
import { LaptopIcon, LockIcon, ServerIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../../chrome/kit";
import { LOCAL } from "../../../lib/client/route";
import { RowAction } from "./bits";
import { Dialog, DialogFooter, DialogGroup, DialogHeader, DialogRow } from "./dialog";
import { plural, ui } from "./lib";
import { reload } from "./store";
import { machineName, moveVault, refreshVault, useVault, type Machine } from "./vault";

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
  const status = machine.status;
  if (machine.envId === vaultEnv) {
    const leasing = status?.machines.length ?? 0;
    return [`Keeps ${plural(status?.grants ?? 0, "sign-in")}`, leasing > 0 ? `${plural(leasing, "machine")} lease from it` : null]
      .filter(Boolean)
      .join(" · ");
  }
  if (!status) return "Can’t be reached";
  if (status.holds) return status.grants > 0 ? `Keeps ${plural(status.grants, "sign-in")} of its own` : "Not joined yet";
  return status.online ? `Leases from ${status.vaultName ?? "the vault"}` : `Can’t reach ${status.vaultName ?? "the vault"}`;
}

/** What making `to` the vault costs, said before it happens. */
function costOf(to: Machine, from: Machine | undefined): string[] {
  const lines =
    to.envId === LOCAL
      ? [
          "Sign-ins move to this Mac’s keychain.",
          "Your other machines lease from it over Tailscale, so their connectors work only while this Mac is on and awake.",
        ]
      : [
          `Sign-ins move to ${to.name}, sealed so only it can open them. There they’re kept in a file that its user and root can read.`,
          "Connectors keep working with this Mac off.",
        ];
  if (from && !from.online)
    lines.push(`${from.name} is offline, so its sign-ins can’t move: ${to.name} starts empty, and every account asks you to sign in again.`);
  return lines;
}

export function VaultDialog() {
  const v = useVault();
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void refreshVault(), []);
  const vault = v.machines.find((m) => m.envId === v.vaultEnv);
  const target = v.machines.find((m) => m.envId === picked);
  const move = async () => {
    if (!target) return;
    setError(null);
    try {
      await moveVault(target.envId, () => void reload());
      setPicked(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  if (target) {
    const title = `Keep sign-ins on ${target.name}?`;
    return (
      <Dialog label={title}>
        <DialogHeader mark={<Glyph envId={target.envId} />} title={title} subtitle={`Now on ${vault?.name ?? machineName(v.vaultEnv)}`} />
        <div className="flex flex-col gap-2 px-5 pb-4 text-[13px] text-pretty text-text-muted">
          {costOf(target, vault).map((line) => (
            <p key={line}>{line}</p>
          ))}
          {(error ?? v.error) && <p className="text-danger">{error ?? v.error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={!!v.busy} onClick={() => setPicked(null)}>
            Back
          </Button>
          <Button variant="primary" loading={!!v.busy} onClick={() => void move()}>
            Move sign-ins
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }
  return (
    <Dialog label="Where sign-ins are kept">
      <DialogHeader
        mark={
          <span className="grid size-10 place-items-center rounded-[26%] bg-card">
            <LockIcon className="size-5 text-icon" />
          </span>
        }
        title="Where sign-ins are kept"
        subtitle="One machine keeps them; the others lease a token from it for each call."
        wrap
      />
      <DialogGroup>
        {v.machines.map((m) => (
          <DialogRow
            key={m.envId}
            icon={<Glyph envId={m.envId} />}
            title={m.envId === LOCAL ? "This Mac" : m.name}
            subtitle={standing(m, v.vaultEnv)}
          >
            {m.envId === v.vaultEnv ? (
              <span className="shrink-0 text-[12.5px] font-medium text-text-muted">Vault</span>
            ) : (
              m.online && !v.busy && (m.envId === LOCAL || m.address) && <RowAction label="Keep here" onClick={() => setPicked(m.envId)} />
            )}
          </DialogRow>
        ))}
      </DialogGroup>
      <DialogFooter>
        <Button variant="primary" onClick={ui.close}>
          Done
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
