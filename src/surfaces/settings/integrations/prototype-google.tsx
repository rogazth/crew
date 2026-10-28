// PROTOTYPE, throw away: how Google and Figma would look on the Connectors
// page, dev builds only. Gmail, Drive, Calendar, Docs and Sheets are each a
// connector of their own, installed one by one, each with one account or
// more; an account is one Google sign-in shared by the apps, so a second app
// only asks Google for its own scopes. Browse lists them apart, as "Built in",
// and they behave as the registry's do: the row opens a summary (with the
// publisher "Built in"), Install signs in at once, and the page is a
// connector's. They say plainly they're unofficial: Crew calls Google's API,
// not Google's server. Under them crewd serves the tools (running gws), which
// the page doesn't say. Figma is
// installable, signing in as an approved client. Nothing here reaches the
// daemon; Google's state lives in memory.
// The plan: docs/plans/2026-10-28-google-and-figma.md.
import { ArrowLeftIcon, CheckIcon, GlobeIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConfirmDialog, type Confirm } from "../../../chrome/ConfirmDialog";
import { Button, IconButton } from "../../../chrome/kit";
import { Group, Row, SettingsPage } from "../ui";
import { Pills, SwitchRow } from "./bits";
import { Dialog, DialogFooter, DialogGroup, DialogHeader, DialogRow } from "./dialog";
import { ui, useEscape, useUi } from "./lib";
import type { Brand } from "./brand";
import { ServiceMark } from "./mark";
import { Tile } from "./sections";
import { UnofficialNote } from "./builtin";
import { formatTokens, useIntegrations } from "./store";

/* ── The prototype's own state ──────────────────────────────────────── */

export const PROTO = import.meta.env.DEV;

export type ServiceId = "gmail" | "drive" | "calendar" | "docs" | "sheets";
type Tool = { name: string; line: string; tokens: number; hint?: "read" | "change" };
type Service = { id: ServiceId; name: string; api: string; line: string; data: string; tools: Tool[] };

const SERVICES: Service[] = [
  {
    id: "gmail",
    name: "Gmail",
    api: "gmail.googleapis.com",
    line: "Search, read, draft and send mail",
    data: "Your mail",
    tools: [
      { name: "search_threads", line: "Find threads with Gmail’s search", tokens: 420, hint: "read" },
      { name: "read_thread", line: "Every message in a thread, with attachments listed", tokens: 310, hint: "read" },
      { name: "list_labels", line: "The mailbox’s labels", tokens: 160, hint: "read" },
      { name: "create_draft", line: "A draft, new or in reply", tokens: 380 },
      { name: "send_message", line: "Send, reply or forward", tokens: 450 },
      { name: "modify_labels", line: "Add or remove labels, mark read or archived", tokens: 290 },
      { name: "trash_thread", line: "Move a thread to the trash", tokens: 180, hint: "change" },
    ],
  },
  {
    id: "drive",
    name: "Drive",
    api: "drive.googleapis.com",
    line: "Find, read and upload files",
    data: "Your files",
    tools: [
      { name: "search_files", line: "Find files by name, type or text", tokens: 400, hint: "read" },
      { name: "read_file", line: "A file’s text, exported when it’s a Google file", tokens: 260, hint: "read" },
      { name: "list_folder", line: "What’s in a folder", tokens: 210, hint: "read" },
      { name: "upload_file", line: "Upload a file from the session’s folder", tokens: 340 },
      { name: "create_folder", line: "A new folder", tokens: 170 },
      { name: "share_file", line: "Share with people or a link", tokens: 330, hint: "change" },
      { name: "trash_file", line: "Move a file to the trash", tokens: 160, hint: "change" },
    ],
  },
  {
    id: "calendar",
    name: "Calendar",
    api: "calendar.googleapis.com",
    line: "See, plan and change events",
    data: "Your events",
    tools: [
      { name: "list_events", line: "Events in a range, across calendars", tokens: 380, hint: "read" },
      { name: "find_free_time", line: "Free slots for you and others", tokens: 300, hint: "read" },
      { name: "create_event", line: "An event, with guests and a Meet link", tokens: 460 },
      { name: "update_event", line: "Move or change an event", tokens: 390 },
      { name: "delete_event", line: "Cancel an event", tokens: 170, hint: "change" },
    ],
  },
  {
    id: "docs",
    name: "Docs",
    api: "docs.googleapis.com",
    line: "Read and write documents",
    data: "Your documents",
    tools: [
      { name: "read_document", line: "A document as Markdown", tokens: 240, hint: "read" },
      { name: "create_document", line: "A new document from Markdown", tokens: 280 },
      { name: "edit_document", line: "Insert, replace or delete text", tokens: 420 },
    ],
  },
  {
    id: "sheets",
    name: "Sheets",
    api: "sheets.googleapis.com",
    line: "Read and write spreadsheets",
    data: "Your spreadsheets",
    tools: [
      { name: "read_range", line: "Cells from a range, as rows", tokens: 280, hint: "read" },
      { name: "list_sheets", line: "A spreadsheet’s tabs and sizes", tokens: 190, hint: "read" },
      { name: "create_spreadsheet", line: "A new spreadsheet", tokens: 230 },
      { name: "write_range", line: "Write or append rows", tokens: 360 },
      { name: "clear_range", line: "Empty a range", tokens: 170, hint: "change" },
    ],
  },
];

type Account = { email: string; everywhere: boolean; off: string[]; toolsOff: string[] };
type State = { installed: Partial<Record<ServiceId, Account[]>> };

let state: State = { installed: {} };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};
const put = (id: ServiceId, next: Account[]) => {
  const installed = { ...state.installed };
  if (next.length > 0) installed[id] = next;
  else delete installed[id];
  set({ installed });
};
const fresh = (email: string): Account => ({ email, everywhere: true, off: [], toolsOff: [] });
function useProto(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
const installedIds = (s: State) => SERVICES.map((sv) => sv.id).filter((id) => s.installed[id]);
/** Whether a Google app is installed, so the page isn't empty without a real connector. */
export function useGoogleInstalled(): boolean {
  const s = useProto();
  return PROTO && installedIds(s).length > 0;
}
/** Google accounts some app signed in with, first seen first. */
const knownEmails = (s: State) => [...new Set(installedIds(s).flatMap((id) => s.installed[id]!.map((a) => a.email)))];
/** The apps besides this one an account is signed in for. */
const sharedWith = (s: State, id: ServiceId, email: string) =>
  installedIds(s)
    .filter((x) => x !== id && s.installed[x]!.some((a) => a.email === email))
    .map(protoName);
/** A made-up address for a new sign-in, one no app has yet. */
const FAKE = ["you@gmail.com", "work@company.com", "side@gmail.com", "team@company.com"];
const newEmail = (s: State) => FAKE.find((e) => !knownEmails(s).includes(e)) ?? `you+${Date.now() % 1000}@gmail.com`;

const brandOf = (s: Service): Brand => ({
  id: `proto-${s.id}`,
  name: s.name,
  publisher: "google.com",
  logo: `https://ssl.gstatic.com/images/branding/product/2x/${s.id}_2020q4_48dp.png`,
});
const serviceOf = (id: ServiceId) => SERVICES.find((s) => s.id === id)!;
export const protoName = (id: ServiceId) => serviceOf(id).name;

const openPage = (id: ServiceId) => ui.detail({ kind: "proto", id });
const connect = (id: ServiceId) => ui.open({ kind: "proto", id });
const summary = (id: ServiceId) => ui.open({ kind: "proto-summary", id });

/* ── Home and the directory ─────────────────────────────────────────── */

/** A tile per Google app, to put among Installed's. */
export function useProtoTiles() {
  const s = useProto();
  if (!PROTO) return [];
  return installedIds(s).map((id) => {
    const sv = serviceOf(id);
    const emails = s.installed[id]!.map((a) => a.email);
    const subtitle = emails.length === 1 ? emails[0] : `${emails.length} accounts`;
    return <Tile key={`proto-${id}`} marks={[brandOf(sv)]} title={sv.name} subtitle={subtitle} onOpen={() => openPage(id)} />;
  });
}

/** The Google apps above the registry's, under their own title: not from the registry, and no check. */
export function ProtoDirectoryRows({ query }: { query: string }) {
  const s = useProto();
  if (!PROTO) return null;
  const q = query.trim().toLowerCase();
  const shown = SERVICES.filter((sv) => !q || `google ${sv.name} ${sv.line}`.toLowerCase().includes(q));
  if (shown.length === 0) return null;
  return (
    <>
      <p className="mt-2 -mb-2.5 px-1 text-[13px] text-text-muted">Built in</p>
      <div className="grid grid-cols-1 gap-x-6 px-1 @[620px]:grid-cols-2">
        {shown.map((sv) => (
          <DirectoryRow key={sv.id} sv={sv} installed={!!s.installed[sv.id]} />
        ))}
      </div>
    </>
  );
}

function DirectoryRow({ sv, installed }: { sv: Service; installed: boolean }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => (installed ? openPage(sv.id) : summary(sv.id))}
      className="-mx-2 flex h-16 min-w-0 cursor-default items-center gap-3 rounded-xl px-2 outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      <ServiceMark brand={brandOf(sv)} size={40} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{sv.name}</span>
        <span className="truncate text-[12px] text-text-muted">{sv.line}</span>
      </span>
      {installed ? (
        <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-text-muted">
          <CheckIcon className="size-3.5" />
          Installed
        </span>
      ) : (
        <button
          type="button"
          onClick={(event) => (event.stopPropagation(), connect(sv.id))}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex h-7 shrink-0 items-center rounded-full bg-card px-3 text-[12.5px] font-medium outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
        >
          Install
        </button>
      )}
    </div>
  );
}

/** What the row opens: the registry's summary, with "Built in" as its publisher. */
export function GoogleSummaryDialog({ id }: { id: ServiceId }) {
  const sv = serviceOf(id);
  return (
    <Dialog label={sv.name}>
      <DialogHeader mark={<ServiceMark brand={brandOf(sv)} size={40} />} title={sv.name} subtitle={`${sv.line}.`} wrap />
      <p className="px-5 pb-2 text-[12.5px] text-text-muted">Agents will act on your behalf in {sv.name}.</p>
      <DialogGroup>
        <DialogRow title="Publisher" subtitle="Built in" />
        <DialogRow title="Server" subtitle={sv.api} />
      </DialogGroup>
      <UnofficialNote vendor="Google" className="px-5 pb-4" />
      <DialogFooter>
        <Button variant="primary" onClick={() => connect(id)}>
          Install
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ── Installing one ─────────────────────────────────────────────────── */

/** Installing an app, or adding an account to one: the sign-in starts at once, and Google's own picker asks which account. */
export function GoogleConnectDialog({ id }: { id: ServiceId }) {
  const s = useProto();
  const sv = serviceOf(id);
  const adding = (s.installed[id] ?? []).length > 0;
  const [email, setEmail] = useState<string | null>(null);
  // Install already asked: the sign-in opens with the sheet, once (StrictMode mounts twice).
  const began = useRef(false);
  useEffect(() => {
    if (began.current) return;
    began.current = true;
    const as = knownEmails(state).find((e) => !(state.installed[id] ?? []).some((a) => a.email === e)) ?? newEmail(state);
    window.setTimeout(() => {
      put(id, [...(state.installed[id] ?? []), fresh(as)]);
      setEmail(as);
    }, 1400);
  }, [id]);
  const title = email ? (adding ? "Account added" : `${sv.name} is installed`) : adding ? `Add an account to ${sv.name}` : `Install ${sv.name}`;
  const others = email ? sharedWith(state, id, email) : [];
  return (
    <Dialog label={title}>
      <DialogHeader mark={<ServiceMark brand={brandOf(sv)} size={40} />} title={title} subtitle={email ?? "Built in"} />
      {email ? (
        <DialogGroup title="Account">
          <DialogRow title={email} subtitle={others.length > 0 ? `Also signed in for ${others.join(", ")}` : undefined} />
        </DialogGroup>
      ) : (
        <DialogGroup>
          <DialogRow
            icon={
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface shadow-[0_0_0_1px_var(--color-hairline)]">
                <GlobeIcon className="size-4 text-info" />
              </span>
            }
            title={<span className="crew-shimmer">Waiting for the browser…</span>}
          />
        </DialogGroup>
      )}
      <DialogFooter>
        <Button variant={email ? "primary" : "ghost"} onClick={ui.close}>
          {email ? "Done" : "Close"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ── One app's page ─────────────────────────────────────────────────── */

export function GooglePage({ id }: { id: ServiceId }) {
  const st = useProto();
  const { sheet } = useUi();
  const s = useIntegrations();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const home = () => ui.go("home");
  useEscape(sheet ? () => {} : home);
  const accounts = st.installed[id];
  useEffect(() => {
    if (!accounts) home();
  }, [accounts]);
  if (!accounts) return null;
  const sv = serviceOf(id);
  const account = accounts.find((a) => a.email === picked) ?? accounts[0]!;
  const workspaces = s.consumers.filter((c) => c.kind === "workspace");
  const patch = (next: Partial<Account>) =>
    put(
      id,
      accounts.map((a) => (a.email === account.email ? { ...a, ...next } : a)),
    );
  // Giving back one app's access leaves the account signed in for the others.
  const leaving = (email: string) => {
    const others = sharedWith(st, id, email);
    return others.length > 0 ? `${others.join(", ")} stay signed in as ${email}.` : `Signs ${email} out of Google.`;
  };
  const tokens = sv.tools.filter((t) => !account.toolsOff.includes(t.name)).reduce((n, t) => n + t.tokens, 0);
  return (
    <SettingsPage title={sv.name} hideHeader>
      <header className="-mt-6 flex flex-col gap-3 px-1">
        <IconButton icon={ArrowLeftIcon} label="Back to Connectors" className="-ml-2 size-8 self-start" onClick={home} />
        <div className="flex items-center gap-3">
          <ServiceMark brand={brandOf(sv)} size={40} />
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate text-[22px] leading-7 font-semibold tracking-[-0.02em]">{sv.name}</h1>
            <p className="truncate text-[13px] text-text-muted">Built in</p>
          </div>
          <IconButton
            icon={Trash2Icon}
            label={`Remove ${sv.name}`}
            className="size-8"
            onClick={() =>
              setConfirm({
                title: `Remove ${sv.name}?`,
                description: `Gives Google back ${sv.name}’s access for every account here. ${accounts.map((a) => leaving(a.email)).join(" ")}`,
                action: "Remove",
                onConfirm: () => put(id, []),
              })
            }
          />
          <ConfirmDialog confirm={confirm} onAsk={setConfirm} onClose={() => setConfirm(null)} />
        </div>
      </header>
      <Group title="Accounts">
        {accounts.map((a) => {
          const others = sharedWith(st, id, a.email);
          return (
            <Row key={a.email} label={a.email} description={others.length > 0 ? `Also signed in for ${others.join(", ")}` : undefined}>
              {accounts.length > 1 && (
                <IconButton
                  icon={Trash2Icon}
                  label={`Remove ${a.email}`}
                  className="size-7"
                  onClick={() =>
                    setConfirm({
                      title: `Remove ${a.email} from ${sv.name}?`,
                      description: leaving(a.email),
                      action: "Remove",
                      onConfirm: () =>
                        put(
                          id,
                          accounts.filter((x) => x.email !== a.email),
                        ),
                    })
                  }
                />
              )}
            </Row>
          );
        })}
        <button
          type="button"
          onClick={() => connect(id)}
          className="flex h-12 w-full items-center gap-1.5 text-left text-text-muted outline-none transition-colors hover:text-text focus-visible:text-text"
        >
          <PlusIcon className="size-4" />
          Add another account
        </button>
      </Group>
      {accounts.length > 1 && (
        <Pills
          small
          label="Account"
          value={account.email}
          onChange={setPicked}
          className="-mb-3 self-start"
          options={accounts.map((a) => ({ value: a.email, label: a.email }))}
        />
      )}
      <Group title="Workspaces">
        <SwitchRow
          label="All workspaces"
          checked={account.everywhere}
          onChange={(everywhere) => patch({ everywhere, off: everywhere ? [] : workspaces.map((w) => w.id) })}
        />
        {!account.everywhere &&
          workspaces.map((w) => (
            <SwitchRow
              key={w.id}
              label={w.name}
              checked={!account.off.includes(w.id)}
              onChange={(next) => patch({ off: next ? account.off.filter((x) => x !== w.id) : [...account.off, w.id] })}
            />
          ))}
      </Group>
      <Group title="Tools" action={<span className="text-[12px] text-text-muted tabular-nums">{formatTokens(tokens)} tokens</span>}>
        {sv.tools.map((tool) => (
          <SwitchRow
            key={tool.name}
            label={tool.name}
            description={tool.line}
            checked={!account.toolsOff.includes(tool.name)}
            onChange={(next) =>
              patch({
                toolsOff: next ? account.toolsOff.filter((x) => x !== tool.name) : [...account.toolsOff, tool.name],
              })
            }
          />
        ))}
      </Group>
      <Group title="About">
        <Row label="Publisher">
          <span className="text-text-muted">Built in</span>
        </Row>
        <Row label="Server">
          <span className="text-text-muted">{sv.api}</span>
        </Row>
      </Group>
      <UnofficialNote vendor="Google" />
    </SettingsPage>
  );
}
