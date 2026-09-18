import { useMemo, useState } from "react";
import { attribution, dayLabel, providerLine, statusLabel, type AttachedFile, type Block } from "@crew/fixtures";
import { peersOf, useRoster, waitingFor } from "@/lib/agents";
import { cx } from "@/lib/cx";
import { useStore } from "@/lib/store";
import { useThread } from "@/lib/useThread";
import { Avatar, AvatarStack } from "@/ui/Avatar";
import { IconButton } from "@/ui/Button";
import { Icon } from "@/ui/Icon";
import { Tip } from "@/ui/Tooltip";
import { ChatContext } from "./context";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";

export function ChatSurface({ sessionId }: { sessionId: string }) {
  const { sessionById, sessions, updateSession, setDrawer, openSession, setPage, statusOf } = useStore();
  const { blocks, working, runtime } = useThread(sessionId);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [dragging, setDragging] = useState(false);

  const session = sessionById(sessionId);
  const name = session?.name ?? sessionId;
  const status = statusOf(sessionId);
  const origin = session ? attribution(session) : null;

  // The daemon writes the attribution as a grey note at the top of a spawned
  // agent's transcript. It is chrome, not prose: promoted to the band below and
  // dropped from the transcript so it is not said twice.
  const shown = useMemo(
    () => (origin ? blocks.filter((block: Block) => !(block.role === "system" && /^created by /i.test(block.text))) : blocks),
    [blocks, origin],
  );

  const roster = useRoster(sessions);
  const peers = useMemo(() => peersOf(roster, sessionId), [roster, sessionId]);
  const waiting = useMemo(() => waitingFor(roster, sessionId), [roster, sessionId]);

  const hotApproval = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const approval = blocks[i]!.approval;
      if (approval && !approval.decided) return approval.requestId;
    }
    return null;
  }, [blocks]);

  const hotQuestion = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const question = blocks[i]!.question;
      if (question && !question.answers && !question.dismissed) return question.requestId;
    }
    return null;
  }, [blocks]);

  const empty = shown.length === 0;

  const send = (text: string) => {
    runtime.send(text, attachments);
    setAttachments([]);
  };

  return (
    <ChatContext.Provider value={{ sessionId, sessionName: name, runtime, hotApproval, hotQuestion }}>
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const dropped = [...event.dataTransfer.files];
          setAttachments((held) => [
            ...held,
            ...(dropped.length
              ? dropped.map((file) => ({
                  name: file.name,
                  path: `/tmp/${file.name}`,
                  kind: file.type.startsWith("image/") ? ("image" as const) : ("file" as const),
                  size: file.size,
                }))
              : [{ name: "dropped.txt", path: `/tmp/dropped-${Date.now()}.txt`, kind: "file" as const, size: 2_048 }]),
          ]);
        }}
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--line-soft)] px-6">
          <Avatar seed={name} size={24} />
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="truncate text-base font-semibold text-ink">{name}</h1>
            <span className="truncate text-sm text-ink-38">
              {session ? providerLine(session.provider, session.model) : ""}
            </span>
          </div>

          <span className="flex-1" />

          {waiting.length > 0 && (
            <Tip content={`${waiting.length} ${waiting.length === 1 ? "letter is" : "letters are"} still queued for ${name}`}>
              <span className="flex h-6 shrink-0 items-center gap-1 rounded-chip bg-warn-soft px-2 text-xs font-medium text-[var(--warn)]">
                <Icon name="clock" size={11} />
                {waiting.length} waiting
              </span>
            </Tip>
          )}

          {peers.length > 0 && (
            <button
              type="button"
              onClick={() => setDrawer({ kind: "agent-thread", sessionId, peerId: peers[0]!.peer.id })}
              className="rise-1 flex h-7 items-center gap-2 rounded-chip bg-raised pl-1 pr-2.5 text-xs text-ink-52 el-1 hover:text-ink"
            >
              <AvatarStack seeds={peers.map((entry) => entry.peer.name)} size={18} />
              {peers.length} {peers.length === 1 ? "peer" : "peers"}
            </button>
          )}

          <span className="text-xs text-ink-38">{statusLabel(status)}</span>
          <IconButton icon="search" label="Search messages" size="sm" variant="ghost" onClick={() => setPage({ kind: "search", query: "" })} />
          <IconButton
            icon="settings"
            label="Edit agent"
            size="sm"
            variant="ghost"
            onClick={() => setDrawer({ kind: "agent-sheet", mode: "edit", sessionId })}
          />
        </header>

        {origin && (
          <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-[var(--line-soft)] bg-sunken px-6">
            <span className="flex shrink-0 items-center">
              <Avatar seed={origin.by.name} size={20} />
              <Icon name="arrowRight" size={12} className="mx-1 text-ink-38" />
              <Avatar seed={name} size={20} />
            </span>
            <span className="min-w-0 truncate text-sm text-ink-52">
              <button
                type="button"
                onClick={() => openSession(origin.by.id)}
                className="font-medium text-ink hover:underline"
              >
                {origin.by.name}
              </button>{" "}
              created {name} · {dayLabel(origin.at)}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setDrawer({ kind: "agent-thread", sessionId, peerId: origin.by.id })}
              className="rise-1 flex h-7 shrink-0 items-center gap-1.5 rounded-chip px-2 text-xs text-ink-52 hover:bg-raised hover:text-ink"
            >
              <Icon name="users" size={12} />
              Their thread
            </button>
          </div>
        )}

        {empty ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="rounded-full bg-raised p-1.5 el-2">
                <Avatar seed={name} size={56} />
              </span>
              <div>
                <p className="text-lg font-semibold text-ink">{name}</p>
                <p className="mx-auto mt-1 max-w-[46ch] text-base text-ink-52">
                  {session?.description || "Nothing has been said yet. Ask for something."}
                </p>
              </div>
            </div>
            {waiting.length > 0 && (
              <div className="w-full max-w-[560px] overflow-hidden rounded-card bg-raised el-1">
                <div className="flex items-center gap-2 border-b border-[var(--line-soft)] px-3.5 py-2 text-sm text-[var(--warn)]">
                  <Icon name="clock" size={13} />
                  {waiting.length} {waiting.length === 1 ? "letter is" : "letters are"} waiting in {name}&apos;s box
                </div>
                {waiting.map((letter) => (
                  <button
                    key={letter.id}
                    type="button"
                    onClick={() => setDrawer({ kind: "agent-thread", sessionId, peerId: letter.from.id })}
                    className="flex w-full items-start gap-2.5 border-b border-[var(--line-soft)] px-3.5 py-2.5 text-left last:border-b-0 hover:bg-sunken"
                  >
                    <Avatar seed={letter.from.name} size={20} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink-52">{letter.from.name}</span>
                      <span className="mt-0.5 block truncate text-base text-ink">{letter.text}</span>
                    </span>
                    <Icon name="chevronRight" size={14} className="mt-1 shrink-0 text-ink-38" />
                  </button>
                ))}
              </div>
            )}

            <div className="w-full max-w-[680px]">
              <Composer
                agentName={name}
                provider={session?.provider ?? "claude"}
                model={session?.model ?? "claude-opus-5"}
                onModel={(provider, model) => updateSession(sessionId, { provider, model })}
                working={working}
                onSend={send}
                onStop={() => runtime.stop()}
                attachments={attachments}
                onAttach={(files) => setAttachments((held) => [...held, ...files])}
                onRemoveAttachment={(path) => setAttachments((held) => held.filter((file) => file.path !== path))}
                centred
              />
            </div>
          </div>
        ) : (
          <>
            <Transcript blocks={shown} sessionId={sessionId} sessionName={name} working={working} />
            <div className="mx-auto w-full max-w-[860px]">
              <Composer
                agentName={name}
                provider={session?.provider ?? "claude"}
                model={session?.model ?? "claude-opus-5"}
                onModel={(provider, model) => updateSession(sessionId, { provider, model })}
                working={working}
                onSend={send}
                onStop={() => runtime.stop()}
                attachments={attachments}
                onAttach={(files) => setAttachments((held) => [...held, ...files])}
                onRemoveAttachment={(path) => setAttachments((held) => held.filter((file) => file.path !== path))}
              />
            </div>
          </>
        )}

        {dragging && (
          <div
            className={cx(
              "pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-panel",
              "border-2 border-dashed border-[var(--accent-line)] bg-accent-soft backdrop-blur-[1px]",
            )}
          >
            <span className="flex items-center gap-2 rounded-control bg-overlay px-3.5 py-2 text-base text-ink el-3">
              <Icon name="paperclip" size={15} />
              Drop to attach
            </span>
          </div>
        )}
      </div>
    </ChatContext.Provider>
  );
}
