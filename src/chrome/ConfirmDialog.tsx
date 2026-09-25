import { useRef } from "react";
import { Alert, Button, Footer } from "./kit";

export type Confirm = {
  title: string;
  description: string;
  action: string;
  onConfirm: () => void | Promise<void>;
};

type Props = { confirm: Confirm | null; onClose: () => void };

/** Destructive confirmation: Enter runs the action, Escape cancels. */
export function ConfirmDialog({ confirm, onClose }: Props) {
  const action = useRef<HTMLButtonElement>(null);
  const run = () => {
    if (!confirm) return;
    void confirm.onConfirm();
    onClose();
  };

  return (
    <Alert
      open={confirm !== null}
      onDismiss={onClose}
      title={confirm?.title ?? ""}
      description={confirm?.description}
      // Cancel comes first in the row, but focus starts on the button Enter presses.
      initialFocus={action}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        run();
      }}
    >
      <Footer hints={[["esc", "cancel"]]}>
        <Button variant="ghost" className="text-[12px]" onClick={onClose}>
          Cancel
        </Button>
        <Button ref={action} variant="danger" keys="⏎" className="text-[12px]" onClick={run}>
          {confirm?.action}
        </Button>
      </Footer>
    </Alert>
  );
}
