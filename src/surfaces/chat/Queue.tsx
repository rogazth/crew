import { useContext } from "react";
import { splitAgentNote } from "../../lib/agentMentions";
import { Trash2Icon } from "lucide-react";
import type { Block } from "../../lib/blocks";
import { isSteering } from "../../lib/letters";
import type { QueuedMessage } from "../../lib/queue";
import { AttachmentStrip } from "./Attachments";
import { QueueContext } from "./context";

/** The user's queue, and what can be done with each message. */
export type QueueScope = {
  items: QueuedMessage[];
  onDispose: (id: string) => void;
};

/**
 * One of the user's messages at the transcript's foot. While it waits, the
 * pointer over it offers to drop it. A steer offers nothing: the running turn
 * has already taken it.
 */
export function QueuedBubble({ block }: { block: Block }) {
  const queue = useContext(QueueContext);
  // The note naming the agents it mentions is for the agent; the bubble shows what you wrote.
  const body = splitAgentNote(block.text ?? "").body;
  const id = block.letterId;
  const waits = queue?.items.some((message) => message.id === id && !message.steering);
  return (
    <div {...(isSteering(block) ? {} : { "data-queued-bubble": "" })} className="flex flex-col items-end gap-1.5 self-stretch">
      {/* Stretched to the row, as a sent bubble's is: shrunk to its content, the bubble's 78% would be of its own width and wrap short. */}
      <div className="crew-md-row is-user">
        {body ? (
          <div className="crew-bubble opacity-60" data-bubble>
            <p data-queued-text className="whitespace-pre-wrap">{body}</p>
          </div>
        ) : null}
        {queue && id && waits && (
          <span className="ds-queued-actions">
            <button
              type="button"
              title="Delete"
              aria-label="Delete"
              onClick={() => queue.onDispose(id)}
              className="grid size-6 place-items-center rounded-md text-text-muted hover:bg-selected hover:text-text"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </span>
        )}
      </div>
      {block.files && block.files.length > 0 ? (
        <div className="opacity-60">
          <AttachmentStrip tiles files={block.files} />
        </div>
      ) : null}
    </div>
  );
}
