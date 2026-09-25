// PROTOTYPE — host: state, the keymap, dialogs, the variant switcher and a HUD
// that names every binding as it fires. Nothing persists; reload to reset.
import { CaretLeftIcon, CaretRightIcon, FileTextIcon, GitBranchIcon, KeyboardIcon, MoonIcon, SunIcon, TerminalWindowIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AGENT_AVATARS, type AgentAvatarId } from "../../lib/agentAvatar";
import { NewAgentDialog, NewWorktreeDialog, Palette, RenameDialog, ConfirmDialog, ShortcutsDialog, type PaletteItem } from "./dialogs";
import { keysOf, labelOf, match, LABELS, type Cmd } from "./keys";
import { Pane, TabBar } from "./shell";
import * as S from "./store";
import { AvatarStyle, DEFAULT_PREFS, Face, focusSidebar, Mark, type Prefs, type SidebarProps } from "./ui";
import { VariantA } from "./VariantA";
import { VariantB } from "./VariantB";
import { VariantC } from "./VariantC";

const VARIANTS = [
  { key: "A", name: "Tree", Component: VariantA },
  { key: "B", name: "Focus", Component: VariantB },
  { key: "C", name: "Rail", Component: VariantC },
] as const;

type Dialog =
  | { kind: "palette"; mode: "all" | "context" | "files" }
  | { kind: "new-agent"; worktreeId?: string }
  | { kind: "new-worktree" }
  | { kind: "rename"; id: string }
  | { kind: "confirm"; title: string; body: string; action: string; run: () => void }
  | { kind: "shortcuts" };

function readVariant() {
  const key = new URLSearchParams(location.search).get("variant") ?? "A";
  return VARIANTS.findIndex((v) => v.key === key) >= 0 ? key : "A";
}

export function Prototype() {
  const [st, setSt] = useState<S.State>(S.INITIAL);
  const [variant, setVariant] = useState(readVariant);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [hud, setHud] = useState<{ keys: string; label: string; n: number } | null>(null);
  const [scheme, setScheme] = useState<"dark" | "light">("dark");
  const [avatar, setAvatar] = useState<AgentAvatarId>("gaze");
  const stRef = useRef(st);
  useEffect(() => {
    stRef.current = st;
  });

  const update = useCallback((fn: (s: S.State) => S.State) => setSt(fn), []);

  useEffect(() => {
    document.documentElement.style.colorScheme = scheme;
    document.documentElement.dataset.mode = scheme;
    document.documentElement.classList.toggle("dark", scheme === "dark");
  }, [scheme]);

  const flash = (keys: string, label: string) => setHud((h) => ({ keys, label, n: (h?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!hud) return;
    const t = setTimeout(() => setHud(null), 1400);
    return () => clearTimeout(t);
  }, [hud]);

  const openSession = useCallback((id: string) => update((s) => S.markSeen(S.openSession(s, id), id)), [update]);

  const go = (index: number) => {
    const v = VARIANTS[(index + VARIANTS.length) % VARIANTS.length]!;
    setVariant(v.key);
    history.replaceState(null, "", `?variant=${v.key}`);
  };

  const run = useCallback(
    (cmd: Cmd) => {
      flash(keysOf(cmd), labelOf(cmd));
      const ws = /^workspace-(\d)$/.exec(cmd)?.[1];
      if (ws) {
        update((x) => {
          const target = x.workspaces[Number(ws) - 1];
          return target ? S.selectWorkspace(x, target.id) : x;
        });
        return;
      }
      const tree = /^worktree-(\d)$/.exec(cmd)?.[1];
      if (tree) {
        update((x) => {
          const target = S.worktreesOf(x, x.activeWorkspace)[Number(tree) - 1];
          return target ? S.selectWorktree(x, target.id) : x;
        });
        return;
      }
      switch (cmd) {
        case "toggle-sidebar":
          return update((x) => ({ ...x, sidebar: !x.sidebar }));
        case "palette":
          return setDialog((d) => (d?.kind === "palette" ? null : { kind: "palette", mode: "all" }));
        case "switch-context":
          return setDialog({ kind: "palette", mode: "context" });
        case "go-to-file":
        case "new-tab":
          return setDialog({ kind: "palette", mode: "files" });
        case "close-tab":
          return update((x) => S.closeTab(x));
        case "reopen-tab":
          return update(S.reopenTab);
        case "next-tab":
          return update((x) => S.stepTab(x, 1));
        case "prev-tab":
          return update((x) => S.stepTab(x, -1));
        case "next-workspace":
          return update((x) => S.stepWorkspace(x, 1));
        case "prev-workspace":
          return update((x) => S.stepWorkspace(x, -1));
        case "next-worktree":
          return update((x) => S.stepWorktree(x, 1));
        case "prev-worktree":
          return update((x) => S.stepWorktree(x, -1));
        case "new-agent":
          return setDialog({ kind: "new-agent" });
        case "new-session":
          return update((x) => {
            const tree = S.currentWorktree(x);
            const n = S.sessionsOf(x, tree.id).filter((y) => y.kind === "terminal").length;
            return S.createSession(x, tree.id, "terminal", n ? `zsh ${n + 1}` : "zsh");
          });
        case "new-worktree":
          return setDialog({ kind: "new-worktree" });
        case "focus-sidebar":
          update((x) => (x.sidebar ? x : { ...x, sidebar: true }));
          requestAnimationFrame(focusSidebar);
          return;
        case "shortcuts":
          return setDialog((d) => (d?.kind === "shortcuts" ? null : { kind: "shortcuts" }));
        case "toggle-tab-mode":
          return update((x) => S.setTabMode(x, x.tabMode === "worktree" ? "all" : "worktree"));
      }
    },
    [update],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        go(VARIANTS.findIndex((v) => v.key === variant) + (event.key === "ArrowRight" ? 1 : -1));
        return;
      }
      const cmd = match(event);
      if (!cmd) return;
      // A dialog owns the keyboard except for the palette/sheet toggles.
      if (dialog && cmd !== "palette" && cmd !== "shortcuts") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat && !/tab$|worktree$|workspace$/.test(cmd)) return;
      run(cmd);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const askRemove = useCallback(
    (kind: string, id: string) => {
      const s = stRef.current;
      if (kind === "worktree") {
        const tree = S.worktreeById(s, id);
        if (!tree || tree.main) return flash("⌘⌫", "The main checkout stays");
        setDialog({
          kind: "confirm",
          title: `Remove ${tree.branch}?`,
          body: tree.dirty
            ? `${tree.dirty} uncommitted changes in ${tree.path} will be lost, and its ${S.sessionsOf(s, id).length} sessions end.`
            : `Deletes ${tree.path} and ends its ${S.sessionsOf(s, id).length} sessions. The branch stays.`,
          action: "Remove",
          run: () => update((x) => S.removeWorktree(x, id)),
        });
        return;
      }
      const session = S.sessionById(s, id);
      if (!session) return;
      setDialog({
        kind: "confirm",
        title: `Delete ${session.name}?`,
        body: session.kind === "agent" ? "Its transcript goes with it." : "The process is killed.",
        action: "Delete",
        run: () => update((x) => S.removeSession(x, id)),
      });
    },
    [update],
  );

  const props: SidebarProps = {
    st,
    update,
    run,
    prefs,
    setPrefs,
    query,
    setQuery,
    searching,
    setSearching,
    openSession,
    askRename: (id) => setDialog({ kind: "rename", id }),
    askRemove,
  };

  const current = VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0];
  const Sidebar = current.Component;
  const close = () => setDialog(null);

  return (
    <AvatarStyle.Provider value={avatar}>
      <div className="flex h-full bg-canvas text-text">
        {st.sidebar && <Sidebar {...props} />}
        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar st={st} update={update} run={run} />
          <Pane st={st} run={run} />
        </div>
      </div>

      {dialog?.kind === "palette" && <Palette {...paletteFor(dialog.mode, st, update, run, openSession)} onClose={close} />}
      {dialog?.kind === "new-agent" && (
        <NewAgentDialog
          st={st}
          initialName={S.nextAgentName(st)}
          {...(dialog.worktreeId ? { initialWorktree: dialog.worktreeId } : {})}
          onClose={close}
          onCreate={(name, target) => {
            close();
            update((x) => {
              if ("branch" in target) {
                const [next, id] = S.createWorktree(x, target.branch);
                return S.createSession(next, id, "agent", name);
              }
              return S.createSession(x, target.worktreeId, "agent", name);
            });
          }}
        />
      )}
      {dialog?.kind === "new-worktree" && (
        <NewWorktreeDialog
          st={st}
          onClose={close}
          onCreate={(branch, withAgent) => {
            update((x) => S.createWorktree(x, branch)[0]);
            setDialog(withAgent ? { kind: "new-agent" } : null);
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <RenameDialog
          initial={S.sessionById(st, dialog.id)?.name ?? ""}
          onClose={close}
          onCommit={(name) => {
            update((x) => S.rename(x, dialog.id, name));
            close();
            requestAnimationFrame(focusSidebar);
          }}
        />
      )}
      {dialog?.kind === "confirm" && (
        <ConfirmDialog
          {...dialog}
          onClose={close}
          onConfirm={() => {
            dialog.run();
            close();
          }}
        />
      )}
      {dialog?.kind === "shortcuts" && <ShortcutsDialog onClose={close} />}

      {hud && (
        <div key={hud.n} className="pointer-events-none fixed bottom-20 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2.5 rounded-full bg-black/80 px-4 py-2 text-[13px] text-white shadow-lg">
          <span className="font-mono">{hud.keys}</span>
          <span className="opacity-70">{hud.label}</span>
        </div>
      )}

      <Switcher
        variant={current}
        onStep={(d) => go(VARIANTS.findIndex((v) => v.key === variant) + d)}
        st={st}
        onTabMode={() => run("toggle-tab-mode")}
        scheme={scheme}
        onScheme={() => setScheme((x) => (x === "dark" ? "light" : "dark"))}
        avatar={avatar}
        onAvatar={setAvatar}
        onShortcuts={() => run("shortcuts")}
      />
    </AvatarStyle.Provider>
  );
}

function paletteFor(
  mode: "all" | "context" | "files",
  st: S.State,
  update: (fn: (s: S.State) => S.State) => void,
  run: (cmd: Cmd) => void,
  openSession: (id: string) => void,
): { items: PaletteItem[]; placeholder: string } {
  const contexts: PaletteItem[] = st.worktrees.map((tree) => {
    const ws = st.workspaces.find((w) => w.id === tree.workspaceId)!;
    return {
      id: `ctx-${tree.id}`,
      group: "Worktrees",
      detail: `${ws.name} ›`,
      label: tree.branch,
      icon: <GitBranchIcon className="size-4" />,
      keys: tree.id === S.currentWorktree(st).id ? "current" : "",
      run: () => update((x) => S.selectWorktree(x, tree.id)),
    };
  });
  if (mode === "context") return { items: contexts, placeholder: "Switch to repo › worktree…" };

  const tree = S.currentWorktree(st);
  const files: PaletteItem[] = S.FILES.map((path) => ({
    id: `file-${path}`,
    group: `Files in ${tree.branch}`,
    label: path,
    icon: <FileTextIcon className="size-4" />,
    run: () => update((x) => S.openFile(x, path)),
  }));
  if (mode === "files") return { items: files, placeholder: `Open a file in ${tree.branch}…` };

  const sessions: PaletteItem[] = st.sessions
    .filter((x) => S.worktreeById(st, x.worktreeId)?.workspaceId === st.activeWorkspace)
    .map((x) => ({
      id: `s-${x.id}`,
      group: "Agents & sessions",
      detail: `${S.worktreeById(st, x.worktreeId)!.branch} ›`,
      label: x.name,
      icon: x.kind === "agent" ? <Face seed={x.id} className="size-5" /> : <TerminalWindowIcon className="size-4" />,
      run: () => openSession(x.id),
    }));
  const commands: PaletteItem[] = (Object.keys(LABELS) as Cmd[])
    .filter((c) => c !== "palette")
    .map((c) => ({ id: `c-${c}`, group: "Commands", label: labelOf(c), keys: keysOf(c), run: () => run(c) }));
  const workspaces: PaletteItem[] = st.workspaces.map((w, i) => ({
    id: `w-${w.id}`,
    group: "Workspaces",
    label: w.name,
    icon: <Mark name={w.name} className="size-4 rounded text-[8px]" />,
    keys: `⌘${i + 1}`,
    run: () => update((x) => S.selectWorkspace(x, w.id)),
  }));
  return { items: [...sessions, ...contexts, ...workspaces, ...commands], placeholder: "Search agents, worktrees, commands…" };
}

function Switcher({
  variant,
  onStep,
  st,
  onTabMode,
  scheme,
  onScheme,
  avatar,
  onAvatar,
  onShortcuts,
}: {
  variant: (typeof VARIANTS)[number];
  onStep: (delta: number) => void;
  st: S.State;
  onTabMode: () => void;
  scheme: "dark" | "light";
  onScheme: () => void;
  avatar: AgentAvatarId;
  onAvatar: (id: AgentAvatarId) => void;
  onShortcuts: () => void;
}) {
  if (import.meta.env.PROD) return null;
  const tab = S.activeTab(st);
  return (
    <div className="fixed bottom-4 left-1/2 z-[55] flex -translate-x-1/2 items-center gap-1 rounded-full bg-[oklch(22%_0.02_280)] px-1.5 py-1 text-[12px] text-white shadow-2xl ring-1 ring-white/10">
      <Btn onClick={() => onStep(-1)} title="Previous variant ⌃⌥←">
        <CaretLeftIcon className="size-3.5" />
      </Btn>
      <span className="w-[70px] text-center font-medium">
        {variant.key} · {variant.name}
      </span>
      <Btn onClick={() => onStep(1)} title="Next variant ⌃⌥→">
        <CaretRightIcon className="size-3.5" />
      </Btn>
      <span className="mx-1 h-4 w-px bg-white/20" />
      <button type="button" onClick={onTabMode} title="⌥⌘T" className="h-7 rounded-full px-2.5 whitespace-nowrap hover:bg-white/15">
        Tabs: <b>{st.tabMode === "worktree" ? "per worktree" : "all together"}</b>
      </button>
      <span className="mx-1 h-4 w-px bg-white/20" />
      <select
        value={avatar}
        onChange={(event) => onAvatar(event.target.value as AgentAvatarId)}
        className="h-7 rounded-full bg-transparent px-1.5 outline-none hover:bg-white/15"
        title="Avatar style"
      >
        {AGENT_AVATARS.map((a) => (
          <option key={a.id} value={a.id} className="text-black">
            {a.label}
          </option>
        ))}
      </select>
      <Btn onClick={onScheme} title="Theme">
        {scheme === "dark" ? <SunIcon className="size-3.5" /> : <MoonIcon className="size-3.5" />}
      </Btn>
      <Btn onClick={onShortcuts} title="Shortcuts ⌘/">
        <KeyboardIcon className="size-4" />
      </Btn>
      <span className="mx-1 h-4 w-px bg-white/20" />
      <span className="max-w-[260px] truncate pr-2 font-mono text-[11px] opacity-70">
        {S.workspace(st).name}›{S.currentWorktree(st).branch} · {S.visibleTabs(st).length} tabs · {tab ? S.tabLabel(st, tab) : "—"}
      </span>
    </div>
  );
}

function Btn({ onClick, title, children }: { onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} className="grid h-7 min-w-7 place-items-center rounded-full px-1.5 hover:bg-white/15">
      {children}
    </button>
  );
}
