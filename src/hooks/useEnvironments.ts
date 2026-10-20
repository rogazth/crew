import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { LOCAL, envOf, linkOf, setFocusEnv, wakeAll, type EnvLink } from "../lib/client/registry";
import type { MachineRoute } from "../lib/browser/machines";
import { browserHost, remotesHost } from "../lib/host";
import { requestAddRemote, setOpenWorkspaceOn, setSettingsOpener, WAKE_ON } from "../lib/remoteUi";
import type { SettingsSectionId } from "../lib/settings";
import type { Workspace } from "../lib/types";
import type { useWorkspaces } from "./useWorkspaces";
import { remoteAliases, useEnvStates } from "./useEnvLinks";

type Deps = {
  workspaces: ReturnType<typeof useWorkspaces>;
  active: Workspace | null;
  closePage: () => void;
  openSettings: (section?: SettingsSectionId) => void;
  /** A new shell in a workspace's main checkout, which need not be on screen yet. */
  openTerminalIn: (workspaceId: string, input?: string) => void;
};

/**
 * Everything the window does because a workspace can live on another machine:
 * ⌘O's machine picker, the rail's badge, "Open terminal on machine", and
 * routing each machine's pages to its localhost.
 */
export function useEnvironments({ workspaces, active, closePage, openSettings, openTerminalIn }: Deps) {
  const links = useEnvStates();
  /** Open, and the machine it starts on: null for the machine list. */
  const [picker, setPicker] = useState<{ start: string | null } | null>(null);
  const hasRemotes = links.some((link) => link.id !== LOCAL);
  const { create: pickLocalFolder, adopt, activate } = workspaces;

  // ⌘O: the native dialog while this Mac is the only machine, the picker once there is another.
  const openWorkspace = useCallback(() => {
    closePage();
    if (hasRemotes) setPicker({ start: null });
    else void pickLocalFolder();
  }, [closePage, hasRemotes, pickLocalFolder]);

  const closePicker = useCallback(() => setPicker(null), []);

  const openLocal = useCallback(() => {
    setPicker(null);
    void pickLocalFolder();
  }, [pickLocalFolder]);

  const addMachine = useCallback(() => {
    setPicker(null);
    requestAddRemote();
    openSettings("environments");
  }, [openSettings]);

  /** Opens `path` on `envId`, or goes to the workspace already open there. */
  const openOn = useCallback(
    async (envId: string, path: string, name: string) => {
      const existing = workspaces.workspaces.find((item) => item.path === path && envOf(item.id) === envId);
      const workspace = existing ?? (await api.createWorkspace(name, path, envId));
      setPicker(null);
      closePage();
      if (existing) activate(existing.id);
      else adopt(workspace);
    },
    [activate, adopt, closePage, workspaces.workspaces],
  );

  /**
   * A shell on the machine: in the workspace on its home, or else in the first
   * workspace it has, or in a new one on its home. `input` is typed into it once it is up.
   */
  const openTerminalOn = useCallback(
    async (envId: string, input?: string) => {
      const link = linkOf(envId);
      const home = link?.home;
      if (!link || link.status !== "online" || !home) throw new Error(`${link?.name ?? "That machine"} is not connected`);
      const here = workspaces.workspaces.filter((item) => envOf(item.id) === envId);
      const existing = here.find((item) => item.path === home) ?? here[0];
      const workspace = existing ?? (await api.createWorkspace(link.name, home, envId));
      closePage();
      openTerminalIn(workspace.id, input);
      if (existing) activate(existing.id);
      else adopt(workspace);
    },
    [activate, adopt, closePage, openTerminalIn, workspaces.workspaces],
  );

  useEffect(() => {
    setFocusEnv(active ? envOf(active.id) : LOCAL);
  }, [active]);

  // Every page reaches each machine's localhost at its alias; main hears only when that changes.
  const routed = useRef("");
  useEffect(() => {
    const aliases = remoteAliases(links);
    const machines: MachineRoute[] = links.flatMap((link) => {
      const alias = aliases.get(link.id);
      if (!alias) return [];
      return [{ alias, envId: link.id, socksPort: link.socksPort }];
    });
    const key = JSON.stringify(machines);
    if (key === routed.current) return;
    routed.current = key;
    void browserHost()?.setMachines?.(machines);
  }, [links]);

  useEffect(() => {
    const host = remotesHost();
    if (!host) return;
    return host.onWake(() => {
      void api.stateGet(WAKE_ON).then((value) => {
        if (value !== "off") wakeAll();
      });
    });
  }, []);

  useEffect(() => {
    setOpenWorkspaceOn((envId) => {
      closePage();
      setPicker({ start: envId });
    });
    setSettingsOpener(openSettings);
    return () => {
      setOpenWorkspaceOn(null);
      setSettingsOpener(null);
    };
  }, [closePage, openSettings]);

  /** The machine a workspace lives on, for the rail's badge. Null on this Mac. */
  const remoteOf = useCallback(
    (workspace: Workspace): EnvLink | null => {
      const env = envOf(workspace.id);
      if (env === LOCAL) return null;
      return links.find((item) => item.id === env) ?? null;
    },
    [links],
  );

  return { links, picker, openWorkspace, closePicker, openLocal, addMachine, openOn, openTerminalOn, remoteOf };
}
