import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import type { ChatSurfaceProps } from "./surface";

export function DefaultChatSurface({
  session,
  blocks,
  working,
  ready,
  draft,
  files,
  over,
  field,
  onDraft,
  onSend,
  onStop,
  onAttach,
  onPasteFiles,
  onRemoveFile,
  onModel,
  onApprove,
  onAnswer,
}: ChatSurfaceProps) {
  return (
    <>
      {over && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-canvas/70">
          <span className="crew-ink rounded-full px-3 py-1 text-[12px] font-medium">
            Drop files to attach
          </span>
        </div>
      )}
      {blocks.length === 0 ? (
        <div className="min-h-0 flex-[5]" />
      ) : (
        <Transcript blocks={blocks} working={working} onApprove={onApprove} onAnswer={onAnswer} />
      )}
      <Composer
        centered={blocks.length === 0}
        ref={field}
        session={session}
        draft={draft}
        files={files}
        working={working}
        ready={ready}
        onDraft={onDraft}
        onModel={onModel}
        onAttach={onAttach}
        onPasteFiles={onPasteFiles}
        onRemoveFile={onRemoveFile}
        onSend={onSend}
        onStop={onStop}
      />
      {blocks.length === 0 && <div className="min-h-0 flex-[6]" />}
    </>
  );
}
