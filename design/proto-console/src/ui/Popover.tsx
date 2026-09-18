import clsx from "clsx";
import type { ReactNode } from "react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useEscape, useFloating, useOnClickOutside, type Align, type AnchorPoint, type Side } from "@/lib/hooks";

export type PopoverProps = {
  open: boolean;
  anchor: HTMLElement | AnchorPoint | null;
  onClose: () => void;
  side?: Side;
  align?: Align;
  gap?: number;
  matchWidth?: boolean;
  className?: string;
  role?: string;
  label?: string;
  children: ReactNode;
};

/**
 * The only floating layer in the app. Everything that floats — menu, palette,
 * picker, tooltip — is this box: a 1px ring and one soft shadow, never a glow.
 */
export function Popover({
  open,
  anchor,
  onClose,
  side = "bottom",
  align = "start",
  gap = 4,
  matchWidth,
  className,
  role = "dialog",
  label,
  children,
}: PopoverProps) {
  const anchorRef = useRef<HTMLElement | null>(anchor instanceof HTMLElement ? anchor : null);
  anchorRef.current = anchor instanceof HTMLElement ? anchor : null;
  const { ref, style } = useFloating(anchor, open, { side, align, gap, ...(matchWidth ? { matchWidth } : {}) });

  useOnClickOutside([ref, anchorRef], onClose, open);
  useEscape(onClose, open);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      style={{ ...style, animation: "slide-up var(--fast) var(--ease) both" }}
      className={clsx("float z-50 overflow-auto scroll", className)}
    >
      {children}
    </div>,
    document.body,
  );
}
