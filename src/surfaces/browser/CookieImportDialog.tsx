import { useRef, useState } from "react";
import { Alert, Button, Footer } from "../../chrome/kit";
import { browserCookiesRead } from "../../lib/api";
import { cookieSourceLabel, importSummary } from "../../lib/browser/cookies";
import { browserHost } from "../../lib/host";
import type { CookieSource } from "../../lib/protocol";

type Step = { kind: "ask" } | { kind: "busy" } | { kind: "done"; summary: string } | { kind: "failed"; error: string };

type Props = {
  source: CookieSource | null;
  workspaceId: string;
  onClose: () => void;
  /** Cookies landed: the page can load again, signed in. */
  onImported: () => void;
};

/**
 * Asks before reading another browser's cookies, then says what came over.
 * Enter confirms, Escape cancels; neither while macOS is asking for the keychain.
 */
export function CookieImportDialog({ source, workspaceId, onClose, onImported }: Props) {
  const action = useRef<HTMLButtonElement>(null);
  // Held against the source it belongs to: the next one starts at the question.
  const [run, setRun] = useState<{ of: CookieSource; step: Step } | null>(null);
  const step: Step = run && run.of === source ? run.step : { kind: "ask" };
  const busy = step.kind === "busy";

  const dismiss = () => {
    if (!busy) onClose();
  };

  const go = async () => {
    const host = browserHost();
    if (!source || !host || busy) return;
    if (step.kind === "done") return onClose();
    setRun({ of: source, step: { kind: "busy" } });
    try {
      const read = await browserCookiesRead(source.id);
      const written = await host.importCookies(workspaceId, read.cookies);
      setRun({ of: source, step: { kind: "done", summary: importSummary(written.imported, read.skipped + written.failed) } });
      if (written.imported > 0) onImported();
    } catch (error) {
      setRun({ of: source, step: { kind: "failed", error: error instanceof Error ? error.message : String(error) } });
    }
    // The busy button let go of focus; Enter answers the dialog again.
    requestAnimationFrame(() => action.current?.focus());
  };

  const label = source ? cookieSourceLabel(source) : "";
  const description =
    step.kind === "done"
      ? step.summary
      : `Pages in this workspace open signed in wherever ${label} is. Other workspaces keep their own cookies. macOS asks to let Crew read ${source?.browser ?? "the browser"}'s keychain entry.`;

  return (
    <Alert
      open={source !== null}
      onDismiss={dismiss}
      title={step.kind === "done" ? `Cookies imported from ${label}` : `Import cookies from ${label}?`}
      description={description}
      error={step.kind === "failed" ? step.error : null}
      initialFocus={action}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void go();
      }}
    >
      <Footer hints={[["esc", step.kind === "done" ? "close" : "cancel"]]}>
        {step.kind !== "done" && (
          <Button variant="ghost" className="text-[12px]" disabled={busy} onClick={dismiss}>
            Cancel
          </Button>
        )}
        <Button ref={action} variant="primary" keys="⏎" loading={busy} className="text-[12px]" onClick={() => void go()}>
          {step.kind === "done" ? "Done" : "Import"}
        </Button>
      </Footer>
    </Alert>
  );
}
