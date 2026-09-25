import { PanelLeftIcon } from "lucide-react";
import { commandKeys } from "../lib/commands";
import { IS_MAC } from "../lib/hotkey";

/**
 * One toggle for both states, pinned to the window rather than to the sidebar
 * or the tab strip, so collapsing never moves it. Its centre sits on the
 * traffic lights' line, a pixel under the strip's middle.
 */
export function SidebarToggle({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-tauri-drag-region="false"
      aria-label="Toggle sidebar"
      title={`Toggle sidebar ${commandKeys("toggle-sidebar")}`}
      onClick={onClick}
      className={`fixed top-[7px] z-40 grid size-7 place-items-center rounded-md text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:bg-hover ${
        IS_MAC ? "left-[80px]" : "left-2"
      }`}
    >
      <PanelLeftIcon className="size-[18px]" />
    </button>
  );
}
