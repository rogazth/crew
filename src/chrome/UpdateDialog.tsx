import { Button, Dialog, Loader, Meter } from "@cloudflare/kumo";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { updateHost } from "../lib/host";
import type { UpdateState } from "../lib/update";
import { Kbd } from "./Kbd";

/** Follows the updater in main; a window opened mid-update picks up where it is. */
function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({ phase: "idle" });
  useEffect(() => {
    const host = updateHost();
    if (!host) return;
    let heard = false;
    const unlisten = host.onState((next) => {
      heard = true;
      setState(next);
    });
    void host.current().then((next) => {
      if (!heard) setState(next);
    });
    return () => {
      heard = true;
      unlisten();
    };
  }, []);
  return state;
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

const keycap = "border-white/20 bg-white/10 text-white/80";
const ENTER = <Kbd keys="⏎" className={keycap} />;

/** `commit` runs on ⌘⏎, for an action that should not fire on a stray Enter. */
type View = { title: string; body?: ReactNode; actions?: ReactNode; commit?: () => void };

function view(state: UpdateState, host: NonNullable<ReturnType<typeof updateHost>>): View | null {
  const dismiss = () => void host.dismiss();
  const ok = (
    <Button variant="primary" size="sm" autoFocus onClick={dismiss}>
      OK {ENTER}
    </Button>
  );
  const working = (label: string) => (
    <div className="flex items-center gap-2 text-kumo-subtle">
      <Loader size="sm" />
      {label}
    </div>
  );
  switch (state.phase) {
    case "idle":
      return null;
    case "checking":
      return { title: "Checking for updates", body: working("Asking GitHub for the latest release…") };
    case "latest":
      return { title: `Crew ${state.version} is the latest version`, actions: ok };
    case "unpackaged":
      return {
        title: "Updates apply to the installed app",
        body: "This window runs from the checkout, so there is nothing to replace.",
        actions: ok,
      };
    case "available": {
      const install = () => void host.install();
      return {
        title: `Crew ${state.version} is available`,
        body: `You are on ${state.current}. Crew will replace itself and reopen.`,
        actions: (
          <>
            <Button variant="secondary" size="sm" onClick={dismiss}>
              Later <Kbd keys="Esc" />
            </Button>
            <Button variant="primary" size="sm" onClick={install}>
              Update and Restart <Kbd keys="⌘⏎" className={keycap} />
            </Button>
          </>
        ),
        commit: install,
      };
    }
    case "downloading": {
      const { received, total } = state;
      return {
        title: `Downloading Crew ${state.version}`,
        body:
          total === null ? (
            working(megabytes(received))
          ) : (
            <Meter
              label="Downloaded"
              value={Math.min(100, (received / total) * 100)}
              customValue={`${megabytes(received)} of ${megabytes(total)}`}
            />
          ),
        actions: (
          <Button variant="secondary" size="sm" onClick={() => void host.cancel()}>
            Cancel <Kbd keys="Esc" />
          </Button>
        ),
      };
    }
    case "installing":
      return { title: `Installing Crew ${state.version}`, body: working("Unpacking the new version…") };
    case "restarting":
      return { title: `Restarting into Crew ${state.version}`, body: working("Closing sessions and reopening…") };
    case "error":
      return { title: "Could not update Crew", body: state.message, actions: ok };
  }
}

/**
 * The updater's prompts and progress, inside the window instead of a system
 * sheet. Escape answers the secondary button; once the download is done the
 * swap cannot be stopped, so the dialog holds until Crew restarts.
 */
export function UpdateDialog() {
  const state = useUpdateState();
  const host = updateHost();
  const shown = host ? view(state, host) : null;
  return (
    <Dialog.Root
      role="alertdialog"
      open={shown !== null}
      onOpenChange={(open) => {
        if (open || !host) return;
        if (state.phase === "downloading") void host.cancel();
        else if (state.phase !== "checking" && state.phase !== "installing" && state.phase !== "restarting") {
          void host.dismiss();
        }
      }}
    >
      {shown && (
        // Centred like ConfirmDialog; the sm: override is needed or kumo's breakpoint wins.
        // Without buttons the popup itself holds focus, and its ring is noise there.
        <Dialog size="sm" className="top-1/2 sm:top-1/2 -translate-y-1/2 p-5 outline-none">
          <div
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
              if (!shown.commit || event.key !== "Enter" || !event.metaKey) return;
              event.preventDefault();
              shown.commit();
            }}
          >
            <Dialog.Title className="text-base font-semibold">{shown.title}</Dialog.Title>
            {shown.body && (
              <Dialog.Description render={<div />} className="mt-2 break-words text-kumo-subtle">
                {shown.body}
              </Dialog.Description>
            )}
            {shown.actions && <div className="mt-5 flex justify-end gap-2">{shown.actions}</div>}
          </div>
        </Dialog>
      )}
    </Dialog.Root>
  );
}
