import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { updateHost } from "../lib/host";
import type { UpdateState } from "../lib/update";
import { Alert, Button, Footer } from "./kit";

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

/** `commit` runs on ⌘⏎, for an action that should not fire on a stray Enter. */
type View = {
  title: string;
  body?: ReactNode;
  hints?: [string, string][];
  actions?: ReactNode;
  commit?: () => void;
};

function Working({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
      {label}
    </div>
  );
}

function Progress({ received, total }: { received: number; total: number }) {
  const percent = Math.min(100, (received / total) * 100);
  const text = `${megabytes(received)} of ${megabytes(total)}`;
  return (
    <div className="flex flex-col gap-1.5 text-[12px]">
      <div className="flex justify-between gap-4">
        <span>Downloaded</span>
        <span className="tabular-nums">{text}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Downloaded"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-valuetext={text}
        className="h-1.5 overflow-hidden rounded-full bg-selected"
      >
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function view(state: UpdateState, host: NonNullable<ReturnType<typeof updateHost>>): View | null {
  const dismiss = () => void host.dismiss();
  const ok = (
    <Button variant="primary" keys="⏎" className="text-[12px]" onClick={dismiss}>
      OK
    </Button>
  );
  switch (state.phase) {
    case "idle":
      return null;
    case "checking":
      return { title: "Checking for updates", body: <Working label="Asking GitHub for the latest release…" /> };
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
        hints: [["esc", "later"]],
        actions: (
          <>
            <Button variant="ghost" className="text-[12px]" onClick={dismiss}>
              Later
            </Button>
            <Button variant="primary" keys="⌘⏎" className="text-[12px]" onClick={install}>
              Update and Restart
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
            <Working label={megabytes(received)} />
          ) : (
            <Progress received={received} total={total} />
          ),
        hints: [["esc", "cancel"]],
        actions: (
          <Button variant="ghost" className="text-[12px]" onClick={() => void host.cancel()}>
            Cancel
          </Button>
        ),
      };
    }
    case "installing":
      return { title: `Installing Crew ${state.version}`, body: <Working label="Unpacking the new version…" /> };
    case "restarting":
      return { title: `Restarting into Crew ${state.version}`, body: <Working label="Closing sessions and reopening…" /> };
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
    <Alert
      open={shown !== null}
      onDismiss={() => {
        if (!host) return;
        if (state.phase === "downloading") void host.cancel();
        else if (state.phase !== "checking" && state.phase !== "installing" && state.phase !== "restarting") {
          void host.dismiss();
        }
      }}
      title={shown?.title ?? ""}
      description={shown?.body}
      onKeyDown={(event) => {
        if (!shown?.commit || event.key !== "Enter" || !event.metaKey) return;
        event.preventDefault();
        shown.commit();
      }}
    >
      {shown?.actions && <Footer hints={shown.hints ?? []}>{shown.actions}</Footer>}
    </Alert>
  );
}
