import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

type Props = {
  open: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
  children: ReactNode;
};

/**
 * The sidebar's box: a fixed width the edge drags, and nothing at all while it
 * is hidden, so the main area takes the whole window. The panel inside keeps
 * its own layout; this only owns size and the handle.
 */
export function SidebarShell({ open, width, minWidth, maxWidth, onResize, children }: Props) {
  const start = useRef<{ x: number; width: number } | null>(null);

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!start.current) return;
    const next = start.current.width + event.clientX - start.current.x;
    onResize(Math.min(maxWidth, Math.max(minWidth, Math.round(next))));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    start.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  if (!open) return null;
  return (
    <aside
      data-sidebar="sidebar"
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col bg-sidebar"
    >
      {children}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Resize sidebar"
        data-sidebar="resize-handle"
        data-tauri-drag-region="false"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => onResize(300)}
        className="absolute inset-y-0 -right-1.5 z-20 w-3 after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent after:transition-colors hover:after:bg-border-strong active:after:bg-border-strong"
      />
    </aside>
  );
}

/**
 * Two views in one place, the inactive one slid out and inert, so settings
 * can come in over the sessions without either losing its state.
 */
export function SlidingViews({
  active,
  className = "",
  views,
}: {
  active: string;
  className?: string;
  views: { key: string; node: ReactNode }[];
}) {
  const index = Math.max(0, views.findIndex((view) => view.key === active));
  return (
    <div className={`relative min-h-0 flex-1 overflow-hidden ${className}`}>
      {views.map((view, at) => (
        <div
          key={view.key}
          inert={at !== index}
          aria-hidden={at !== index}
          style={{ transform: `translateX(${(at - index) * 100}%)` }}
          className="absolute inset-0 flex flex-col transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
        >
          {view.node}
        </div>
      ))}
    </div>
  );
}
