import { useCallback } from "react";
import { Overlay } from "./kit";
import { commandKeys, type CommandId } from "../lib/commands";

type Row = [keys: string, label: string];

const pair = (a: CommandId, b: CommandId) => `${commandKeys(a)}  ${commandKeys(b)}`;
const range = (first: CommandId) => `${commandKeys(first)}‥9`;

/** Built from the live bindings, so a rebinding shows up here without a second list to keep. */
function sections(): { group: string; rows: Row[] }[] {
  return [
    {
      group: "Context",
      rows: [
        [range("workspace-1"), "Go to workspace"],
        [pair("prev-workspace", "next-workspace"), "Previous / next workspace"],
        [range("worktree-1"), "Go to worktree"],
        [pair("prev-worktree", "next-worktree"), "Previous / next worktree"],
        [commandKeys("switch-workspace"), "Switch to any repo › worktree"],
      ],
    },
    {
      group: "Create",
      rows: [
        [commandKeys("new-session"), "New session in this worktree"],
        [commandKeys("new-agent"), "New agent — pick a worktree or a new branch"],
        [commandKeys("new-worktree"), "New worktree"],
        [commandKeys("open-workspace"), "Open workspace"],
      ],
    },
    {
      group: "Tabs",
      rows: [
        [commandKeys("open-launcher"), "New tab"],
        [commandKeys("go-to-file"), "Open a file in this worktree"],
        [pair("close", "reopen-tab"), "Close / reopen tab"],
        [pair("prev-tab", "next-tab"), "Previous / next tab"],
      ],
    },
    {
      group: "Sidebar",
      rows: [
        [commandKeys("toggle-sidebar"), "Toggle sidebar"],
        [commandKeys("focus-sidebar"), "Focus sidebar"],
        ["↑ ↓ ← →", "Move — across the rail, the faces and the rows"],
        ["← →", "Fold a worktree"],
        ["↵", "Open"],
        ["F2", "Rename"],
        ["⇧F10", "Actions menu"],
        ["⌘⌫", "Delete a session, remove a worktree"],
        ["/", "Find"],
      ],
    },
    {
      group: "Everywhere",
      rows: [
        [commandKeys("open-palette"), "Command palette"],
        [commandKeys("open-actions"), "All actions"],
        [commandKeys("search-messages"), "Search messages"],
        [commandKeys("open-settings"), "Settings"],
        [commandKeys("shortcuts"), "This sheet"],
      ],
    },
  ];
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const box = useCallback((node: HTMLDivElement | null) => node?.focus(), []);
  return (
    <Overlay onClose={onClose} width="w-[720px]">
      <div
        ref={box}
        tabIndex={-1}
        aria-label="Keyboard shortcuts"
        className="grid max-h-[72vh] grid-cols-2 gap-x-8 gap-y-5 overflow-y-auto p-5 outline-none"
      >
        {sections().map((section) => (
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
      </div>
    </Overlay>
  );
}
