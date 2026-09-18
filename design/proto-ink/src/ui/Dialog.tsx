import { Dialog as Base } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  width?: number;
  /** A right-hand drawer instead of a centred card. */
  side?: "center" | "right";
};

export function Dialog({ open, onOpenChange, children, className, width = 420, side = "center" }: DialogProps) {
  return (
    <Base.Root open={open} onOpenChange={(next: boolean) => onOpenChange(next)}>
      <Base.Portal>
        <Base.Backdrop className="ink-backdrop fixed inset-0 z-[70]" />
        {side === "center" ? (
          <Base.Popup
            className={cx(
              "ink-pop e3 fixed left-1/2 top-1/2 z-[71] -translate-x-1/2 -translate-y-1/2",
              "rounded-card bg-canvas outline-none",
              className,
            )}
            style={{ width }}
          >
            {children}
          </Base.Popup>
        ) : (
          <Base.Popup
            className={cx(
              "ink-sheet e3 fixed inset-y-0 right-0 z-[71] flex flex-col bg-canvas outline-none",
              "rounded-l-card",
              className,
            )}
            style={{ width }}
          >
            {children}
          </Base.Popup>
        )}
      </Base.Portal>
    </Base.Root>
  );
}

export const DialogPrimitive = Base;
