import { Toast } from "@base-ui/react/toast";
import {
  BellIcon,
  CheckIcon,
  CircleAlertIcon,
  MailIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  SquareTerminalIcon,
  WifiIcon,
  XIcon,
  type LucideIcon as Icon,
} from "lucide-react";
import type { NotificationSource } from "../lib/notifications";
import type { NotificationTarget } from "../lib/notify";
import { toastManager, type ToastData } from "../lib/toasts";
import { SURFACE } from "./kit";

const ICONS: Record<NotificationSource, Icon> = {
  "needs-input": MessageCircleQuestionIcon,
  approval: ShieldQuestionIcon,
  done: CheckIcon,
  error: CircleAlertIcon,
  process: SquareTerminalIcon,
  mailbox: MailIcon,
  bell: BellIcon,
  connection: WifiIcon,
  test: BellIcon,
};

/**
 * News of another session while Crew is in front: a stack in the bottom right
 * corner, newest in front, that fans out on hover. Open goes to the session.
 */
export function Toaster({ onOpen }: { onOpen: (target: NotificationTarget) => void }) {
  return (
    <Toast.Provider toastManager={toastManager} limit={3}>
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-50 w-[340px] max-w-[calc(100vw-32px)] outline-none">
          <Toasts onOpen={onOpen} />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function Toasts({ onOpen }: { onOpen: (target: NotificationTarget) => void }) {
  const { toasts, close } = Toast.useToastManager<ToastData>();
  return toasts.map((toast) => {
    const source = toast.data?.source ?? "test";
    const target = toast.data?.target ?? null;
    const Glyph = ICONS[source];
    return (
      <Toast.Root
        key={toast.id}
        toast={toast}
        className={`${SURFACE} absolute right-0 bottom-0 w-full origin-bottom select-none [--gap:0.5rem] [--peek:0.5rem] [--scale:calc(max(0,1-(var(--toast-index)*0.05)))] [--shrink:calc(1-var(--scale))] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] z-[calc(1000-var(--toast-index))] h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_0.4s_cubic-bezier(0.22,1,0.36,1),opacity_0.3s,height_0.15s] after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-[''] data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))] data-limited:opacity-0 data-starting-style:[transform:translateY(150%)] data-ending-style:opacity-0 [&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)] data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))] data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))] motion-reduce:transition-none`}
      >
        <Toast.Content className="flex items-start gap-3 overflow-hidden p-3 transition-opacity duration-200 data-behind:opacity-0 data-expanded:opacity-100">
          <Glyph
            aria-hidden
            className={`mt-0.5 size-4 shrink-0 ${source === "error" || source === "process" ? "text-danger" : "text-icon"}`}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Toast.Title className="truncate font-medium" />
            <Toast.Description className="line-clamp-2 text-[12px] text-text-muted" />
          </div>
          {target && (
            <Toast.Action
              className="inline-flex h-7 shrink-0 items-center rounded-md bg-card px-2.5 text-[12px] font-medium text-text ring-1 ring-hairline outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
              onClick={() => {
                close(toast.id);
                onOpen(target);
              }}
            >
              Open
            </Toast.Action>
          )}
          <Toast.Close
            aria-label="Dismiss"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50"
          >
            <XIcon className="size-3.5" />
          </Toast.Close>
        </Toast.Content>
      </Toast.Root>
    );
  });
}
