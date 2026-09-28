import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { LOCAL, envOf, linkOf, pinSessionCwd, setFocusEnv, wakeAll, type EnvLink } from "../lib/client/registry";
import { browserHost, filesHost, remotesHost } from "../lib/host";
import { requestAddRemote, setOpenWorkspaceOn, setSettingsOpener, WAKE_ON } from "../lib/remoteUi";
import type { SettingsSectionId } from "../lib/settings";
import type { Session, SessionKind, Workspace } from "../lib/types";
import type { useWorkspaces } from "./useWorkspaces";
import { useDefaultAgent } from "./useDefaultAgent";
import { useEnvStates } from "./useEnvLinks";

type Deps = {
  workspaces: ReturnType<typeof useWorkspaces>;
  active: Workspace | null;
  closePage: () => void;
  openSettings: (section?: SettingsSectionId) => void;
  create: (kind: SessionKind, input: Parameters<typeof api.createSession>[2]) => Promise<Session | null>;
  openSession: (session: Session) => void;
};

/**
 * Everything the window does because a workspace can live on another machine:
 * ⌘O's machine picker, the rail's badge, "Open terminal on machine", and
 * pointing each remote workspace's files and pages at the daemon that has them.
 */
export function useEnvironments({ workspaces, active, closePage, openSettings, create, openSession }: Deps) {
  const links = useEnvStates();
  const agent = useDefaultAgent();
  /** Open, and the machine it starts on: null for the machine list. */
  const [picker, setPicker] = useState<{ start: string | null } | null>(null);
  const pendingTerminal = useRef<{ workspaceId: string; home: string } | null>(null);
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

  const startTerminal = useCallback(
    async (home: string) => {
      const session = await create("terminal", {
        name: "Terminal",
        provider: agent.effective.provider,
        model: agent.effective.model,
        description: "",
        autonomy: "ask",
        worktree: home,
      });
      if (!session) return;
      pinSessionCwd(session.id, home);
      openSession(session);
    },
    [agent.effective, create, openSession],
  );

  /** A shell in the machine's home, in a workspace on it: the first one, or a new one on its home. */
  const openTerminalOn = useCallback(
    async (envId: string) => {
      const link = linkOf(envId);
      const home = link?.home;
      if (!link || link.status !== "online" || !home) throw new Error(`${link?.name ?? "That machine"} is not connected`);
      const existing = workspaces.workspaces.find((item) => envOf(item.id) === envId);
      const workspace = existing ?? (await api.createWorkspace(link.name, home, envId));
      closePage();
      if (active?.id === workspace.id) {
        await startTerminal(home);
        return;
      }
      pendingTerminal.current = { workspaceId: workspace.id, home };
      if (existing) activate(existing.id);
      else adopt(workspace);
    },
    [activate, active?.id, adopt, closePage, startTerminal, workspaces.workspaces],
  );

  // The terminal waits for its workspace to be the active one: sessions are created in that one.
  useEffect(() => {
    const job = pendingTerminal.current;
    if (!job || active?.id !== job.workspaceId) return;
    pendingTerminal.current = null;
    void startTerminal(job.home);
  }, [active?.id, startTerminal]);

  useEffect(() => {
    setFocusEnv(active ? envOf(active.id) : LOCAL);
  }, [active]);

  // A remote workspace's previews are served by its daemon, and its pages reach that machine's localhost.
  const bound = useRef(new Map<string, string>());
  useEffect(() => {
    const files = filesHost();
    const browser = browserHost();
    const next = new Map<string, string>();
    const byId = new Map(links.map((link) => [link.id, link]));
    for (const workspace of workspaces.workspaces) {
      const env = envOf(workspace.id);
      if (env === LOCAL) continue;
      const link = byId.get(env);
      next.set(workspace.id, `${env}|${workspace.path}|${link?.socksPort ?? ""}`);
      if (bound.current.get(workspace.id) === next.get(workspace.id)) continue;
      void files?.bindRemote?.(workspace.path, env);
      if (link?.socksPort) void browser?.setProxy?.(workspace.id, env, link.socksPort);
    }
    for (const [id, key] of bound.current) {
      if (next.has(id)) continue;
      const root = key.split("|")[1];
      if (root) void files?.unbindRemote?.(root);
      void browser?.setProxy?.(id, null, null);
    }
    bound.current = next;
  }, [links, workspaces.workspaces]);

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
