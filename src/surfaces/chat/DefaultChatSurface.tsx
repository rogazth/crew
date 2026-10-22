import { awaitsUser } from "../../lib/blocks";
import { ChatSessionContext } from "./context";
import { Composer } from "./Composer";
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
  optionsPending = false,
  switchProvider = false,
  overlay,
  inThread = false,
  readOnly = false,
}: ChatSurfaceProps) {
  const pickStarter = (text: string) => {
    onDraft(text);
    field.current?.focus();
  };
  return (
    <ChatSessionContext value={{ id: session.id, provider: session.provider }}>
      <div className="relative flex min-h-0 flex-1 flex-col">
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
            onApprove={onApprove}
            onAnswer={onAnswer}
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
            {...(queue ? { queue } : {})}
            {...(work ? { work } : {})}
            {...(onOptions ? { onOptions } : {})}
            optionsPending={optionsPending}
            switchProvider={switchProvider}
          />
        )}
        {blocks.length === 0 && (
          <div className="min-h-0 flex-[6] overflow-y-auto">
            {!loading && !readOnly && <IntroWays session={session} onPick={pickStarter} />}
          </div>
        )}
        {overlay}
      </div>
    </ChatSessionContext>
  );
}
