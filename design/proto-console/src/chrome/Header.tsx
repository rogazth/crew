import { useRef } from "react";
import { PanelLeft } from "lucide-react";
import type { CommandId } from "@crew/fixtures";
import { CommandKbd, Tooltip } from "@/ui";
import { store, useApp } from "@/lib/store";
import { WorkspacePicker } from "./WorkspacePicker";
import { DemoMenu } from "./DemoMenu";

/**
 * 28px of chrome. It carries the macOS traffic-light reserve, so the reserve
 * never has to move between the sidebar and the tab strip.
 */
export function Header() {
  const state = useApp();
  const crumbRef = useRef<HTMLButtonElement>(null);
  const workspace = state.workspaces.find((w) => w.id === state.workspaceId);

  return (
    <header className="flex h-[var(--h-header)] shrink-0 items-stretch border-b border-rule bg-bg select-none">
      <div className="w-[var(--traffic)] shrink-0" aria-hidden />
      <button
        type="button"
        onClick={() => store.toggleSidebar()}
        aria-label="Toggle sidebar"
        title="Toggle sidebar"
        className="grid w-6 shrink-0 place-items-center text-ink-4 hover:text-ink"
      >
        <PanelLeft size={13} strokeWidth={1.25} />
      </button>
      <button
        ref={crumbRef}
        type="button"
        onClick={() => store.openOverlay({ kind: "workspaces" })}
        className="flex min-w-0 items-center gap-1.5 px-2 font-mono text-sm text-ink-3 hover:text-ink"
      >
        <span>workspace</span>
        <span className="text-ink-4">▸</span>
        <span className="truncate text-ink">{workspace?.name ?? "—"}</span>
      </button>
      <span className="truncate self-center pl-1 font-mono text-xs text-ink-4">
        {workspace?.path}
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-1 pr-2">
        <DemoMenu />
        <HeaderChord id="open-palette" hint="Command palette — sessions, files, actions" />
        <HeaderChord id="go-to-file" hint="Go to file" />
        <HeaderChord id="open-settings" hint="Settings" />
      </div>
      <WorkspacePicker anchor={crumbRef.current} />
    </header>
  );
}

function HeaderChord({ id, hint }: { id: CommandId; hint: string }) {
  return (
    <Tooltip content={hint} side="bottom">
      <span className="hidden items-center gap-1 md:flex">
        <CommandKbd id={id} />
      </span>
    </Tooltip>
  );
}
