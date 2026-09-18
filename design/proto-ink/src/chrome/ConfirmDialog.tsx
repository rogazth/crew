import { useApp } from "@/lib/store";
import { Button, Dialog, Kbd } from "@/ui";

export function ConfirmDialog() {
  const { confirm, actions } = useApp();
  const spec = confirm;

  return (
    <Dialog open={spec !== null} onOpenChange={(next) => !next && actions.confirm(null)} width={400}>
      {spec && (
        <div
          className="flex flex-col gap-4 p-4"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              spec.onConfirm();
              actions.confirm(null);
            }
          }}
        >
          <div className="flex flex-col gap-1.5">
            <h2 className="text-body font-[var(--weight-medium)] text-primary">{spec.title}</h2>
            {spec.description && <p className="text-small text-tertiary">{spec.description}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => actions.confirm(null)} trailing={<Kbd className="ml-1">Esc</Kbd>}>
              Cancel
            </Button>
            <Button
              autoFocus
              tone={spec.destructive ? "danger" : "primary"}
              onClick={() => {
                spec.onConfirm();
                actions.confirm(null);
              }}
            >
              {spec.confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
