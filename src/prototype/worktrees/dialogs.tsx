// PROTOTYPE — palette and the small dialogs behind the new bindings.
import { GitBranchIcon, PlusIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fuzzyMatch } from "../../lib/fuzzy";
import { CHEATSHEET } from "./keys";
import { currentWorktree, worktreesOf, type State } from "./store";
import { Kbd } from "../../chrome/Kbd";

function Modal({ children, onClose, width = "w-[520px]", top = "top-[14vh]" }: { children: ReactNode; onClose: () => void; width?: string; top?: string }) {
  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
        className={`absolute left-1/2 ${top} ${width} max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-xl bg-kumo-control text-kumo-default shadow-2xl ring ring-kumo-line`}
      >
        {children}
      </div>
    </div>
  );
}

function Footer({ hints }: { hints: [string, string][] }) {
  return (
    <div className="flex h-9 items-center gap-4 border-t border-kumo-line px-3 text-[11px] text-kumo-subtle">
      {hints.map(([keys, label]) => (
        <span key={label} className="flex items-center gap-1.5">
          <Kbd keys={keys} /> {label}
        </span>
      ))}
    </div>
  );
}

// ── Palette ────────────────────────────────────────────────────────────

export type PaletteItem = {
  id: string;
  group: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  keys?: string;
  run: () => void;
};

export function Palette({ items, placeholder, onClose }: { items: PaletteItem[]; placeholder: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => {
    if (!query.trim()) return items;
    return items
      .flatMap((item) => {
        const hit = fuzzyMatch(query, `${item.detail ?? ""} ${item.label}`);
        return hit ? [{ item, score: hit.score }] : [];
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  }, [items, query]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, visible.length - 1));
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = visible[cursor];
      if (item) {
        onClose();
        item.run();
      }
    }
  }

  return (
    <Modal onClose={onClose} width="w-[560px]">
      <input
        autoFocus
        value={query}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value);
          setCursor(0);
        }}
        onKeyDown={onKeyDown}
        className="h-12 w-full border-b border-kumo-line bg-transparent px-4 text-[14px] outline-none"
      />
      <div ref={list} className="max-h-[50vh] overflow-y-auto p-1.5">
        {visible.map((item, index) => {
          const header = !query.trim() && item.group !== visible[index - 1]?.group ? item.group : null;
          return (
            <div key={item.id}>
              {header && <div className="px-2.5 pt-2 pb-1 text-[11px] text-kumo-subtle">{header}</div>}
              <button
                type="button"
                data-index={index}
                onMouseMove={() => setCursor(index)}
                onClick={() => {
                  onClose();
                  item.run();
                }}
                className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left ${index === cursor ? "bg-hover" : ""}`}
              >
                {item.icon && <span className="grid size-5 shrink-0 place-items-center text-kumo-subtle">{item.icon}</span>}
                {item.detail && <span className="shrink-0 text-kumo-subtle">{item.detail}</span>}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.keys && <span className="shrink-0 text-[11px] text-kumo-subtle">{item.keys}</span>}
              </button>
            </div>
          );
        })}
        {visible.length === 0 && <p className="px-2.5 py-6 text-center text-placeholder">No matches</p>}
      </div>
      <Footer hints={[["↑↓", "move"], ["↵", "open"], ["esc", "close"]]} />
    </Modal>
  );
}

// ── New agent: name, then where it works ───────────────────────────────

type Target = { kind: "existing"; id: string } | { kind: "new" };

export function NewAgentDialog({
  st,
  initialName,
  initialWorktree,
  onCreate,
  onClose,
}: {
  st: State;
  initialName: string;
  initialWorktree?: string;
  onCreate: (name: string, target: { worktreeId: string } | { branch: string }) => void;
  onClose: () => void;
}) {
  const trees = worktreesOf(st, st.activeWorkspace);
  const [name, setName] = useState(initialName);
  const [cursor, setCursor] = useState(Math.max(0, trees.findIndex((t) => t.id === (initialWorktree ?? currentWorktree(st).id))));
  const [branch, setBranch] = useState("feat/");
  const branchInput = useRef<HTMLInputElement>(null);
  const targets: Target[] = [...trees.map((t) => ({ kind: "existing" as const, id: t.id })), { kind: "new" }];
  const target = targets[cursor]!;

  useEffect(() => {
    if (target.kind === "new") branchInput.current?.focus();
  }, [target.kind]);

  function submit() {
    if (!name.trim()) return;
    if (target.kind === "new") {
      if (branch.trim() && branch.trim() !== "feat/") onCreate(name.trim(), { branch: branch.trim() });
    } else onCreate(name.trim(), { worktreeId: target.id });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, targets.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Modal onClose={onClose} width="w-[420px]">
      <div className="flex flex-col gap-3 p-4" onKeyDown={onKeyDown}>
        <div className="text-[14px] font-semibold">New agent</div>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          placeholder="Name"
          className="h-9 rounded-md bg-kumo-base px-3 ring ring-kumo-line outline-none focus:ring-kumo-focus/50"
        />
        <div className="text-[12px] text-kumo-subtle">Works in</div>
        <div className="flex flex-col gap-0.5">
          {trees.map((tree, index) => (
            <button
              key={tree.id}
              type="button"
              tabIndex={-1}
              onClick={() => setCursor(index)}
              className={`flex h-8 items-center gap-2 rounded-md px-2 text-left ${cursor === index ? "bg-selected" : "hover:bg-hover"}`}
            >
              <GitBranchIcon className="size-3.5 shrink-0 text-kumo-subtle" />
              <span className="min-w-0 flex-1 truncate">{tree.branch}</span>
              {tree.id === currentWorktree(st).id && <span className="text-[11px] text-kumo-subtle">current</span>}
            </button>
          ))}
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setCursor(trees.length)}
            className={`flex h-8 items-center gap-2 rounded-md px-2 text-left ${target.kind === "new" ? "bg-selected" : "hover:bg-hover"}`}
          >
            <PlusIcon className="size-3.5 shrink-0 text-kumo-subtle" />
            {target.kind === "new" ? (
              <input
                ref={branchInput}
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="branch name"
                className="min-w-0 flex-1 bg-transparent outline-none"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">New branch in a new worktree…</span>
            )}
          </button>
        </div>
      </div>
      <Footer hints={[["↑↓", "worktree"], ["↵", "create"], ["esc", "cancel"]]} />
    </Modal>
  );
}

// ── New worktree ───────────────────────────────────────────────────────

export function NewWorktreeDialog({ st, onCreate, onClose }: { st: State; onCreate: (branch: string, withAgent: boolean) => void; onClose: () => void }) {
  const [branch, setBranch] = useState("feat/");
  const base = currentWorktree(st).branch;
  const slug = branch.replace(/[^\w.-]+/g, "-");
  const ws = st.workspaces.find((w) => w.id === st.activeWorkspace)!;
  return (
    <Modal onClose={onClose} width="w-[420px]">
      <div className="flex flex-col gap-3 p-4">
        <div className="text-[14px] font-semibold">New worktree</div>
        <input
          autoFocus
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !branch.trim() || branch === "feat/") return;
            event.preventDefault();
            onCreate(branch.trim(), event.metaKey || event.ctrlKey);
          }}
          placeholder="Branch"
          className="h-9 rounded-md bg-kumo-base px-3 ring ring-kumo-line outline-none focus:ring-kumo-focus/50"
        />
        <div className="flex flex-col gap-1 text-[12px] text-kumo-subtle">
          <span>
            From <span className="text-kumo-default">{base}</span>
          </span>
          <span className="truncate font-mono text-[11px]">~/.crew/worktrees/{ws.name}/{slug}</span>
        </div>
      </div>
      <Footer hints={[["↵", "create"], ["⌘↵", "create + agent"], ["esc", "cancel"]]} />
    </Modal>
  );
}

// ── Rename / confirm / shortcuts ───────────────────────────────────────

export function RenameDialog({ initial, onCommit, onClose }: { initial: string; onCommit: (name: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <Modal onClose={onClose} width="w-[360px]">
      <div className="p-3">
        <input
          autoFocus
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && value.trim()) onCommit(value.trim());
          }}
          className="h-9 w-full rounded-md bg-kumo-base px-3 ring ring-kumo-line outline-none"
        />
      </div>
      <Footer hints={[["↵", "rename"], ["esc", "cancel"]]} />
    </Modal>
  );
}

export function ConfirmDialog({ title, body, action, onConfirm, onClose }: { title: string; body: string; action: string; onConfirm: () => void; onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => button.current?.focus(), []);
  return (
    <Modal onClose={onClose} width="w-[380px]">
      <div className="flex flex-col gap-2 p-4">
        <div className="text-[14px] font-semibold">{title}</div>
        <p className="text-kumo-subtle">{body}</p>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-md px-3 hover:bg-hover">
            Cancel
          </button>
          <button ref={button} type="button" onClick={onConfirm} className="h-8 rounded-md bg-kumo-danger px-3 text-white outline-none focus-visible:ring-2 focus-visible:ring-kumo-danger/40">
            {action} ↵
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  return (
    <Modal onClose={onClose} width="w-[720px]" top="top-[8vh]">
      <div ref={box} tabIndex={-1} className="grid max-h-[80vh] grid-cols-2 gap-x-8 gap-y-5 overflow-y-auto p-5 outline-none">
        {CHEATSHEET.map((section) => (
          <div key={section.group} className="flex flex-col gap-1">
            <div className="pb-1 text-[11px] font-medium tracking-wide text-kumo-subtle uppercase">{section.group}</div>
            {section.rows.map(([keys, label]) => (
              <div key={label} className="flex items-baseline gap-3">
                <span className="w-24 shrink-0 font-mono text-[12px]">{keys}</span>
                <span className="text-kumo-subtle">{label}</span>
              </div>
            ))}
          </div>
        ))}
        <p className="col-span-2 text-[12px] text-kumo-subtle">
          In the browser ⌘T, ⌘W, ⌘N and ⌘1‥9 belong to Chrome — press ⌃ in place of ⌘ for any binding.
        </p>
      </div>
    </Modal>
  );
}
