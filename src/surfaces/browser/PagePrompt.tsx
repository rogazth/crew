import {
  AppWindowIcon,
  BellIcon,
  ClipboardIcon,
  KeyRoundIcon,
  MapPinIcon,
  MicIcon,
  ShieldAlertIcon,
  VideoIcon,
  XIcon,
  type LucideIcon as Icon,
} from "lucide-react";
import { useRef, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button, Field, TextInput } from "../../chrome/kit";
import { usePagePrompts } from "../../hooks/useBrowserSignals";
import { changeSitePermissions } from "../../hooks/useSitePermissions";
import type { PagePrompt as Prompt, PromptAnswer } from "../../lib/browser/bridge";
import { decide, PERMISSION_LABELS, type SitePermission } from "../../lib/browser/permissions";
import { prompts } from "../../lib/browser/prompts";
import { browserHost } from "../../lib/host";

const GLYPHS: Record<SitePermission, Icon> = {
  camera: VideoIcon,
  microphone: MicIcon,
  notifications: BellIcon,
  geolocation: MapPinIcon,
  "clipboard-read": ClipboardIcon,
};

/** "meet.google.com", or the whole origin when it is not the default port over https. */
function siteName(origin: string): string {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" ? url.host : origin;
  } catch {
    return origin;
  }
}

/**
 * The first question a page is waiting on, answered back to main. A decision
 * the person keeps is saved here too, except an incognito page's, which main
 * alone holds until the session ends.
 */
export function PagePrompts({
  webContentsId,
  incognito,
  onSignedIn,
}: {
  webContentsId: number | null;
  incognito: boolean;
  /** A sign-in held the keyboard; the page gets it back. */
  onSignedIn: () => void;
}) {
  const waiting = usePagePrompts(webContentsId);
  const prompt = waiting[0];
  if (!prompt) return null;
  const answer = (reply: PromptAnswer) => {
    prompts.remove(prompt.id);
    browserHost()?.answer(prompt.id, reply);
    if (prompt.kind === "permission" && reply && "remember" in reply && reply.remember && !incognito) {
      const decision = reply.allow ? "allow" : "block";
      void changeSitePermissions((current) => decide(current, prompt.origin, prompt.permissions, decision));
    }
    if (prompt.kind === "auth" && reply) onSignedIn();
  };
  return <PagePrompt key={prompt.id} prompt={prompt} waiting={waiting.length - 1} onAnswer={answer} />;
}

type Props = {
  prompt: Prompt;
  /** Questions queued behind this one on the same page. */
  waiting: number;
  onAnswer: (answer: PromptAnswer) => void;
};

/**
 * What a page is waiting on the person for, over the page's top left, under
 * the address it came from. Only a sign-in takes the keyboard; the rest can
 * be answered later, or closed, which answers no without remembering it.
 */
function PagePrompt({ prompt, waiting, onAnswer }: Props) {
  const dismiss = () => onAnswer(dismissal(prompt));
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    dismiss();
  };
  return (
    // Open without showModal(): it waits beside the page, which stays usable under it.
    <dialog
      open
      aria-label={title(prompt)}
      onKeyDown={onKeyDown}
      className="absolute top-2 right-auto left-2 z-20 m-0 flex w-[340px] max-w-[calc(100%-16px)] flex-col gap-3 rounded-xl border-0 bg-surface p-3 text-text shadow-float"
    >
      <div className="flex items-start gap-2.5">
        <Glyph prompt={prompt} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="font-medium break-words">{title(prompt)}</p>
          {waiting > 0 && <p className="text-[11px] text-text-muted">{waiting} more waiting</p>}
        </div>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={dismiss}
          className="-mt-0.5 -mr-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-icon outline-none transition-colors hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <Body prompt={prompt} onAnswer={onAnswer} />
    </dialog>
  );
}

/** What closing the prompt answers: no, just this once. */
function dismissal(prompt: Prompt): PromptAnswer {
  switch (prompt.kind) {
    case "permission":
      return { allow: false, remember: false };
    case "external":
      return { open: false };
    case "system":
      return { settings: false };
    case "auth":
      return null;
  }
}

function title(prompt: Prompt): string {
  switch (prompt.kind) {
    case "permission":
      return `${siteName(prompt.origin)} wants to`;
    case "auth":
      return `Sign in to ${siteName(prompt.origin)}`;
    case "external":
      return `Open ${prompt.app}?`;
    case "system": {
      const names = prompt.permissions.map((kind) => PERMISSION_LABELS[kind].name.toLowerCase());
      return `macOS is blocking Crew's ${names.join(" and ")}`;
    }
  }
}

function Glyph({ prompt }: { prompt: Prompt }) {
  const GlyphIcon =
    prompt.kind === "auth"
      ? KeyRoundIcon
      : prompt.kind === "external"
        ? AppWindowIcon
        : prompt.kind === "system"
          ? ShieldAlertIcon
          : GLYPHS[prompt.permissions[0] ?? "camera"];
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-card text-icon">
      <GlyphIcon className="size-4" />
    </span>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-2">{children}</div>;
}

function Body({ prompt, onAnswer }: { prompt: Prompt; onAnswer: (answer: PromptAnswer) => void }) {
  switch (prompt.kind) {
    case "permission": {
      // Letting a site in for one visit only makes sense for a device it uses while it is open.
      const once = prompt.permissions.every((kind) => kind === "camera" || kind === "microphone");
      return (
        <>
          <ul className="flex flex-col gap-1.5 pl-[38px]">
            {prompt.permissions.map((kind) => {
              const RowGlyph = GLYPHS[kind];
              return (
                <li key={kind} className="flex items-center gap-2 text-text-muted">
                  <RowGlyph className="size-3.5 shrink-0 text-icon" />
                  {PERMISSION_LABELS[kind].does}
                </li>
              );
            })}
          </ul>
          <Actions>
            <Button variant="ghost" className="text-[12px]" onClick={() => onAnswer({ allow: false, remember: true })}>
              Block
            </Button>
            {once && (
              <Button className="text-[12px]" onClick={() => onAnswer({ allow: true, remember: false })}>
                Allow Once
              </Button>
            )}
            <Button variant="primary" className="text-[12px]" onClick={() => onAnswer({ allow: true, remember: true })}>
              Allow
            </Button>
          </Actions>
        </>
      );
    }
    case "external":
      return (
        <>
          <p className="text-text-muted">
            {prompt.origin ? `${siteName(prompt.origin)} wants to open ` : "This page wants to open "}
            a <span className="font-mono text-[12px]">{prompt.scheme}:</span> link in {prompt.app}.
          </p>
          <Actions>
            <Button variant="ghost" className="text-[12px]" onClick={() => onAnswer({ open: false })}>
              Cancel
            </Button>
            <Button variant="primary" className="text-[12px]" onClick={() => onAnswer({ open: true })}>
              Open {prompt.app}
            </Button>
          </Actions>
        </>
      );
    case "system":
      return (
        <>
          <p className="text-text-muted">
            The page was refused. Turn Crew on in System Settings › Privacy &amp; Security, then reload the page.
          </p>
          <Actions>
            <Button variant="ghost" className="text-[12px]" onClick={() => onAnswer({ settings: false })}>
              Not Now
            </Button>
            <Button variant="primary" className="text-[12px]" onClick={() => onAnswer({ settings: true })}>
              Open System Settings
            </Button>
          </Actions>
        </>
      );
    case "auth":
      return <SignIn key={prompt.id} prompt={prompt} onAnswer={onAnswer} />;
  }
}

function SignIn({ prompt, onAnswer }: { prompt: Extract<Prompt, { kind: "auth" }>; onAnswer: (answer: PromptAnswer) => void }) {
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onAnswer({ username: username.current?.value ?? "", password: password.current?.value ?? "" });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 text-text-muted">
        {prompt.realm && <p className="break-words">The site says: “{prompt.realm}”</p>}
        {!prompt.secure && <p className="text-text">This connection isn't private, so what you type here can be read on the way.</p>}
      </div>
      <Field label="Username">
        <TextInput ref={username} autoFocus autoComplete="username" name="username" />
      </Field>
      <Field label="Password">
        <TextInput ref={password} type="password" autoComplete="current-password" name="password" />
      </Field>
      <Actions>
        <Button variant="ghost" className="text-[12px]" onClick={() => onAnswer(null)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" className="text-[12px]">
          Sign In
        </Button>
      </Actions>
    </form>
  );
}
