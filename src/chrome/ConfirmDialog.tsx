import { useRef, useState } from "react";
import { Alert, Button, Footer } from "./kit";
import { settle } from "../lib/confirm";

export type Confirm = {
  title: string;
  description: string;
  action: string;
  /**
   * Awaited with the action busy; the dialog closes once it resolves. A throw
   * keeps it open with the message, and another Confirm resolved asks that
   * instead, in the same dialog.
   */
  onConfirm: () => void | Promise<void | Confirm>;
};

type Props = { confirm: Confirm | null; onAsk: (confirm: Confirm) => void; onClose: () => void };

/** Destructive confirmation: Enter runs the action, Escape cancels. Neither while it runs. */
export function ConfirmDialog({ confirm, onAsk, onClose }: Props) {
  const action = useRef<HTMLButtonElement>(null);
  // Held against the prompt it belongs to: the next one starts clean.
  const [run, setRun] = useState<{ of: Confirm; pending: boolean; error: string | null } | null>(null);
  const current = run && run.of === confirm ? run : null;
  const pending = current?.pending ?? false;

  const dismiss = () => {
    if (!pending) onClose();
  };

  const go = () => {
    if (!confirm || pending) return;
    const result = confirm.onConfirm();
    if (!(result instanceof Promise)) return onClose();
    setRun({ of: confirm, pending: true, error: null });
    void settle(result).then((settled) => {
      if (settled.kind === "done") return onClose();
      if (settled.kind === "ask") onAsk(settled.next);
      else setRun({ of: confirm, pending: false, error: settled.error });
      // The busy button let go of focus; Enter answers the prompt again.
      requestAnimationFrame(() => action.current?.focus());
    });
  };

  return (
    <Alert
      open={confirm !== null}
      onDismiss={dismiss}
      title={confirm?.title ?? ""}
      description={confirm?.description}
      error={current?.error}
      // Cancel comes first in the row, but focus starts on the button Enter presses.
      initialFocus={action}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        go();
      }}
    >
      <Footer hints={[["esc", "cancel"]]}>
        <Button variant="ghost" className="text-[12px]" disabled={pending} onClick={dismiss}>
          Cancel
        </Button>
        <Button ref={action} variant="danger" keys="⏎" loading={pending} className="text-[12px]" onClick={go}>
          {confirm?.action}
        </Button>
      </Footer>
    </Alert>
  );
}
