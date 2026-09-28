import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { clampSide, type Viewport } from "../../lib/browser/viewport";

type Edge = "right" | "bottom" | "corner";

const CURSOR: Record<Edge, string> = { right: "ew-resize", bottom: "ns-resize", corner: "nwse-resize" };

type Props = {
  viewport: Viewport;
  onChange: (viewport: Viewport) => void;
};

/**
 * The edges of the fixed-size page, dragged to resize it like Chromium's device
 * mode. A box the page's size laid over it, since the guest's own element can't
 * take children or a new parent.
 */
export function ViewportHandles({ viewport, onChange }: Props) {
  const start = useRef<{ x: number; y: number; viewport: Viewport; scale: number } | null>(null);
  const [dragging, setDragging] = useState<Edge | null>(null);

  const down = (edge: Edge) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // A centered page grows on both sides, so the edge only keeps up with the pointer at twice the pace.
    const frame = event.currentTarget.parentElement!;
    const port = frame.parentElement!;
    const centered = frame.offsetLeft > parseFloat(getComputedStyle(port).paddingLeft) + 0.5;
    start.current = { x: event.clientX, y: event.clientY, viewport, scale: centered ? 2 : 1 };
    setDragging(edge);
  };

  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const from = start.current;
    if (!from || !dragging) return;
    const width = dragging === "bottom" ? from.viewport.width : from.viewport.width + (event.clientX - from.x) * from.scale;
    const height = dragging === "right" ? from.viewport.height : from.viewport.height + event.clientY - from.y;
    onChange({ width: clampSide(width, from.viewport.width), height: clampSide(height, from.viewport.height) });
  };

  const up = (event: ReactPointerEvent<HTMLButtonElement>) => {
    start.current = null;
    setDragging(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handle = (edge: Edge, label: string, className: string, grip: string) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      onPointerDown={down(edge)}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      style={{ cursor: CURSOR[edge] }}
      className={`group pointer-events-auto absolute flex items-center justify-center transition-colors hover:bg-hover ${
        dragging === edge ? "bg-hover" : ""
      } ${className}`}
    >
      <span className={`rounded-full bg-border-strong transition-colors group-hover:bg-icon ${grip}`} />
    </button>
  );

  return (
    <div
      className="pointer-events-none relative self-start justify-self-center [grid-area:1/1]"
      style={{ width: viewport.width, height: viewport.height }}
    >
      {handle("right", "Resize width", "top-0 -right-4 h-full w-4", "h-8 w-1")}
      {handle("bottom", "Resize height", "-bottom-4 left-0 h-4 w-full", "h-1 w-8")}
      {handle("corner", "Resize", "-right-4 -bottom-4 size-4", "size-1.5")}
      {/* The page under the pointer would swallow the drag; this keeps it with the handle. */}
      {dragging && <div className="pointer-events-auto fixed inset-0 z-50" style={{ cursor: CURSOR[dragging] }} />}
    </div>
  );
}
