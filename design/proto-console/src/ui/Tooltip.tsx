import { cloneElement, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Popover } from "./Popover";
import type { Side } from "@/lib/hooks";

export type TooltipProps = {
  content: ReactNode;
  side?: Side;
  delay?: number;
  children: ReactElement<{
    ref?: React.Ref<HTMLElement>;
    onPointerEnter?: (event: React.PointerEvent) => void;
    onPointerLeave?: (event: React.PointerEvent) => void;
    onFocus?: (event: React.FocusEvent) => void;
    onBlur?: (event: React.FocusEvent) => void;
  }>;
};

export function Tooltip({ content, side = "bottom", delay = 420, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement | null>(null);
  const timer = useRef<number>(0);

  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <>
      {cloneElement(children, {
        ref: (node: HTMLElement | null) => {
          ref.current = node;
        },
        onPointerEnter: show,
        onPointerLeave: hide,
        onFocus: show,
        onBlur: hide,
      })}
      <Popover
        open={open}
        anchor={ref.current}
        onClose={hide}
        side={side}
        align="center"
        gap={6}
        role="tooltip"
        className="pointer-events-none max-w-[280px] px-2 py-1 font-mono text-xs text-ink-2"
      >
        {content}
      </Popover>
    </>
  );
}
