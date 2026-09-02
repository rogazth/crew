import { Button, Dialog } from "@cloudflare/kumo";
import type { KeyboardEvent } from "react";
import { Kbd } from "./Kbd";

export type Confirm = {
  title: string;
  description: string;
  action: string;
  onConfirm: () => void | Promise<void>;
};

type Props = { confirm: Confirm | null; onClose: () => void };

/** Destructive confirmation: Enter runs the action, Escape cancels. */
export function ConfirmDialog({ confirm, onClose }: Props) {
  return (
    <Dialog.Root
      role="alertdialog"
      open={confirm !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      {confirm && (
        // kumo anchors dialogs to top-8/sm:top-16; a short destructive prompt reads
        // better centred, and the sm: override is needed or the breakpoint wins.
        <Dialog size="sm" className="top-1/2 sm:top-1/2 -translate-y-1/2 p-5">
          <div
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void confirm.onConfirm();
              onClose();
            }}
          >
            <Dialog.Title className="text-base font-semibold">{confirm.title}</Dialog.Title>
            <Dialog.Description className="mt-1.5 text-kumo-subtle">
              {confirm.description}
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close render={<Button variant="secondary" size="sm" />}>
                Cancel <Kbd keys="Esc" />
              </Dialog.Close>
              <Button
                variant="destructive"
                size="sm"
                autoFocus
                onClick={() => {
                  void confirm.onConfirm();
                  onClose();
                }}
              >
                {confirm.action}{" "}
                <Kbd keys="⏎" className="border-white/20 bg-white/10 text-white/80" />
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Dialog.Root>
  );
}
