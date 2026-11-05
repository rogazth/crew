import { useEffect } from "react";
import { envOfSession } from "../../lib/client/registry";
import { sessionServers, useMcp } from "../../lib/mcp";
import { reloadMachine, useAllMachines } from "../settings/integrations/providers";

/** The machines this window has asked for their lists: their events keep them current after that. */
const asked = new Set<string>();

/**
 * The servers a session's status line shows: what its CLI says once it runs,
 * and until then what that CLI has on the session's machine. A daemon that
 * restarted knows nothing of a session's servers before its next turn.
 */
export function useSessionServers(sessionId: string, provider: string) {
  const envId = envOfSession(sessionId);
  const status = useMcp(sessionId);
  const { machines } = useAllMachines();
  useEffect(() => {
    if (asked.has(envId)) return;
    asked.add(envId);
    void reloadMachine(envId);
  }, [envId]);
  const inventory = machines[envId]?.inventory.find((one) => one.provider === provider)?.servers ?? [];
  return sessionServers(status, inventory);
}
