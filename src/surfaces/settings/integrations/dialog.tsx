// The page's one dialog frame: the backdrop fades in and out, the panel rises
// and drops away, and every sheet shares its header (a mark, a title, one line
// under it) and its footer.
import { XIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton, SURFACE } from "../../../chrome/kit";
import { ui, useUi } from "./lib";

export function Dialog({ label, width = "w-[460px]", children }: { label: string; width?: string; children: ReactNode }) {
  const { leaving, swapped } = useUi();
  const panel = useRef<HTMLDivElement>(null);
  // Opened from a button, focus is still on the page: take it so Escape reaches the dialog.
  useEffect(() => {
    const el = panel.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, []);
  return createPortal(
    <div role="presentation" className={`fixed inset-0 z-50 ${leaving ? "pointer-events-none" : ""}`} onMouseDown={ui.close}>
      <div
        className={`absolute inset-0 bg-(--backdrop) ${leaving ? "dialog-backdrop-out" : swapped ? "" : "dialog-backdrop"}`}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // A confirmation portalled from inside the sheet answers its own Escape.
          if (event.key !== "Escape" || !panel.current?.contains(event.target as Node)) return;
          event.stopPropagation();
          ui.close();
        }}
        className={`absolute top-[14vh] left-1/2 flex max-h-[76vh] ${width} max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col overflow-hidden outline-none ${SURFACE} ${
          leaving ? "dialog-panel-out" : swapped ? "dialog-panel-swap" : "dialog-panel"
        }`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function DialogHeader({ mark, title, subtitle }: { mark: ReactNode; title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex items-start gap-3.5 px-5 pt-5 pb-4">
      {mark}
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="truncate text-[16px] leading-6 font-semibold">{title}</h2>
        {subtitle && <p className="truncate text-[13px] text-text-muted">{subtitle}</p>}
      </div>
      <IconButton icon={XIcon} label="Close" className="-mt-1 -mr-1 size-7" onClick={ui.close} />
    </div>
  );
}

/** What sits between the header and the footer when it can outgrow the sheet: it scrolls, they stay. */
export function DialogBody({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

/** A labelled card of rows, the body's one building block. */
export function DialogGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 pb-5">
      {title && <p className="px-1 text-[13px] text-text-muted">{title}</p>}
      <div className="rounded-xl bg-card px-3">{children}</div>
    </div>
  );
}

/** One row in a group: what it is on the left, its control on the right. */
export function DialogRow({ icon, title, subtitle, children }: { icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-3 border-t border-hairline py-2 first:border-t-0">
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{title}</span>
        {subtitle && <span className="text-[12px] text-text-muted">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

export function DialogFooter({ start, children }: { start?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-t border-hairline px-4">
      {start}
      <span className="flex-1" />
      {children}
    </div>
  );
}
