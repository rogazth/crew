import type { FormEvent, KeyboardEvent } from "react";
import { Plus, Send, Square } from "../../chrome/icons";
import type { AttachedFile } from "../../lib/blocks";
import { FileChips } from "./Bubble";

type Props = {
  name: string;
  draft: string;
  files: AttachedFile[];
  working: boolean;
  ready: boolean;
  onDraft: (value: string) => void;
  onAttach: () => void;
  onRemoveFile: (path: string) => void;
  onSend: () => void;
  onStop: () => void;
};

/** Cursor composer: tall field, plus + send on the bottom row. */
export function Composer({
  name,
  draft,
  files,
  working,
  ready,
  onDraft,
  onAttach,
  onRemoveFile,
  onSend,
  onStop,
}: Props) {
  const canSend = ready && (draft.trim().length > 0 || files.length > 0) && !working;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (working) onStop();
    else if (canSend) onSend();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (working) onStop();
    else if (canSend) onSend();
  };

  return (
    <div className="shrink-0 px-4 pb-4">
      <form onSubmit={submit} className="crew-composer mx-auto max-w-3xl">
        {files.length > 0 && (
          <div className="mb-2">
            <FileChips files={files} onRemove={onRemoveFile} />
          </div>
        )}
        <textarea
          rows={3}
          value={draft}
          placeholder={`Message ${name}`}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={onKeyDown}
          className="crew-composer-field"
        />
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            aria-label="Attach files"
            onClick={onAttach}
            className="crew-composer-attach flex items-center justify-center"
          >
            <Plus className="size-4" />
          </button>
          <button
            type="submit"
            disabled={!working && !canSend}
            aria-label={working ? "Stop" : "Send"}
            className="crew-ink flex size-[30px] shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-20"
          >
            {working ? <Square className="size-3" /> : <Send className="size-3.5" />}
          </button>
        </div>
      </form>
    </div>
  );
}
