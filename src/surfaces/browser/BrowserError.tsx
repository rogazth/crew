import { Button } from "../../chrome/kit";
import { describeLoadError, type LoadError } from "../../lib/browser/loadError";

type Props =
  | { kind: "load"; error: LoadError; onRetry: () => void }
  | { kind: "crash"; onRetry: () => void }
  | { kind: "hung"; onRetry: () => void; onWait: () => void };

/** Covers the guest when the page failed to load, its process died, or it stopped answering. */
export function BrowserError(props: Props) {
  const { title, detail } =
    props.kind === "crash"
      ? { title: "This page stopped.", detail: "Its process ended unexpectedly." }
      : props.kind === "hung"
        ? { title: "This page isn't responding.", detail: "It may come back on its own. Reloading ends whatever it's stuck on." }
        : describeLoadError(props.error.code);
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
      <p className="font-medium text-text">{title}</p>
      <p className="max-w-sm text-text-muted">{detail}</p>
      {props.kind === "load" && (
        <p className="max-w-md truncate font-mono text-[12px] text-placeholder" title={props.error.url}>
          {props.error.url}
        </p>
      )}
      <div className="flex items-center gap-2">
        {props.kind === "hung" && (
          <Button variant="ghost" onClick={props.onWait}>
            Wait
          </Button>
        )}
        <Button variant="secondary" onClick={props.onRetry}>
          {props.kind === "load" ? "Try again" : "Reload"}
        </Button>
      </div>
    </div>
  );
}
