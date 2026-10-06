import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showLetter, useChatLetters, usePending } from "../hooks/useLetters";
import { useThread } from "../hooks/useThread";
import { answer, respond, send, stop } from "../lib/turnRuntime";
import { pickFiles, setSessionOptions, writeTempFile } from "../lib/api";
import { attachedFrom } from "../lib/attachments";
import { queuedLetters } from "../lib/letters";
import { mentionedFiles } from "../lib/mentions";
import { LetterContext, useChatActions } from "./chat/context";
import { useFileDrop } from "../hooks/useFileDrop";
import type { Answers, ApprovalDecision, AttachedFile } from "../lib/blocks";
import type { Session } from "../lib/types";
import { ChatBar } from "./chat/ChatBar";
import { DefaultChatSurface } from "./chat/DefaultChatSurface";
import { Thread } from "./chat/Thread";

type Props = {
  session: Session;
  /** Every session, for its children, and for whoever its letters name. */
  sessions: readonly Session[];
  cwd: string;
  active: boolean;
};

export function TurnChat({ session, sessions, cwd, active }: Props) {
  const { blocks: held, ready, working, more, loadingEarlier, loadEarlier, focusId } = useThread(session.id);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const field = useRef<HTMLTextAreaElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const { files: projectFiles, openSession } = useChatActions();
  const letters = useChatLetters(session, sessions, held);
  // What waits in its box for the next turn, under the turn that is running.
  const pending = usePending(session.id, true);
  const blocks = useMemo(() => [...held, ...queuedLetters(pending, held)], [held, pending]);

  // Opening the tab means "talk to this session"; the caret should already be there.
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
    const mentions = mentionedFiles(text, projectFiles).map((file) => file.path);
    setDraft("");
    setFiles([]);
    void send(session, cwd, text, attached, mentions.length > 0 ? { mentions } : {});
  }, [cwd, draft, files, projectFiles, ready, session, working]);

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
      <LetterContext value={letters.scope}>
        <DefaultChatSurface
          session={session}
          blocks={blocks}
          working={working}
          ready={ready}
          active={active}
          more={more}
          loadingEarlier={loadingEarlier}
          onLoadEarlier={loadEarlier}
          focusId={focusId}
          draft={draft}
          files={files}
          over={over}
          field={field}
          onDraft={setDraft}
          onSend={submit}
          onStop={() => void stop(session)}
          onAttach={() => void attach()}
          onPasteFiles={pasteFiles}
          onRemoveFile={(path) => setFiles((prev) => prev.filter((file) => file.path !== path))}
          onApprove={approve}
          onAnswer={reply}
          // Each turn starts its CLI from the row: the next one runs what the chips say.
          onOptions={(next) =>
            void setSessionOptions(session.id, { model: next.model, effort: next.effort, autonomy: next.access }).catch(() => {})
          }
          bar={
            <ChatBar
              session={session}
              sessions={sessions}
              kids={letters.kids}
              pairs={letters.pairs}
              onOpenSession={openSession}
              onOpenThread={letters.openThread}
            />
          }
          overlay={
            letters.thread && (
              <Thread
                key={`${letters.thread.a.id}|${letters.thread.b.id}|${letters.thread.focus ?? ""}`}
                thread={letters.thread}
                owner={letters.owner}
                sessionId={session.id}
                sessions={sessions}
                active={active}
                inChat={letters.inChat}
                onClose={letters.closeThread}
                onShowInChat={(letterId) => {
                  letters.closeThread();
                  showLetter(pane.current, letterId);
                }}
              />
            )
          }
        />
      </LetterContext>
    </div>
  );
}
