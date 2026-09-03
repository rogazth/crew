import { useCallback, useEffect, useRef, useState } from "react";
import { ProviderIcon } from "../chrome/ProviderIcon";
import { useThread } from "../hooks/useThread";
import { answer, respond, send, stop } from "../lib/agentRuntime";
import { pickFiles, writeTempFile } from "../lib/api";
import { attachedFrom } from "../lib/attachments";
import { useFileDrop } from "../hooks/useFileDrop";
import type { Answers, ApprovalDecision, AttachedFile } from "../lib/blocks";
import { providerLine, type ProviderId } from "../lib/providers";
import type { Session } from "../lib/types";
import { Composer } from "./chat/Composer";
import { Transcript } from "./chat/Transcript";

type Props = {
  session: Session;
  cwd: string;
  active: boolean;
  onModel: (session: Session, provider: ProviderId, model: string) => void;
};

export function AgentChat({ session, cwd, active, onModel }: Props) {
  const { blocks, ready, working } = useThread(session.id);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const field = useRef<HTMLTextAreaElement>(null);
  const pane = useRef<HTMLDivElement>(null);

  // Opening the tab means "talk to this agent"; the caret should already be there.
  useEffect(() => {
    if (active) field.current?.focus();
  }, [active]);

  const addPaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((file) => file.path));
      const next: AttachedFile[] = [];
      for (const path of paths) {
        if (seen.has(path)) continue;
        seen.add(path);
        next.push(attachedFrom(path));
      }
      return [...prev, ...next];
    });
    field.current?.focus();
  }, []);

  const attach = useCallback(async () => addPaths(await pickFiles()), [addPaths]);

  // A pasted screenshot has no path; it gets one in the temp dir, like the terminal does.
  const pasteFiles = useCallback(
    (pasted: File[]) => {
      void Promise.all(pasted.map((file) => writeTempFile(file).catch(() => null))).then((paths) =>
        addPaths(paths.filter((path): path is string => path !== null)),
      );
    },
    [addPaths],
  );

  const over = useFileDrop(pane, addPaths);

  const submit = useCallback(() => {
    const text = draft.trim();
    if ((!text && files.length === 0) || working || !ready) return;
    const attached = files;
    setDraft("");
    setFiles([]);
    void send(session, cwd, text, attached);
  }, [cwd, draft, files, ready, session, working]);

  const approve = useCallback(
    (requestId: number, decision: ApprovalDecision) => respond(session, requestId, decision),
    [session],
  );
  const reply = useCallback(
    (requestId: number, answers: Answers | null) => answer(session, requestId, answers),
    [session],
  );

  return (
    <div ref={pane} className="relative flex h-full flex-col bg-canvas">
      {over && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-canvas/70">
          <span className="crew-ink rounded-full px-3 py-1 text-[12px] font-medium">Drop files to attach</span>
        </div>
      )}
      {blocks.length === 0 ? (
        <Identity session={session} />
      ) : (
        <Transcript blocks={blocks} working={working} onApprove={approve} onAnswer={reply} />
      )}
      <Composer
        ref={field}
        session={session}
        draft={draft}
        files={files}
        working={working}
        ready={ready}
        onDraft={setDraft}
        onModel={(provider, model) => onModel(session, provider, model)}
        onAttach={() => void attach()}
        onPasteFiles={pasteFiles}
        onRemoveFile={(path) => setFiles((prev) => prev.filter((file) => file.path !== path))}
        onSend={submit}
        onStop={() => void stop(session)}
      />
    </div>
  );
}

/** The composer is the call to action; this is the session card, top-left, at chrome weight. */
function Identity({ session }: { session: Session }) {
  return (
    <div data-selectable className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[720px] flex-col items-start px-6 pt-5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-card">
            <ProviderIcon provider={session.provider} className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="crew-prose font-medium">{session.name}</span>
            <span className="text-[12px] leading-4 text-text-muted">
              {providerLine(session.provider, session.model)}
            </span>
          </div>
        </div>
        {session.description && (
          <p className="mt-2 line-clamp-2 max-w-[480px] text-[12px] leading-4 text-text-muted">
            {session.description}
          </p>
        )}
      </div>
    </div>
  );
}
