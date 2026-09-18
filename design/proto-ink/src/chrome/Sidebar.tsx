import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { useApp } from "@/lib/store";
import { SessionList } from "./SessionList";
import { SettingsSidebar } from "./SettingsSidebar";
import { WorkspacePicker } from "./WorkspacePicker";

export const TRAFFIC_RESERVE = 78;

/**
 * The sidebar and the tab strip share one recessed surface, so the chrome reads
 * as a single L-shaped frame around one elevated canvas. The two views (sessions
 * and settings) slide against each other inside it; settings never opens a tab.
 */
export function Sidebar() {
  const { sidebarCollapsed, sidebarWidth, sidebarView, actions } = useApp();
  const [dragging, setDragging] = useState(false);
  const frame = useRef<number | null>(null);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      setDragging(true);
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
    },
    [],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        actions.setSidebarWidth(event.clientX);
      });
    };
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [dragging, actions]);

  return (
    <aside
      data-collapsed={sidebarCollapsed || undefined}
      style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
      className={cx(
        "relative z-10 flex shrink-0 flex-col overflow-hidden bg-recessed",
        !dragging && "transition-[width] duration-[var(--dur-4)] [transition-timing-function:var(--ease-enter)]",
      )}
    >
      <div
        className="flex h-full flex-col overflow-hidden"
        style={{ width: sidebarWidth }}
        aria-hidden={sidebarCollapsed}
      >
        <WorkspacePicker inset={TRAFFIC_RESERVE > 0 ? 34 : 8} />
        <div className="relative min-h-0 flex-1">
          <div
            className={cx(
              "absolute inset-0 flex flex-col transition-[transform,opacity] duration-[var(--dur-4)]",
              "[transition-timing-function:var(--ease-enter)]",
              sidebarView === "sessions" ? "translate-x-0 opacity-100" : "-translate-x-4 opacity-0 pointer-events-none",
            )}
          >
            <SessionList />
          </div>
          <div
            className={cx(
              "absolute inset-0 flex flex-col transition-[transform,opacity] duration-[var(--dur-4)]",
              "[transition-timing-function:var(--ease-enter)]",
              sidebarView === "settings" ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0 pointer-events-none",
            )}
          >
            <SettingsSidebar />
          </div>
        </div>
      </div>

      {!sidebarCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          tabIndex={0}
          onPointerDown={onPointerDown}
          onDoubleClick={() => actions.setSidebarWidth(268)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") actions.setSidebarWidth(sidebarWidth - 16);
            if (event.key === "ArrowRight") actions.setSidebarWidth(sidebarWidth + 16);
          }}
          className={cx(
            "absolute inset-y-0 right-0 z-20 w-[5px] cursor-col-resize",
            "after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-[var(--stroke-tertiary)]",
            "after:transition-colors after:duration-[var(--dur-2)]",
            "hover:after:bg-[var(--stroke-primary)] focus-visible:after:bg-[var(--accent)]",
            dragging && "after:bg-[var(--accent)]",
          )}
        />
      )}
    </aside>
  );
}
