/**
 * The right panel: a second sheet on the chrome's ground, hung from the main
 * sheet's edge. It comes in from beyond the window and pushes the main sheet
 * aside; neither sheet dims when the other has the keyboard. One thing at a
 * time: the chat's sub-agents, or one of them. The slot is the window's; each
 * chat keeps its own host in it, so a thread keeps its draft and its scroll
 * while another chat is on screen.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSidebarWidth } from "../../hooks/useSidebarWidth";

const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 420;
/** Long enough for the spring to land; a frame that never comes must not leave the pane shut. */
const LAND_MS = 500;

type Motion = { x: number; v: number };

/** A damped spring on the slot's width: interruptible, a new target keeps its velocity. */
function moveTo(slot: HTMLElement, m: Motion, to: number, snap: boolean): (() => void) | undefined {
  const land = () => {
    m.x = to;
    m.v = 0;
    slot.style.width = `${to}px`;
  };
  if (snap || document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    land();
    return undefined;
  }
  let frame = 0;
  let last = performance.now();
  const tick = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    for (let left = dt; left > 0; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240);
      m.v += (-420 * (m.x - to) - 40 * m.v) * h;
      m.x += m.v * h;
    }
    if (Math.abs(m.x - to) < 0.5 && Math.abs(m.v) < 5) {
      land();
      return;
    }
    slot.style.width = `${Math.round(m.x)}px`;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  const timer = window.setTimeout(() => {
    cancelAnimationFrame(frame);
    land();
  }, LAND_MS);
  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}

/** The host out of sight: another chat's on screen, or the pane has gone past the window's edge. */
function showHost(host: HTMLElement, shown: boolean) {
  host.style.visibility = shown ? "" : "hidden";
}
const hideHost = (host: HTMLElement, hidden: boolean) => {
  host.hidden = hidden;
};
const placeHost = (host: HTMLElement, width: number) => host.style.setProperty("--side-w", `${width}px`);
const shutSlot = (slot: HTMLElement) => {
  slot.style.width = "0px";
};

export function SidePanel({ open, active, onHost, children }: { open: boolean; active: boolean; onHost?: (el: HTMLElement | null) => void; children: ReactNode }) {
  const [host] = useState(() => {
    const el = document.createElement("div");
    el.className = "ds-side-host";
    return el;
  });
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const { width: stored, resize } = useSidebarWidth("side-panel:width", DEFAULT_WIDTH);
  const width = stored ?? DEFAULT_WIDTH;
  const [dragging, setDragging] = useState(false);
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  const start = useRef<{ x: number; width: number } | null>(null);

  // A chat coming on screen shows its panel as it left it; only opening and closing it moves.
  // Mounting is opening: the chat mounts this the first time its panel opens.
  const [wasActive, setWasActive] = useState(active);
  const [settling, setSettling] = useState(false);
  if (wasActive !== active) {
    setWasActive(active);
    setSettling(true);
  }
  useEffect(() => {
    if (!settling) return;
    const frame = requestAnimationFrame(() => setSettling(false));
    return () => cancelAnimationFrame(frame);
  }, [settling]);

  useLayoutEffect(() => {
    const found = document.querySelector<HTMLElement>("[data-side-slot]");
    if (found && !host.isConnected) found.append(host);
    setSlot(found);
    return () => host.remove();
  }, [host]);

  // Before the first frame: without it the sheet has no width to slide in at.
  useLayoutEffect(() => placeHost(host, width), [host, width]);

  useLayoutEffect(() => {
    hideHost(host, !active);
    // Out of sight: the slot is the next chat's, and closes unless that chat holds a panel open.
    if (!active && slot) shutSlot(slot);
  }, [active, host, slot]);

  // Shut, it is past the window's edge: nothing in it can be reached or read.
  useEffect(() => {
    if (open) {
      showHost(host, true);
      return undefined;
    }
    const timer = window.setTimeout(() => showHost(host, false), settling ? 0 : LAND_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- how it closed, not a reason to close again
  }, [host, open]);

  const motion = useRef<Motion>({ x: 0, v: 0 });
  const to = open ? width : 0;
  const snap = dragging || settling;
  useLayoutEffect(() => (active && slot ? moveTo(slot, motion.current, to, snap) : undefined), [active, slot, snap, to]);

  useEffect(() => onHost?.(sheet), [onHost, sheet]);

  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width };
    document.documentElement.dataset.sideResize = "";
    setDragging(true);
  };
  const up = () => {
    start.current = null;
    delete document.documentElement.dataset.sideResize;
    setDragging(false);
  };
  return createPortal(
    <>
      <div className="ds-side-inner">
        <div className="ds-side-space" />
        <div ref={setSheet} className="ds-side-sheet" data-side-panel inert={!open}>
          {children}
        </div>
      </div>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Resize the panel"
        className="ds-side-resize"
        onPointerDown={down}
        onPointerMove={(event) => {
          if (start.current) resize(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(start.current.width - (event.clientX - start.current.x)))));
        }}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={() => resize(DEFAULT_WIDTH)}
      />
    </>,
    host,
  );
}
