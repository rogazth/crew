// Whether Settings › Connectors needs the person, for the dot on the rail's gear and on Connectors in Settings.
import { useSyncExternalStore } from "react";
import { serversNeedYou, subscribeServers } from "./providers";
import { accountsNeedYou, getState, subscribeConnectors } from "./store";

const subscribeAll = (listener: () => void) => {
  const off = [subscribeConnectors(listener), subscribeServers(listener)];
  return () => off.forEach((stop) => stop());
};

/** An account signed out or refused, or a CLI's server waiting on a sign-in: the gear and Connectors wear a dot. */
export function useConnectorsAlert(): boolean {
  return useSyncExternalStore(subscribeAll, () => accountsNeedYou(getState()) || serversNeedYou());
}
