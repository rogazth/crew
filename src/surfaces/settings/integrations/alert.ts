// Whether the Connectors page needs the person, for the dot on the rail's icon.
import { useSyncExternalStore } from "react";
import { serversNeedYou, subscribeServers } from "./providers";
import { accountsNeedYou, getState, subscribeConnectors } from "./store";

const subscribeAll = (listener: () => void) => {
  const off = [subscribeConnectors(listener), subscribeServers(listener)];
  return () => off.forEach((stop) => stop());
};

/** An account signed out or refused, or a CLI's server waiting on a sign-in: the rail's icon wears a dot. */
export function useConnectorsAlert(): boolean {
  return useSyncExternalStore(subscribeAll, () => accountsNeedYou(getState()) || serversNeedYou());
}
