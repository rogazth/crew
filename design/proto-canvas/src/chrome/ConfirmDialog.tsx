import { useStore } from "@/lib/store";
import { Button } from "@/ui/Button";
import { Modal, DialogDescription, DialogTitle } from "@/ui/Dialog";
import { Kbd } from "@/ui/Kbd";

export function ConfirmDialog() {
  const { confirmRequest, setConfirmRequest } = useStore();
  const open = confirmRequest !== null;

  return (
    <Modal open={open} onOpenChange={(next) => !next && setConfirmRequest(null)} width={420}>
      {confirmRequest && (
        <div className="p-5">
          <DialogTitle className="text-md font-semibold text-ink">{confirmRequest.title}</DialogTitle>
          <DialogDescription className="mt-1.5 text-base text-ink-52">
            {confirmRequest.description}
          </DialogDescription>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmRequest(null)} trailing={<Kbd>Esc</Kbd>}>
              Cancel
            </Button>
            <Button
              autoFocus
              variant={confirmRequest.destructive ? "danger" : "primary"}
              onClick={() => {
                confirmRequest.onConfirm();
                setConfirmRequest(null);
              }}
            >
              {confirmRequest.actionLabel}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
