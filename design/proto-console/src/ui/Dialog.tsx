import clsx from "clsx";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscape } from "@/lib/hooks";

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  label: string;
  className?: string;
  /** Anchors the box to the top third, the way a palette wants to sit. */
  top?: boolean;
  children: ReactNode;
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, label, className, top, children }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(onClose, open);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !ref.current) return;
      const nodes = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null,
      );
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className={clsx(
        "fixed inset-0 z-40 flex justify-center px-4",
        top ? "items-start pt-[12vh]" : "items-center",
      )}
    >
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-ink opacity-20"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        style={{ animation: "slide-up var(--base) var(--ease) both" }}
        className={clsx("float relative z-10 flex max-h-[80vh] w-full flex-col", className)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function DialogHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[var(--h-tabs)] shrink-0 items-center gap-2 border-b border-rule px-3 font-mono text-xs tracking-wide text-ink-3 uppercase">
      {children}
    </div>
  );
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-rule px-3 py-2">
      {children}
    </div>
  );
}
