// The well a message is written in, for a session's composer and for the
// start screens alike: the field, its `@` and `/` menus, the list keys, the
// attachments and the plus, model and access chips. What sits around it (the
// clip, the status line) and what sending does are the caller's.
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { AccessPicker, ModelControls } from "../../chrome/ComposerControls";
import type { Opener } from "../../chrome/ModelPicker";
import { activatePrompt, promptLetter, registerPrompt, type Prompt, type PromptPickers } from "../../chrome/promptKeys";
import { useAgentIcons } from "../../hooks/useAgentIcons";
import type { Upload } from "../../hooks/useUploads";
import { completeAgentMention, nameMentionAt, searchAgents, searchTrees, type TreeMention } from "../../lib/agentMentions";
import type { AttachedFile } from "../../lib/blocks";
import { continueList, indentList, onIndentedListLine, onListLine, removeListMarker } from "../../lib/composerFormat";
import { completeMention, mentionAt, rememberMention } from "../../lib/mentions";
import type { CommandEntry } from "../../lib/protocol";
import { effortsOf, fitChoice, selectedEffort, toggledFast, type AgentChoice } from "../../lib/providers";
import { nextEffort } from "../../lib/sessionOptions";
import { completeSlash, opensMessage, removeSlash, searchCommands, slashAt } from "../../lib/slashCommands";
import type { ProjectFile, Session } from "../../lib/types";
import { AttachmentStrip } from "./Attachments";
import { AttachMenu } from "./ComposerParts";
import { AgentPicker, MentionPicker, TreePicker } from "./MentionPicker";
import { hasWorktreePicker, openWorktreePicker } from "./panePlace";
import { PromptEditor, type PromptHandle } from "./PromptEditor";
import { SlashPicker } from "./SlashPicker";
import { useMentionMenu } from "./useMentionMenu";
import { usePickerAnchor } from "./usePickerAnchor";

type Props = {
  ref?: Ref<PromptHandle>;
  draft: string;
  onDraft: (value: string) => void;
  files: AttachedFile[];
  uploads: Upload[];
  onRemoveFile: (path: string) => void;
  onDismissUpload: (id: number) => void;
  onAttach: () => void;
  /** Files pasted from the clipboard (screenshots); they have no path yet. */
  onPasteFiles: (files: File[]) => void;
  /** What `@` offers: the folder's files, and the workspace's bots, sessions and worktrees. */
  projectFiles: ProjectFile[];
  resolvePath: (path: string) => string | null;
  agents: readonly Session[];
  worktrees: readonly TreeMention[];
  /** What `/` offers. A provider's commands only open a message; Crew's actions and skills go anywhere. */
  commands: readonly CommandEntry[];
  /** A `/` has started to be typed: the caller can read its commands again. */
  onSlash?: () => void;
  /** A Crew action the well does not run itself (it runs model, effort, access and fast). */
  onAction?: (name: string) => void;
  /** The chips; absent, the well has none. */
  choice?: AgentChoice | undefined;
  onChoice?: ((next: AgentChoice) => void) | undefined;
  lockProvider?: boolean;
  /** Whether ⌥W may open the worktree picker: a session that has started cannot move. */
  movable?: boolean;
  placeholder: string;
  label: string;
  roomy?: boolean;
  canSend: boolean;
  /** ↵ or the button with something to send; `wait` is ⌘↵. */
  onSend: (wait: boolean) => void;
  /** The chips as they are, shown and not offered: a sub-agent runs what it was started with. */
  lockedChoice?: AgentChoice | undefined;
  /** The right end of the toolbar, after the access chip: the send button and what goes with it. */
  trailing: ReactNode;
  /** On the form, for what looks it up: `data-session`. */
  session?: string;
};

export function PromptWell({
  ref,
  draft,
  onDraft,
  files,
  uploads,
  onRemoveFile,
  onDismissUpload,
  onAttach,
  onPasteFiles,
  projectFiles,
  resolvePath,
  agents,
  worktrees,
  commands,
  onSlash,
  onAction,
  choice,
  onChoice,
  lockProvider = false,
  movable = true,
  placeholder,
  label,
  roomy = false,
  canSend,
  onSend,
  lockedChoice,
  trailing,
  session,
}: Props) {
  const field = useRef<PromptHandle>(null);
  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus(),
    read: () => field.current?.read() ?? { value: draft, from: draft.length, to: draft.length },
    select: (at: number) => field.current?.select(at),
    apply: (edit) => field.current?.apply(edit),
    coordsAt: (at: number) => field.current?.coordsAt(at) ?? null,
  }));

  // The caret is what decides whether an `@` is being typed; it moves without the text changing.
  const [cursor, setCursor] = useState(0);
  const [active, setActive] = useState(0);
  const { mention, indexed, results } = useMentionMenu(draft, cursor, projectFiles, resolvePath);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const known = useMemo(() => new Set([...indexed.map((file) => file.relative), ...picked]), [indexed, picked]);

  // An `@` names a bot or a session of the workspace, or a worktree of its repo; its chip wears the menu's icon.
  const agentIcons = useAgentIcons(agents);
  const chipAgents = useMemo(
    () => [
      ...agents.map((agent) => ({ name: agent.name, icon: agentIcons.get(agent.id) })),
      ...worktrees.map((tree) => ({ name: tree.name, kind: "worktree" })),
    ],
    [agents, agentIcons, worktrees],
  );
  // A name may have spaces, as a session's does: the `@` for names reads past them, where a path's stops.
  const names = useMemo(() => [...agents, ...worktrees], [agents, worktrees]);
  const named = nameMentionAt(draft, cursor, names);
  // The menu's last rows turn the `@` into a search of the files alone, or of the worktrees alone; a path being
  // typed is a file search already, and with no agents or worktrees the `@` is only for files.
  const [sub, setSub] = useState<{ at: number; kind: "files" | "trees" } | null>(null);
  const searchingFiles =
    mention !== null &&
    ((sub?.kind === "files" && sub.at === mention.start) || mention.query.includes("/") || agents.length + worktrees.length === 0);
  const fileMention = searchingFiles ? mention : null;
  const inTrees = !searchingFiles && named !== null && sub?.kind === "trees" && sub.at === named.start;
  const query = named?.query ?? "";
  const listsNames = named !== null && !searchingFiles;
  const agentResults = useMemo(
    () => (listsNames && !inTrees ? searchAgents(query, agents, query ? 5 : 6) : []),
    [listsNames, inTrees, query, agents],
  );
  // Once something is typed, a few worktrees and files that match follow the agents.
  const treeResults = useMemo(
    () => (listsNames ? searchTrees(query, worktrees, inTrees ? 8 : query ? 2 : 0) : []),
    [listsNames, inTrees, query, worktrees],
  );
  const spaced = /\s/.test(query);
  // A name with a space in it stays a mention while something answers it, so a sentence after an `@` closes it.
  const treeMention = inTrees && (!spaced || treeResults.length > 0) ? named : null;
  const agentMention = listsNames && !inTrees && (!spaced || agentResults.length + treeResults.length > 0) ? named : null;
  const fileHits = agentMention && mention?.query ? results.slice(0, 3) : [];
  const moreRows = worktrees.length > 0 ? 2 : 1;

  // The same for a `/`: a provider's commands only open a message, so the menu depends on where the slash is.
  const slash = mention || agentMention || treeMention ? null : slashAt(draft, cursor);
  const slashStarts = slash ? opensMessage(draft, slash.start) : false;
  const slashResults = useMemo(
    () => (slash ? searchCommands(commands, slash.query, slashStarts) : []),
    [slash?.query, slashStarts, commands], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const typingSlash = slash !== null;
  const onSlashNow = useRef(onSlash);
  useEffect(() => {
    onSlashNow.current = onSlash;
  });
  useEffect(() => {
    if (typingSlash) onSlashNow.current?.();
  }, [typingSlash]);
  // The agents' menu has more rows than its matches: Files, and Worktrees when the repo has any.
  const choices = fileMention
    ? results.length
    : treeMention
      ? treeResults.length
      : agentMention
        ? agentResults.length + treeResults.length + fileHits.length + moreRows
        : slashResults.length;
  // The open picker hangs from the character that opened it, and stays there as the query is typed.
  const well = useRef<HTMLFormElement>(null);
  const trigger = (fileMention ?? treeMention ?? agentMention)?.start ?? (slashResults.length > 0 ? slash?.start : undefined) ?? null;
  const pickerLeft = usePickerAnchor(field, well, trigger);

  const model = useRef<Opener>(null);
  const effort = useRef<Opener>(null);
  const access = useRef<Opener>(null);
  const movableNow = useRef(movable);
  useEffect(() => {
    movableNow.current = movable;
  });
  // What the picker keys open, from this well and from a picker it opened.
  const pickers = useMemo<PromptPickers>(
    () => ({
      has: (letter) => letter === "P" || (movableNow.current && hasWorktreePicker()),
      open: (letter) => (letter === "P" ? model.current?.open() : openWorktreePicker()),
    }),
    [],
  );
  const stepEffort = () => {
    if (!choice || !onChoice) return false;
    const fitted = fitChoice(choice);
    const next = nextEffort(selectedEffort(fitted.provider, fitted.model, fitted.effort), effortsOf(fitted.provider, fitted.model));
    if (next) onChoice(fitChoice({ ...fitted, effort: next }));
    return true;
  };
  const stepNow = useRef(stepEffort);
  useEffect(() => {
    stepNow.current = stepEffort;
  });
  const prompt = useMemo<Prompt>(
    () => ({ pickers, element: () => well.current, field: () => field.current, stepEffort: () => stepNow.current() }),
    [pickers],
  );
  useEffect(() => registerPrompt(prompt), [prompt]);

  // The draft has just changed: the caret goes where the change left it once the field has the new text.
  const place = (at: number, then?: () => void) => {
    requestAnimationFrame(() => {
      field.current?.select(at);
      setCursor(at);
      then?.();
    });
  };

  // ↵ and a click finish the mention and close the menu; ⇥ on a folder goes into it instead.
  const pick = (file: ProjectFile, into = false) => {
    const el = field.current;
    if (!el) return;
    const next = completeMention(draft, el.read().from, file, { into });
    if (!next) return;
    rememberMention(file.path);
    setPicked((list) => (list.includes(file.relative) ? list : [...list, file.relative]));
    onDraft(next.text);
    setActive(0);
    place(next.cursor);
  };

  const searchFiles = () => {
    const at = (mention ?? named)?.start;
    if (at === undefined) return;
    // A name with a space in it is no path: the file search starts over from the `@`.
    if (!mention && named) {
      const next = draft.slice(0, named.start + 1) + draft.slice(named.end);
      onDraft(next);
      place(named.start + 1);
    }
    setSub({ at, kind: "files" });
    setActive(0);
  };

  const listTrees = () => {
    if (!named) return;
    setSub({ at: named.start, kind: "trees" });
    setActive(0);
  };

  const pickAgent = (agent: Session | TreeMention) => {
    const at = treeMention ?? agentMention;
    if (!at) return;
    const next = completeAgentMention(draft, at, agent);
    setSub(null);
    onDraft(next.text);
    setActive(0);
    place(next.cursor);
  };

  // A command or skill stays in the draft as `/name `; a Crew action runs and leaves nothing.
  const pickSlash = (entry: CommandEntry) => {
    const el = field.current;
    if (!el) return;
    const acts = entry.kind === "crew";
    const at = el.read().from;
    const next = acts ? removeSlash(draft, at) : completeSlash(draft, at, entry);
    if (!next) return;
    onDraft(next.text);
    setActive(0);
    // A menu it opens takes the focus, so it opens after the field has had it.
    place(next.cursor, acts ? () => runAction(entry.name) : undefined);
  };

  const runAction = (name: string) => {
    if (name === "model") model.current?.open();
    else if (name === "effort") effort.current?.open();
    else if (name === "access") access.current?.open();
    else if (name === "fast") {
      const next = choice && toggledFast(choice);
      if (next) onChoice?.(next);
    } else onAction?.(name);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const el = field.current;
    if (choices > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => (index + step + choices) % choices);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const at = Math.min(active, choices - 1);
        if (fileMention) pick(results[at]!, event.key === "Tab");
        else if (treeMention) pickAgent(treeResults[at]!);
        else if (agentMention) {
          const target = agentResults[at] ?? treeResults[at - agentResults.length];
          const matched = agentResults.length + treeResults.length;
          const file = fileHits[at - matched];
          if (target) pickAgent(target);
          else if (file) pick(file, event.key === "Tab");
          else if (at === matched + fileHits.length) searchFiles();
          else listTrees();
        } else pickSlash(slashResults[at]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        // Out of the files or worktrees it went into, back to the agents; from there, the menu closes.
        if ((fileMention && sub?.at === fileMention.start) || treeMention) {
          setSub(null);
          setActive(0);
        } else setCursor(-1);
        return;
      }
    }
    // Lists carry on and indent as you type; the text stays plain markdown. Enter still sends, even on a
    // list item: the key that writes a new line here is ⇧↵, so that is the one that continues the list
    // (and ends it on an empty item). Making ↵ continue instead would change what ↵ means mid-message.
    if (el && !event.isComposing && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const { value, from: selectionStart, to: selectionEnd } = el.read();
      if (event.key === "Backspace" && !event.shiftKey) {
        const edit = removeListMarker(value, selectionStart, selectionEnd);
        if (edit) {
          event.preventDefault();
          el.apply(edit);
          return;
        }
      }
      if (event.key === "Enter" && event.shiftKey) {
        const edit = continueList(value, selectionStart, selectionEnd);
        if (edit) {
          event.preventDefault();
          el.apply(edit);
          return;
        }
      }
      // Tab indents a list item; ⇧Tab outdents one that is indented, and otherwise steps the modes below.
      if (event.key === "Tab" && (event.shiftKey ? onIndentedListLine(value, selectionStart) : onListLine(value, selectionStart))) {
        const edit = indentList(value, selectionStart, selectionEnd, event.shiftKey ? -1 : 1);
        if (edit) {
          event.preventDefault();
          el.apply(edit);
          return;
        }
      }
    }
    // ⌥P opens the model picker, as in Claude Code; ⌥W the worktree, while the session can still move.
    const letter = promptLetter(event);
    if (letter && pickers.has(letter)) {
      event.preventDefault();
      pickers.open(letter);
      return;
    }
    // ⇧Tab steps the effort levels; access stays a deliberate pick.
    if (event.key === "Tab" && event.shiftKey && stepEffort()) {
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (canSend) onSend(event.metaKey || event.ctrlKey);
  };

  // What the plus menu types for you: an `@` or a `/` at the caret, so the pickers open as if typed.
  const typeAtCaret = (mark: string) => {
    const at = mark === "/" && draft.trim() === "" ? 0 : (field.current?.read().from ?? draft.length);
    const before = mark === "/" && at === 0 ? "" : draft.slice(0, at);
    const gap = before.length > 0 && !/\s$/.test(before) ? " " : "";
    onDraft(`${before}${gap}${mark}${draft.slice(at)}`);
    setActive(0);
    // The menu hands the focus back to its trigger as it closes: the caret goes in after that.
    window.setTimeout(() => place(before.length + gap.length + 1), 40);
  };

  return (
    <form
      ref={well}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend(false);
      }}
      onFocusCapture={() => activatePrompt(prompt)}
      data-composer
      data-session={session}
      className="ds-composer"
      {...(roomy ? { "data-roomy": "" } : {})}
    >
      {fileMention && (
        <MentionPicker
          results={results}
          active={Math.min(active, Math.max(0, results.length - 1))}
          onHover={setActive}
          onPick={pick}
          left={pickerLeft}
        />
      )}
      {treeMention && (
        <TreePicker
          results={treeResults}
          active={Math.min(active, Math.max(0, treeResults.length - 1))}
          onHover={setActive}
          onPick={pickAgent}
          left={pickerLeft}
        />
      )}
      {agentMention && (
        <AgentPicker
          results={agentResults}
          trees={treeResults}
          files={fileHits}
          active={Math.min(active, choices - 1)}
          onHover={setActive}
          onPick={pickAgent}
          onPickFile={pick}
          onFiles={searchFiles}
          onTrees={worktrees.length > 0 ? listTrees : undefined}
          left={pickerLeft}
        />
      )}
      {slashResults.length > 0 && (
        <SlashPicker
          results={slashResults}
          active={Math.min(active, slashResults.length - 1)}
          onHover={setActive}
          onPick={pickSlash}
          left={pickerLeft}
        />
      )}
      {(files.length > 0 || uploads.length > 0) && (
        <div className="px-1.5">
          <AttachmentStrip files={files} onRemove={onRemoveFile} uploads={uploads} onDismissUpload={onDismissUpload} />
        </div>
      )}
      <div className="ds-composer-text">
        <PromptEditor
          ref={field}
          roomy={roomy}
          value={draft}
          placeholder={placeholder}
          label={label}
          known={known}
          agents={chipAgents}
          entries={commands}
          onChange={(value, caret) => {
            onDraft(value);
            setCursor(caret);
            setActive(0);
            // The file or worktree search lasts as long as the `@` it was opened for.
            if (sub) {
              const open = sub.kind === "files" ? mentionAt(value, caret) : nameMentionAt(value, caret, names);
              if (open?.start !== sub.at) setSub(null);
            }
          }}
          onCaret={setCursor}
          onKeyDown={onKeyDown}
          onPasteFiles={onPasteFiles}
        />
      </div>
      <div className="flex h-8 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <AttachMenu onAttach={onAttach} onMention={() => typeAtCaret("@")} onCommand={() => typeAtCaret("/")} />
          {lockedChoice && (
            <div className="ds-model-group" inert title="Set when it was started">
              <ModelControls lockProvider value={lockedChoice} onChange={() => undefined} />
            </div>
          )}
          {choice && onChoice && (
            <div className="ds-model-group">
              <ModelControls lockProvider={lockProvider} value={choice} onChange={onChoice} openers={{ model, effort }} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {choice && onChoice && (
            <div className="ds-access">
              <AccessPicker ref={access} provider={choice.provider} value={choice.access} onChange={(next) => onChoice({ ...choice, access: next })} />
            </div>
          )}
          {trailing}
        </div>
      </div>
    </form>
  );
}
