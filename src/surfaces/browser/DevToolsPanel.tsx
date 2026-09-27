import { XIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { DockBounds, DockSnapshot } from "../../lib/browser/bridge";
import { DEVTOOLS_MIN, type DevToolsDock } from "../../lib/browserPrefs";
import { commandKeys } from "../../lib/commands";
import { browserHost } from "../../lib/host";

type Side = Exclude<DevToolsDock, "window">;

type Props = {
  /** The page whose DevTools this holds. */
  guestId: number;
  dock: Side;
  /** Width beside the page, height below it. */
  size: number;
  visible: boolean;
  onResize: (size: number) => void;
  /** Main refused to dock them; the pane goes back to no DevTools. */
  onFailed: () => void;
  onClose: () => void;
};

/** The line between page and panel, on the panel's inner side. */
const BORDER: Record<Side, string> = { right: "border-l", left: "border-r", bottom: "border-t" };

/**
 * A strip on the page's side of that line, wider than it to be easy to catch.
 * The view covers the panel itself, so the strip can't reach into it.
 */
const EDGE: Record<Side, string> = {
  right: "right-full inset-y-0 w-2 justify-end",
  left: "left-full inset-y-0 w-2 justify-start",
  bottom: "bottom-full inset-x-0 h-2 flex-col justify-end",
};

/** What floats over the window's layout: menus, popovers, dialogs, tooltips, and whatever is portaled out of the root. */
const FLOATING =
  '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [role="tooltip"], body > :not(#root) *';

/** Whether anything floating is drawn over `area`. */
function covered(area: DockBounds, panel: HTMLElement): boolean {
  for (const element of document.querySelectorAll(FLOATING)) {
    if (panel.contains(element)) continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (
      box.left < area.x + area.width &&
      box.right > area.x &&
      box.top < area.y + area.height &&
      box.bottom > area.y
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A page's DevTools docked beside or below it, like Chromium's. The frontend
 * is a view main lays over this panel; it sits above everything the window
 * draws, so while a menu or dialog overlaps the panel, or its edge is being
 * dragged, the view is hidden and a still of it shows here instead. The pane
 * moves the panel to another side with CSS alone, which keeps the frontend.
 */
export function DevToolsPanel({ guestId, dock, size, visible, onResize, onFailed, onClose }: Props) {
  const outer = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const start = useRef<{ at: number; size: number; max: number } | null>(null);
  // The size under the pointer; the pane is told once the drag ends.
  const [dragged, setDragged] = useState<number | null>(null);
  const [still, setStill] = useState<DockSnapshot | null>(null);
  const dragging = dragged !== null;
  const latest = useRef({ visible, dragging, onFailed });
  useEffect(() => {
    latest.current = { visible, dragging, onFailed };
  });
  const cursor = dock === "bottom" ? "cursor-ns-resize" : "cursor-ew-resize";
  // Asks for the view to be placed again on the next frame.
  const sync = useRef(() => {});

  useEffect(() => {
    const element = panel.current;
    const bridge = browserHost();
    if (!element || !bridge) return;
    let cancelled = false;
    let docked = false;
    let frame = 0;
    // What main was last told, so an unchanged layout sends nothing.
    let sent = "";
    // One at a time and in order: a show must never land before the hide it follows.
    let queue: Promise<void> = Promise.resolve();

    const bounds = (): DockBounds => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const place = () => {
      frame = 0;
      if (cancelled || !docked) return;
      const area = bounds();
      const { visible: shown, dragging: held } = latest.current;
      const hide = !shown || held || area.width === 0 || area.height === 0 || covered(area, element);
      const key = hide ? "hidden" : `${area.x},${area.y},${area.width},${area.height}`;
      if (key === sent) return;
      sent = key;
      queue = queue.then(() =>
        bridge
          .placeDevTools(guestId, hide ? null : area)
          .then((shot) => {
            if (cancelled) return;
            if (!hide) setStill(null);
            else if (shot) setStill(shot);
          })
          .catch(() => {}),
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    sync.current = schedule;

    void bridge
      .dockDevTools(guestId, bounds())
      .catch(() => false)
      .then((ok) => {
        if (cancelled) return;
        if (!ok) {
          latest.current.onFailed();
          return;
        }
        docked = true;
        schedule();
      });

    const resized = new ResizeObserver(schedule);
    resized.observe(element);
    const row = outer.current?.parentElement;
    if (row) resized.observe(row);
    // A menu or dialog opening, or moving into place.
    const floated = new MutationObserver(schedule);
    floated.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "data-open"],
    });
    window.addEventListener("resize", schedule);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      resized.disconnect();
      floated.disconnect();
      window.removeEventListener("resize", schedule);
      sync.current = () => {};
      void bridge.closeDevTools(guestId).catch(() => {});
    };
  }, [guestId]);

  useEffect(() => sync.current(), [visible, dragging, dock, size]);

  const horizontal = dock !== "bottom";
  const along = (event: ReactPointerEvent) => (horizontal ? event.clientX : event.clientY);

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = outer.current;
    if (event.button !== 0 || !box?.parentElement) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const row = box.parentElement;
    const room = horizontal ? row.clientWidth : row.clientHeight;
    const current = horizontal ? box.offsetWidth : box.offsetHeight;
    // The drag starts with the first move, so a plain click on the header hides nothing.
    start.current = { at: along(event), size: current, max: Math.max(DEVTOOLS_MIN, room - DEVTOOLS_MIN) };
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from) return;
    // The page sits before a panel on the right or bottom, so dragging toward it grows the panel.
    const delta = dock === "left" ? along(event) - from.at : from.at - along(event);
    setDragged(Math.round(Math.min(from.max, Math.max(DEVTOOLS_MIN, from.size + delta))));
  };

  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    start.current = null;
    if (dragged !== null) onResize(dragged);
    setDragged(null);
  };

  const shown = dragged ?? size;
  // Never more than leaves the page its minimum, never less than the panel's own.
  const style = horizontal
    ? { width: shown, maxWidth: `calc(100% - ${DEVTOOLS_MIN}px)`, minWidth: `min(${DEVTOOLS_MIN}px, 50%)` }
    : { height: shown, maxHeight: `calc(100% - ${DEVTOOLS_MIN}px)`, minHeight: `min(${DEVTOOLS_MIN}px, 50%)` };

  return (
    <div
      ref={outer}
      data-devtools={dock}
      className={`relative flex shrink-0 flex-col border-border bg-canvas ${BORDER[dock]}`}
      style={style}
    >
      {/* Electron opens a webview's DevTools as if in a window of their own, so their frontend draws no
          close button. The header holds one, and resizes the panel when dragged, like its edge. */}
      <div
        data-devtools-header
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className={`flex h-7 shrink-0 items-center justify-end border-b border-border px-1 ${cursor}`}
      >
        <button
          type="button"
          aria-label="Close Developer Tools"
          title={`Close Developer Tools (${commandKeys("browser-devtools")})`}
          // Not a drag: a header holding the pointer would take the click.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
          className="flex size-5 cursor-default items-center justify-center rounded-md text-icon transition-colors hover:bg-hover hover:text-text"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div ref={panel} data-devtools-view className="relative min-h-0 flex-1 overflow-hidden">
        {still && (
          <img
            src={still.url}
            alt=""
            draggable={false}
            className="pointer-events-none absolute top-0 left-0 max-w-none select-none"
            style={{ width: still.width, height: still.height }}
          />
        )}
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-label="Resize Developer Tools"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className={`group absolute z-10 flex ${EDGE[dock]} ${cursor}`}
      >
        <span
          className={`bg-border-strong opacity-0 transition-opacity group-hover:opacity-100 ${
            horizontal ? "w-0.5" : "h-0.5"
          } ${dragging ? "opacity-100" : ""}`}
        />
      </div>
      {/* The page under the pointer would swallow the drag; this keeps it with the edge. */}
      {dragging && <div className={`fixed inset-0 z-50 ${cursor}`} />}
    </div>
  );
}
