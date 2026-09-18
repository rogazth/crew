import { useEffect } from "react";
import { Button, Dialog, DialogFooter, Kbd } from "@/ui";
import { store, useApp } from "@/lib/store";

export function ConfirmDialog() {
  const state = useApp();
  const open = state.overlay?.kind === "confirm";
  const confirm = state.overlay?.kind === "confirm" ? state.overlay.confirm : null;
  const close = () => store.closeOverlay();

  useEffect(() => {
    if (!confirm) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      store.closeOverlay();
      confirm.onConfirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirm]);

  return (
    <Dialog open={open} onClose={close} label={confirm?.title ?? "Confirm"} className="max-w-[420px]">
      <div className="flex flex-col gap-2 px-4 py-4">
        <h2 className="text-lg text-ink">{confirm?.title}</h2>
        {confirm?.description ? <p className="text-md text-ink-3">{confirm.description}</p> : null}
      </div>
      <DialogFooter>
        <Button onClick={close} kbd={<Kbd>Esc</Kbd>}>
          Cancel
        </Button>
        <Button
          variant={confirm?.destructive ? "danger" : "primary"}
          onClick={() => {
            close();
            confirm?.onConfirm();
          }}
          kbd={<Kbd>⏎</Kbd>}
        >
          {confirm?.action ?? "Confirm"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
