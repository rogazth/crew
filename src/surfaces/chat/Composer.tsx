import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import { ModelPicker } from "../../chrome/ModelPicker";
import { Plus, Send, Square } from "../../chrome/icons";
import type { AttachedFile } from "../../lib/blocks";
import type { ProviderId } from "../../lib/providers";
import type { Session } from "../../lib/types";
import { AttachmentStrip } from "./Attachments";

type Props = {
  ref?: Ref<HTMLTextAreaElement>;
  session: Session;
  draft: string;
  files: AttachedFile[];
  working: boolean;
  ready: boolean;
  onDraft: (value: string) => void;
  onModel: (provider: ProviderId, model: string) => void;
  onAttach: () => void;
  /** Files pasted from the clipboard (screenshots); they have no path yet. */
  onPasteFiles: (files: File[]) => void;
  onRemoveFile: (path: string) => void;
  onSend: () => void;
  onStop: () => void;
};

const MAX_FIELD_PX = 160;

/** A control well in the chrome's dialect: hairline, radius 12, plus and model left, send right. */
export function Composer({
  ref,
  session,
  draft,
  files,
  working,
  ready,
  onDraft,
  onModel,
  onAttach,
  onPasteFiles,
  onRemoveFile,
  onSend,
  onStop,
}: Props) {
  const field = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => field.current as HTMLTextAreaElement);
  const canSend = ready && (draft.trim().length > 0 || files.length > 0) && !working;

  // Grows with the draft up to the cap; the browser's own sizing is one line.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD_PX)}px`;
  }, [draft]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (working) onStop();
    else if (canSend) onSend();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    onPasteFiles(files);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (working) onStop();
    else if (canSend) onSend();
  };

  return (
    <div className="shrink-0 px-6 pb-4">
      <form onSubmit={submit} className="crew-composer mx-auto max-w-[720px]">
        {files.length > 0 && (
          <div className="mb-2">
            <AttachmentStrip files={files} onRemove={onRemoveFile} />
          </div>
        )}
        <textarea
          ref={field}
          rows={2}
          value={draft}
          placeholder={`Message ${session.name}`}
          spellCheck={false}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="crew-composer-field"
        />
        <div className="mt-2 flex h-7 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-0.5">
            <button
              type="button"
              aria-label="Attach files"
              title="Attach files"
              onClick={onAttach}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-kumo-subtle transition-colors duration-100 hover:bg-hover hover:text-text focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50 focus-visible:outline-none active:bg-selected"
            >
              <Plus className="size-4" />
            </button>
            <ModelPicker
              trigger="chip"
              provider={session.provider}
              model={session.model}
              disabled={working}
              onChange={onModel}
            />
          </div>
          <button
            type="submit"
            disabled={!working && !canSend}
            aria-label={working ? "Stop" : "Send"}
            className={`flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-100 focus-visible:ring-[1.5px] focus-visible:ring-kumo-focus/50 focus-visible:outline-none ${
              working || canSend
                ? "crew-ink hover:bg-kumo-brand-hover"
                : "bg-card text-kumo-subtle"
            }`}
          >
            {working ? <Square className="size-2.5" /> : <Send className="ml-px size-3.5" />}
          </button>
        </div>
      </form>
    </div>
  );
}
