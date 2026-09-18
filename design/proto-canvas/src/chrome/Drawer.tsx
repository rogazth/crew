import { useEffect, useState } from "react";
import { cx } from "@/lib/cx";
import { useStore, type Drawer as DrawerState } from "@/lib/store";
import { DiffPanel } from "@/surfaces/DiffView";
import { AgentSheet } from "./AgentSheet";
import { AgentThreadPanel } from "./AgentThreadPanel";

const WIDTH: Record<NonNullable<DrawerState>["kind"], number> = {
  "agent-thread": 460,
  "agent-sheet": 380,
  diff: 580,
};

/**
 * One drawer, three contents, one animation. Making it first-class chrome is
 * what stops the agent sheet, the thread view and a diff preview each inventing
 * their own panel.
 */
export function Drawer() {
  const { drawer, setDrawer } = useStore();
  const [shown, setShown] = useState<DrawerState>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (drawer) {
      setShown(drawer);
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setVisible(false);
    const timer = window.setTimeout(() => setShown(null), 280);
    return () => window.clearTimeout(timer);
  }, [drawer]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, setDrawer]);

  if (!shown) return null;
  const width = WIDTH[shown.kind];

  return (
    <>
      <div
        role="presentation"
        onClick={() => setDrawer(null)}
        className={cx(
          "fixed inset-0 z-[55] bg-scrim transition-opacity duration-[280ms]",
          visible ? "opacity-100" : "opacity-0",
        )}
        style={{ transitionTimingFunction: "var(--ease-out)" }}
      />
      <aside
        aria-label="Drawer"
        className="fixed inset-y-0 right-0 z-[56] flex flex-col bg-overlay el-4"
        style={{
          width,
          maxWidth: "calc(100vw - 48px)",
          transform: visible ? "none" : `translateX(${width}px)`,
          transition: "transform 280ms var(--ease-out)",
        }}
      >
        {shown.kind === "agent-sheet" && (
          <AgentSheet mode={shown.mode} {...(shown.sessionId ? { sessionId: shown.sessionId } : {})} />
        )}
        {shown.kind === "agent-thread" && (
          <AgentThreadPanel sessionId={shown.sessionId} peerId={shown.peerId} />
        )}
        {shown.kind === "diff" && <DiffPanel path={shown.path} />}
      </aside>
    </>
  );
}
