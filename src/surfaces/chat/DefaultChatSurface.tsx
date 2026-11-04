import { useMemo, useRef, useState } from "react";
import { awaitsUser } from "../../lib/blocks";
import { ChatFind } from "./ChatFind";
import { ChatSessionContext, QueueContext } from "./context";
import { Composer } from "./Composer";
import { PausedRow } from "./ComposerParts";
import { IntroHead, IntroWays } from "./SessionIntro";
import { Transcript } from "./Transcript";
import type { ChatSurfaceProps } from "./surface";

export function DefaultChatSurface({
  session,
  blocks,
  working,
  active,
  more,
  loadingEarlier,
  onLoadEarlier,
  focusId,
  ready,
  draft,
  files,
  over,
  field,
  onDraft,
  onSend,
  onStop,
  whileWorking,
  queue,
  work,
  onAttach,
  onPasteFiles,
  onRemoveFile,
  uploads,
  onDismissUpload,
  onApprove,
  onAnswer,
  loading = false,
  onOptions,
  switchProvider = false,
  overlay,
  inThread = false,
  agents,
  readOnly = false,
  finding = null,
  onCloseFind,
}: ChatSurfaceProps) {
  const surface = useRef<HTMLDivElement>(null);
  // The row the find left the reader on keeps its mark, but closing the bar
  // must not light it as if a hit had just sent them there.
  const [left, setLeft] = useState<string | null>(null);
  const [wasFinding, setWasFinding] = useState(finding !== null);
  if ((finding !== null) !== wasFinding) {
    setWasFinding(finding !== null);
    if (finding === null) setLeft(focusId);
  }
  const quiet = finding !== null || (focusId !== null && focusId === left);
  const pickStarter = (text: string) => {
    onDraft(text);
    field.current?.focus();
  };
  const chatSession = useMemo(
    () => ({ id: session.id, provider: session.provider }),
    [session.id, session.provider],
  );
  return (
    <ChatSessionContext value={chatSession}>
      <QueueContext value={queue ?? null}>
      <div ref={surface} data-quiet-found={quiet || undefined} className="relative flex min-h-0 flex-1 flex-col">
        {over && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-canvas/70">
            <span className="crew-ink rounded-full px-3 py-1 text-[12px] font-medium">
              Drop files to attach
            </span>
          </div>
        )}
        {blocks.length === 0 ? (
          <div className="flex min-h-0 flex-[4] flex-col items-center justify-end overflow-hidden">
            {!loading && <IntroHead session={session} />}
          </div>
        ) : (
          <Transcript
            blocks={blocks}
            working={working}
            active={active}
            more={more}
            loadingEarlier={loadingEarlier}
            onLoadEarlier={onLoadEarlier}
            focusId={focusId}
            placeFocus={finding === null}
            onApprove={onApprove}
            onAnswer={onAnswer}
            foot={session.paused ? <PausedRow sessionId={session.id} /> : null}
          />
        )}
        {!readOnly && (
          <Composer
            escBack={inThread}
            centered={blocks.length === 0}
            ref={field}
            session={session}
            draft={draft}
            files={files}
            working={working}
            ready={ready}
            waiting={blocks.some(awaitsUser)}
            onDraft={onDraft}
            onAttach={onAttach}
            onPasteFiles={onPasteFiles}
            onRemoveFile={onRemoveFile}
            uploads={uploads}
            onDismissUpload={onDismissUpload}
            onSend={onSend}
            onStop={onStop}
            {...(whileWorking ? { whileWorking } : {})}
            {...(work ? { work } : {})}
            {...(agents ? { agentsLine: agents } : {})}
            {...(onOptions ? { onOptions } : {})}
            switchProvider={switchProvider}
          />
        )}
        {blocks.length === 0 && (
          <div className="min-h-0 flex-[6] overflow-y-auto">
            {!loading && !readOnly && <IntroWays session={session} onPick={pickStarter} />}
          </div>
        )}
        {finding !== null && onCloseFind && blocks.length > 0 && (
          <ChatFind
            sessionId={session.id}
            active={active}
            token={finding}
            root={surface}
            revision={blocks.length}
            onClose={onCloseFind}
          />
        )}
        {overlay}
      </div>
      </QueueContext>
    </ChatSessionContext>
  );
}
