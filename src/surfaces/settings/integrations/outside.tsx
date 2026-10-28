// A connector's duplicates in the CLIs' own configs, on its page under
// "Duplicates in your providers": a CLI's server with the connector's URL,
// added in a terminal or by the CLI, that Crew's sessions still load beside
// the connector, so its tools show up twice. One off in Crew, or off in its
// CLI, isn't listed. Crew doesn't add them; it shows them so they can be
// turned off in Crew or removed.
import { useState } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import { ProviderIcon } from "../../../chrome/ProviderIcon";
import { useEnvLinks } from "../../../hooks/useEnvLinks";
import { LOCAL } from "../../../lib/client/registry";
import type { Connector } from "../../../lib/protocol";
import { Group } from "../ui";
import { RowAction, RowMenu } from "./bits";
import { PROVIDER_ORDER, providerName } from "./servers";
import { CONFIG, canTurnOffInCrew, conflictsOf, removeCopy, signInCopy, turnOffInCrew, useCopies, useWatchMachines, type Copy, type CopyState } from "./copies";

const STATE_LINE: Record<CopyState, string> = {
  adding: "Starting…",
  "needs-auth": "Needs sign-in",
  "signing-in": "Waiting for the browser…",
  connected: "Signed in",
  failed: "Didn’t start last time",
  off: "Off in Crew",
  added: "In its config",
  removing: "Removing…",
};

const WORKING: CopyState[] = ["adding", "signing-in", "removing"];

/* ── The page's group ───────────────────────────────────────────────── */

/** Below the tools: the connector's copies in the providers' own configs, by machine, and the way to add one. */
export function OutsideGroup({ connector }: { connector: Connector }) {
  useWatchMachines();
  const { copies } = useCopies();
  // Only the copies Crew's sessions still load: one off in Crew, or off in its CLI, duplicates nothing.
  const clashing = conflictsOf(connector, copies);
  const links = useEnvLinks();
  const rank = (c: Copy) => PROVIDER_ORDER.indexOf(c.provider);
  const ordered = [...clashing].sort((a, b) => (a.envId === b.envId ? rank(a) - rank(b) : a.envId === LOCAL ? -1 : b.envId === LOCAL ? 1 : a.envId.localeCompare(b.envId)));
  if (ordered.length === 0) return null;
  return (
    <Group title="Duplicates in your providers">
      {ordered.map((copy) => (
        <CopyRow
          key={`${copy.envId}:${copy.provider}`}
          copy={copy}
          machine={links.find((l) => l.id === copy.envId)?.name ?? "This Mac"}
          name={connector.name}
          conflict
        />
      ))}
    </Group>
  );
}

function CopyRow({ copy, machine, name, conflict }: { copy: Copy; machine: string; name: string; conflict: boolean }) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const cli = providerName(copy.provider);
  const working = WORKING.includes(copy.state);
  const warn = conflict || copy.state === "needs-auth" || copy.state === "failed";
  const tone = warn ? "text-warning" : "text-text-muted";
  // A clash says so in place of the state: it is what the person has to act on.
  const line = conflict
    ? canTurnOffInCrew(copy)
      ? "Crew sessions load this copy too, so its tools show up twice"
      : `Crew sessions load this copy too, and ${cli} can’t skip it only in Crew`
    : STATE_LINE[copy.state];
  return (
    <div className="flex h-14 items-center gap-2.5 border-t border-hairline first:border-t-0">
      <span className="relative ml-1 flex shrink-0">
        <ProviderIcon provider={copy.provider} className="size-4" />
        {warn && <span className="absolute -right-[3px] -bottom-[3px] size-2 rounded-full bg-warning ring-2 ring-card" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">
          {cli} <span className="font-normal text-text-muted">on {machine}</span>
        </span>
        <span className={`flex min-w-0 items-center gap-1.5 text-[12px] ${tone}`}>
          <span title={line} className={`truncate ${working ? "crew-shimmer" : ""}`}>
            {line}
            {!working && !conflict && <span className="text-text-muted"> · {CONFIG[copy.provider]}</span>}
          </span>
        </span>
      </span>
      {conflict && canTurnOffInCrew(copy) ? (
        <RowAction label="Turn off in Crew" onClick={() => turnOffInCrew(copy)} />
      ) : (
        copy.state === "needs-auth" && copy.server.canSignIn && <RowAction label="Authenticate" onClick={() => signInCopy(copy)} />
      )}
      {!working && copy.server.canRemove && (
        <RowMenu
          label={`More for ${cli}`}
          actions={[{ id: "remove", label: "Remove", icon: "delete", danger: true }]}
          onPick={() =>
            setConfirm({
              title: `Remove ${name} from ${cli}?`,
              description: `This deletes it from ${cli}’s config on ${machine}. Crew’s sessions keep it.`,
              action: "Remove",
              onConfirm: () => removeCopy(copy),
            })
          }
        />
      )}
      <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
