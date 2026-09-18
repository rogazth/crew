import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { cx } from "@/lib/cx";

export function Modal({
  open,
  onOpenChange,
  children,
  width = 440,
  className,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  width?: number;
  className?: string;
  label?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="enter-fade fixed inset-0 z-[80] bg-scrim backdrop-blur-[2px]" />
        <Dialog.Popup
          aria-label={label}
          style={{ width }}
          className={cx(
            "enter-pop fixed left-1/2 top-[18%] z-[81] max-w-[calc(100vw-32px)] -translate-x-1/2",
            "rounded-panel bg-overlay el-4 outline-none",
            className,
          )}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const DialogTitle = Dialog.Title;
export const DialogDescription = Dialog.Description;
