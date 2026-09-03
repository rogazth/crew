import { useCallback, useEffect, useRef, useState } from "react";
import { ProviderIcon } from "../chrome/ProviderIcon";
import { useTranscript } from "../hooks/useTranscript";
import { pickFiles } from "../lib/api";
import {
  applyEvent,
  newBlock,
  settleStreaming,
  type ApprovalDecision,
  type AttachedFile,
  type HarnessEvent,
} from "../lib/blocks";
import {
  bindClaudeSession,
  cancelTurn,
  respondApproval,
  sendTurn,
} from "../lib/claudeTurn";
import { providerLine } from "../lib/providers";
import type { Session, SessionStatus } from "../lib/types";
import { Composer } from "./chat/Composer";
import { Transcript } from "./chat/Transcript";

type Props = {
  session: Session;
  cwd: string;
  onStatus: (id: string, status: SessionStatus) => void;
  onBindProvider: (id: string, providerSessionId: string) => void;
};

export function AgentChat({ session, cwd, onStatus, onBindProvider }: Props) {
  const { blocks, setBlocks, ready } = useTranscript(session.id);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const busy = useRef(false);
  const working = session.status === "working" || session.status === "needs-input";

  useEffect(() => {
    if (session.providerSessionId) {
      bindClaudeSession(session.id, session.providerSessionId, cwd);
    }
  }, [session.id, session.providerSessionId, cwd]);

  const handleEvent = useCallback(
    (event: HarnessEvent) => {
      if (event.type === "session.providerBound") {
        onBindProvider(session.id, event.providerSessionId);
        return;
      }
      if (event.type === "approval.requested") onStatus(session.id, "needs-input");
      if (event.type === "approval.resolved") onStatus(session.id, "working");
      if (event.type === "session.error") onStatus(session.id, "error");
      setBlocks((prev) => applyEvent(prev, event));
    },
    [onBindProvider, onStatus, session.id, setBlocks],
  );

  const attach = useCallback(async () => {
    const picked = await pickFiles();
    if (picked.length === 0) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((file) => file.path));
      const next = picked
        .filter((path) => !seen.has(path))
        .map((path) => ({ path, name: path.split("/").pop() ?? path }));
      return [...prev, ...next];
    });
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && files.length === 0) || busy.current || !ready) return;
    const attached = files;
    busy.current = true;
    setDraft("");
    setFiles([]);
    const user = newBlock("user", text);
    setBlocks((prev) => [
      ...prev,
      attached.length > 0 ? { ...user, files: attached } : user,
    ]);
    onStatus(session.id, "working");
    let failed = false;
    try {
      await sendTurn({
        sessionId: session.id,
        cwd,
        model: session.model,
        name: session.name,
        description: session.description,
        ...(session.providerSessionId ? { resume: session.providerSessionId } : {}),
        text,
        ...(attached.length > 0 ? { files: attached.map((file) => file.path) } : {}),
        onEvent: (event) => {
          if (event.type === "session.error") failed = true;
          handleEvent(event);
        },
      });
      onStatus(session.id, failed ? "error" : "idle");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBlocks((prev) => applyEvent(prev, { type: "session.error", message }));
      onStatus(session.id, "error");
    } finally {
      busy.current = false;
    }
  }, [cwd, draft, files, handleEvent, onStatus, ready, session, setBlocks]);

  const stop = useCallback(async () => {
    await cancelTurn(session.id);
    setBlocks((prev) => [...settleStreaming(prev), newBlock("system", "Stopped")]);
    onStatus(session.id, "idle");
    busy.current = false;
  }, [onStatus, session.id, setBlocks]);

  const approve = useCallback((requestId: number, decision: ApprovalDecision) => {
    respondApproval(session.id, requestId, decision);
  }, [session.id]);

  return (
    <div className="flex h-full flex-col bg-canvas">
      {blocks.length === 0 ? (
        <Identity session={session} />
      ) : (
        <Transcript blocks={blocks} onApprove={approve} />
      )}
      <Composer
        name={session.name}
        draft={draft}
        files={files}
        working={working}
        ready={ready}
        onDraft={setDraft}
        onAttach={() => void attach()}
        onRemoveFile={(path) => setFiles((prev) => prev.filter((file) => file.path !== path))}
        onSend={() => void send()}
        onStop={() => void stop()}
      />
    </div>
  );
}

function Identity({ session }: { session: Session }) {
  return (
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
  );
}
