import { AgentAvatar } from "../../chrome/AgentAvatar";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { isOpen } from "../../lib/blocks";
import { modelLabel, providerOf } from "../../lib/providers";
import { Composer } from "./Composer";
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
  onAttach,
  onPasteFiles,
  onRemoveFile,
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
        <div className="flex min-h-0 flex-[5] flex-col items-center justify-end">
          <Intro
            session={session}
            onPick={(text) => {
              onDraft(text);
              field.current?.focus();
            }}
          />
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
      <Composer
        centered={blocks.length === 0}
        ref={field}
        session={session}
        draft={draft}
        files={files}
        working={working}
        ready={ready}
        waiting={blocks.some(isOpen)}
        onDraft={onDraft}
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

/** Starters that fit any agent in any repo; a click drafts it, it never sends. */
const STARTERS = [
  "Summarize what this repo does and how it's laid out",
  "Find the TODOs and FIXMEs worth doing first",
  "Review the last commit for bugs",
];

/**
 * A new agent's first screen, the way ChatGPT and Grok open one: who it is,
 * what runs it, and a few ways in, above the composer.
 */
function Intro({ session, onPick }: { session: ChatSurfaceProps["session"]; onPick: (text: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col items-center gap-4 px-6 pb-6 text-center">
      <AgentAvatar seed={session.id} bare className="size-16" />
      <div className="flex flex-col items-center gap-1">
        <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.02em]">{session.name}</h2>
        <p className="flex items-center gap-1.5 text-[13px] text-text-muted">
          <ProviderIcon provider={session.provider} className="size-3.5" />
          {providerOf(session.provider)?.label} {modelLabel(session.provider, session.model)}
        </p>
        {session.description && <p className="max-w-md text-[13.5px] text-text-muted">{session.description}</p>}
      </div>
      <div className="flex flex-wrap justify-center gap-1.5 pt-1">
        {STARTERS.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="rounded-full px-3 py-1.5 text-[12.5px] text-text-muted ring-1 ring-border transition-colors hover:bg-hover hover:text-text"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
