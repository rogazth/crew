import { useState } from "react";
import { Plus, Send } from "../chrome/icons";
import { ProviderIcon } from "../chrome/ProviderIcon";
import { providerLine } from "../lib/providers";
import type { Session } from "../lib/types";

type Props = { session: Session };

export function AgentChat({ session }: Props) {
  const [draft, setDraft] = useState("");
  const canSend = draft.trim().length > 0;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <div data-selectable className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex h-full max-w-3xl flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl border border-border bg-sidebar">
            <ProviderIcon provider={session.provider} className="size-6" />
          </div>
          <div>
            <p className="font-medium">{session.name}</p>
            <p className="mt-0.5 text-text-muted">
              {providerLine(session.provider, session.model)}
            </p>
          </div>
          {session.description && (
            <p className="max-w-md text-text-muted">{session.description}</p>
          )}
        </div>
      </div>

      <div className="shrink-0 px-4 pb-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-border bg-canvas px-2 py-1.5 shadow-sm transition-colors focus-within:border-border-strong">
          <button
            aria-label="Attach"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-hover"
          >
            <Plus className="size-4" />
          </button>
          <textarea
            rows={1}
            value={draft}
            placeholder={`Message ${session.name}`}
            onChange={(event) => setDraft(event.target.value)}
            className="max-h-40 min-h-8 flex-1 resize-none self-center bg-transparent py-1.5 outline-none"
          />
          <button
            disabled={!canSend}
            aria-label="Send"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-text text-white transition-opacity disabled:opacity-20"
          >
            <Send className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
