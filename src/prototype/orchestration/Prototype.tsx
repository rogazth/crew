// PROTOTYPE — the window: Crew's sidebar shell and rail, the tab strip, the chat, the thread.
import { useState } from "react";
import { SidebarShell } from "../../chrome/SidebarShell";
import { SidebarToggle } from "../../chrome/SidebarToggle";
import { TOGGLE_RESERVE } from "../../lib/chrome";
import { ProtoChat } from "./Chat";
import { ProtoSidebar } from "./Sidebar";
import { Switcher } from "./Switcher";
import { ProtoTabs } from "./Tabs";
import { useProto } from "./store";

export function Prototype() {
  const { world } = useProto();
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(300);
  const session = world.sessions.find((s) => s.id === world.active) ?? world.sessions[0]!;

  return (
    <div className="flex h-full bg-sidebar">
      <SidebarShell open={open} width={width} minWidth={200} maxWidth={560} onResize={setWidth}>
        <div data-tauri-drag-region className="flex h-[39px] shrink-0 items-center">
          <div className={`h-full shrink-0 ${TOGGLE_RESERVE}`} />
        </div>
        <div className="flex min-h-0 flex-1">
          <Rail />
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col rounded-tl-xl border-t border-l border-border bg-canvas/40">
            <ProtoSidebar world={world} />
          </div>
        </div>
      </SidebarShell>
      <div className="flex min-w-0 flex-1 flex-col">
        <ProtoTabs world={world} inset={!open} />
        <div className="flex min-h-0 flex-1">
          {/* Keyed by the session: each chat keeps its own draft and scroll. */}
          <ProtoChat key={session.id} world={world} session={session} />
        </div>
      </div>
      <SidebarToggle onClick={() => setOpen((value) => !value)} />
      <Switcher />
    </div>
  );
}

/** The workspace rail, reduced to its marks: the prototype has one workspace. */
function Rail() {
  return (
    <div className="flex min-h-0 w-[52px] shrink-0 flex-col items-center gap-2 pt-1 pb-3">
      <span className="relative grid size-9 place-items-center rounded-xl">
        <span className="absolute -left-2 h-5 w-[3px] rounded-r-full bg-text" />
        <span className="grid size-9 place-items-center rounded-xl bg-accent text-[12px] font-semibold tracking-wide text-inverse">ST</span>
      </span>
      <span className="grid size-9 place-items-center rounded-[18px] bg-accent/80 text-[12px] font-semibold tracking-wide text-inverse opacity-60">DO</span>
    </div>
  );
}
