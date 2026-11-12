import { Button } from "../../chrome/kit";
import { GitBranchIcon, ImagesIcon, InfoIcon, KeyRoundIcon } from "lucide-react";
import { ProviderIcon } from "../../chrome/ProviderIcon";
import { BotAvatar } from "../../chrome/BotAvatar";
import { lazy, memo, Suspense, useState, type ReactNode } from "react";
import { FileRef } from "../../chrome/FileRef";
import type { BotRef, Block } from "../../lib/blocks";
import { agentRuns, splitAgentNote, type AgentRef } from "../../lib/agentMentions";
import { looksLikePath, splitMentions } from "../../lib/mentions";
import { attachedFrom, imageMime } from "../../lib/attachments";
import { AttachmentStrip, Lightbox } from "./Attachments";
import { isAuthFailure, loginArgv } from "../../lib/auth";
import { LOCAL, envOfSession } from "../../lib/client/registry";
import { providerOf } from "../../lib/providers";
import { Beat } from "./Beat";
import { useChatActions, useChatSession, type ChatSession } from "./context";
import { CopyButton } from "./CopyButton";
import { clock } from "../../lib/time";

/** streamdown and its parsers are half a megabyte; the window opens without them. */
const Markdown = lazy(() => import("./Markdown").then((m) => ({ default: m.Markdown })));

/**
 * What the user said sits on the right, in ink; the agent answers on the left
 * in grey. Attachments are their own row under the bubble: a picture inside it
 * would set the bubble's width, not the words.
 *
 * A turn a bot sent is still `role=user`, but it is not you: it reads
 * as an event in the run, like the row the sender sees for having written it,
 * so the bubbles stay the conversation you are actually in.
 */
export const UserMessage = memo(function UserMessage({ block }: { block: Block }) {
  if (block.fromBot) return <Letter block={block} from={block.fromBot} />;
  // One still queued is drawn with the rest of the queue, under one label (`QueuedGroup`).
  // The note naming the agents it mentions is for the agent; the bubble shows what you wrote.
  const { body, agents } = splitAgentNote(block.text ?? "");
  return (
    <div className="flex flex-col items-end gap-1.5">
      {body ? (
        <div className="crew-md-row is-user">
          <div className="crew-bubble" data-bubble>
            <p className="whitespace-pre-wrap">
              <MentionText text={body} agents={agents} />
            </p>
          </div>
          <MessageActions text={body} at={block.at} side="end" className="crew-copy-aside" />
        </div>
      ) : null}
      {block.files && block.files.length > 0 ? (
        <div className="flex justify-end">
          <AttachmentStrip tiles files={block.files} />
        </div>
      ) : null}
    </div>
  );
});

/**
 * A letter with no thread behind it: an old one, or one sent from the command
 * line. A beat like the rest, its words in a dialog.
 */
function Letter({ block, from }: { block: Block; from: BotRef }) {
  const you = from.kind === "user";
  return (
    <Beat
      id={block.id}
      first={you ? "you" : { id: from.id, name: from.name, bot: from.kind === undefined }}
      verb={you ? "sent this from the command line" : "wrote to you"}
      peek={{
        title: you ? "From the command line" : `Message from ${from.name}`,
        text: block.text,
        ...(block.files?.length ? { extra: <AttachmentStrip files={block.files} /> } : {}),
      }}
    />
  );
}

/**
 * `@name` runs of the agents and worktrees the message's note names become pills that open that session
 * or that folder (`#name` too, as messages from before wrote them). `@path` runs that read as paths become
 * pills that open the file, an image in the viewer. The rest is the text as typed.
 */
function MentionText({ text, agents }: { text: string; agents: AgentRef[] }) {
  const { openPath, openFolder, resolvePath, openSession, files } = useChatActions();
  const [image, setImage] = useState<string | null>(null);
  const open = (path: string) => {
    if (path.endsWith("/")) return openFolder(path);
    if (imageMime(path)) return setImage(resolvePath(path) ?? path);
    openPath(path);
  };
  const paths = { has: (token: string) => looksLikePath(token, files) };
  const parts: ReactNode[] = [];
  const plain = (from: number, to: number) => {
    for (const [index, segment] of splitMentions(text.slice(from, to), paths).entries())
      parts.push(
        segment.kind === "mention" ? (
          <FileRef key={`${from}:${index}`} path={segment.path} onOpen={open} />
        ) : (
          <span key={`${from}:${index}`}>{segment.text}</span>
        ),
      );
  };
  let at = 0;
  for (const run of agentRuns(text, agents, "@#")) {
    if (run.from > at) plain(at, run.from);
    const { agent } = run;
    parts.push(
      <button
        key={run.from}
        type="button"
        onClick={() => (agent.kind === "worktree" ? openFolder(agent.id) : openSession(agent.id))}
        title={`${agent.kind} ${agent.id}`}
        className="crew-file-ref"
        data-agent-ref={agent.id}
      >
        {agent.kind === "worktree" ? (
          <GitBranchIcon className="size-3 self-center" aria-hidden />
        ) : agent.kind === "bot" ? (
          <BotAvatar seed={agent.id} bare className="size-3.5 self-center" />
        ) : (
          <ProviderIcon provider={agent.provider} className="size-3 self-center" />
        )}
        <span className="crew-file-ref-name">{agent.name}</span>
      </button>,
    );
    at = run.to;
  }
  if (at < text.length) plain(at, text.length);
  return (
    <>
      {parts}
      {image && <Lightbox images={[attachedFrom(image)]} index={0} onIndex={() => {}} onClose={() => setImage(null)} />}
    </>
  );
}

export const AssistantMessage = memo(function AssistantMessage({ block }: { block: Block }) {
  return (
    <Suspense
      fallback={
        <div className="crew-md">
          <div className="crew-md-prose whitespace-pre-wrap">{block.text}</div>
        </div>
      }
    >
      <Markdown text={block.text} {...(block.streaming ? { streaming: true } : {})} />
    </Suspense>
  );
});

/**
 * Files the agent sent you (Claude Code's `SendUserFile`): its caption as a
 * quiet line, then the files. A reply's room, not a step's: it is what the
 * agent wanted you to see.
 */
export const SharedFiles = memo(function SharedFiles({ block }: { block: Block }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="flex items-start gap-2 text-[13px] leading-[19px] text-text-muted">
        <ImagesIcon className="mt-0.5 size-3.5 shrink-0 text-icon" />
        <span className="whitespace-pre-wrap">{block.tool?.title ?? block.text}</span>
      </p>
      {block.files && block.files.length > 0 ? <AttachmentStrip files={block.files} /> : null}
    </div>
  );
});

/** Something the session itself said: a quiet line with a mark, not a message. */
export const Note = memo(function Note({ block }: { block: Block }) {
  return (
    <p className="flex items-start gap-2 text-[13px] leading-[19px] text-text-muted">
      <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-icon" />
      {block.text}
    </p>
  );
});

/**
 * A turn that stopped because the CLI is signed out: nothing ran, and the
 * session waits on a login. A card, not a quiet line, so it reads as the
 * thing to do next. The CLI's own sentence stays on the card, for the hover.
 */
export const AuthNote = memo(function AuthNote({ block, session }: { block: Block; session: ChatSession }) {
  const { openLogin } = useChatActions();
  const remote = envOfSession(session.id) !== LOCAL;
  const command = loginArgv(session.provider, remote);
  const label = providerOf(session.provider)?.label ?? session.provider;
  return (
    <div className="crew-card" data-auth-card>
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning">
          <KeyRoundIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1" title={block.text}>
          <p className="truncate font-medium">{label} is signed out</p>
          <p className="truncate text-[12px] leading-4 text-text-muted">Sign in and send your message again to continue.</p>
        </div>
        {command && (
          <Button variant="primary" className="h-7 shrink-0 px-2.5" onClick={() => openLogin(session.id, session.provider, command)}>
            Sign in
          </Button>
        )}
      </div>
    </div>
  );
});

/** A system line. An auth failure asks for a login, until one has happened; anything else is the note it already was. */
export function SystemLine({ block, signedIn = false }: { block: Block; signedIn?: boolean }) {
  const session = useChatSession();
  if (session && isAuthFailure(block.text)) return signedIn ? null : <AuthNote block={block} session={session} />;
  return <Note block={block} />;
}

/** A day turning over: a hairline with the day on it, as chat apps mark one. The time of each message waits on its hover. */
export const DateBreak = memo(function DateBreak({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-3 text-[11px] leading-4 font-medium text-text-muted">
      <span className="h-px flex-1 bg-hairline" />
      {label}
      <span className="h-px flex-1 bg-hairline" />
    </p>
  );
});

/**
 * Closes a turn: how long it took, when. Memoised because every footer above
 * the live turn would otherwise rebuild on each streamed token.
 */
export const TurnFooter = memo(function TurnFooter({ at, text }: { at?: number; text?: string }) {
  if (at === undefined && !text) return null;
  // The reply's actions, as ChatGPT sets them under an answer: copy, then when it was said.
  return <MessageActions text={text?.trim()} at={at} side="start" className="-ml-1" />;
});

/**
 * A message's copy button and the time it was said: the same pair beside your
 * bubble and under the agent's answer, read from the side the message sits on.
 */
function MessageActions({
  text,
  at,
  side,
  className,
}: {
  text?: string | undefined;
  at?: number | undefined;
  /** `end`: right of the chat, the time before the button; `start`: the button first. */
  side: "start" | "end";
  className?: string;
}) {
  const copy = text ? <CopyButton text={text} className="crew-copy" /> : null;
  const time = at !== undefined ? <span className="cursor-default text-[11.5px] leading-4 text-text-muted tabular-nums">{clock(at)}</span> : null;
  return (
    <span className={`flex items-center gap-2${className ? ` ${className}` : ""}`}>
      {side === "end" ? time : copy}
      {side === "end" ? copy : time}
    </span>
  );
}
