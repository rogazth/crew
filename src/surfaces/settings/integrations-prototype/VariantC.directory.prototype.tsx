// PROTOTYPE — throwaway. Adding a connector: the directory as a page (the MCP
// Registry, searchable, with what you have marked), and over it in dialogs a
// connector's summary before you connect it, and a custom connector for a
// server the directory doesn't list — remote by URL, or local by command.
import { ArrowLeftIcon, CheckIcon, GlobeIcon, PlusIcon, SearchIcon, TerminalIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button, Field, IconButton, TextArea, TextInput } from "../../../chrome/kit";
import { SettingsPage } from "../ui";
import { ServiceMark } from "./parts.prototype";
import { Pills } from "./VariantC.bits.prototype";
import { Dialog, DialogFooter, DialogGroup, DialogHeader, DialogRow } from "./VariantC.dialog.prototype";
import { openConnector, ui, useEscape, useUi } from "./VariantC.lib.prototype";
import { useRegistry } from "./registry.prototype";
import { actions, machineOf, registerService, serviceOf, useIntegrations, type Service } from "./store.prototype";

// Going back from a summary finds the search as it was left.
let lastQuery = "";

/* ── The directory ──────────────────────────────────────────────────── */

/** The directory as its own page (the strip above says Connectors › Browse): a search, and the registry in two columns. */
export function DirectoryPage() {
  const s = useIntegrations();
  const { sheet } = useUi();
  const [query, setQueryState] = useState(lastQuery);
  const setQuery = (next: string) => {
    lastQuery = next;
    setQueryState(next);
  };
  const { services, loading, error } = useRegistry(query);
  const q = query.trim();
  const has = (id: string) => s.accounts.some((a) => a.serviceId === id);
  // Suggestions leave out what you have; a search finds it too, marked.
  const list = q ? services : services.filter((x) => !has(x.id));
  const pick = (service: Service) => {
    const known = registerService(service);
    if (has(known.id)) openConnector(known.id);
    else ui.open({ kind: "summary", serviceId: known.id, back: true });
  };
  const home = () => ui.go("home");
  useEscape(sheet ? noop : home);
  return (
    <SettingsPage title="Browse connectors" hideHeader>
      <header className="flex items-center gap-2 px-1">
        <IconButton icon={ArrowLeftIcon} label="Back to Connectors" className="-ml-1.5 size-8" onClick={home} />
        <h1 className="flex-1 truncate text-[22px] leading-7 font-semibold tracking-[-0.02em]">Browse connectors</h1>
        <Button icon={PlusIcon} onClick={() => ui.open({ kind: "custom" })}>
          Custom
        </Button>
      </header>
      <div className="flex flex-col gap-3">
        <label className="flex h-9 items-center gap-2 rounded-lg bg-card px-3 ring-1 ring-hairline transition-shadow focus-within:ring-[1.5px] focus-within:ring-focus/50">
          <SearchIcon className="size-4 text-icon" />
          <input
            autoFocus
            value={query}
            spellCheck={false}
            aria-label="Search"
            placeholder="Search"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && query && (event.stopPropagation(), event.nativeEvent.stopImmediatePropagation(), setQuery(""))}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-placeholder"
          />
          {query && (
            <button type="button" aria-label="Clear" onClick={() => setQuery("")} className="text-icon">
              <XIcon className="size-3.5" />
            </button>
          )}
        </label>
        <p className="px-1 text-[13px] text-text-muted">
          {error ? "Couldn’t reach the MCP Registry." : q ? (loading ? "Searching…" : `${list.length} ${list.length === 1 ? "result" : "results"}`) : "Popular"}
        </p>
        <div className="grid grid-cols-1 gap-x-6 px-1 @[620px]:grid-cols-2">
          {loading && list.length === 0
            ? Array.from({ length: 8 }, (_, i) => <RowSkeleton key={i} />)
            : list.map((service) => <DirectoryRow key={service.id} service={service} connected={has(service.id)} onPick={() => pick(service)} />)}
        </div>
        {!loading && q && list.length === 0 && (
          <p className="px-1 text-[13px] text-text-muted">
            No results for “{q}”.{" "}
            <button type="button" onClick={() => ui.open({ kind: "custom" })} className="font-medium text-info outline-none focus-visible:underline">
              Add a custom connector
            </button>
          </p>
        )}
      </div>
    </SettingsPage>
  );
}

const noop = () => {};

function DirectoryRow({ service, connected, onPick }: { service: Service; connected: boolean; onPick: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), onPick())}
      className="-mx-2 flex h-16 min-w-0 cursor-default items-center gap-3 rounded-xl px-2 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      <ServiceMark service={service} size={40} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{service.name}</span>
        <span className="truncate text-[12px] text-text-muted">{service.blurb || service.publisher}</span>
      </span>
      {connected ? (
        <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-text-muted">
          <CheckIcon className="size-3.5" />
          Installed
        </span>
      ) : (
        !service.refusesCrew && <span className="flex h-7 shrink-0 items-center rounded-full bg-card px-3 text-[12.5px] font-medium">Install</span>
      )}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex h-16 items-center gap-3">
      <span className="size-10 shrink-0 animate-pulse rounded-[26%] bg-selected" />
      <span className="flex flex-1 flex-col gap-1.5">
        <span className="h-3 w-24 animate-pulse rounded bg-selected" />
        <span className="h-2.5 w-40 animate-pulse rounded bg-selected" />
      </span>
    </div>
  );
}

/* ── A connector before you connect it ──────────────────────────────── */

/** What it is (the registry’s words), who makes it, and the one button. Over the directory it needs no Cancel: closing it is going back. */
export function SummaryDialog({ serviceId, back = false }: { serviceId: string; back?: boolean | undefined }) {
  const service = serviceOf(serviceId);
  if (!service) return null;
  const tools = service.tools.length;
  return (
    <Dialog label={service.name}>
      <DialogHeader mark={<ServiceMark service={service} size={40} />} title={service.name} subtitle={service.publisher} />
      {service.blurb && <p className="px-5 pb-4 text-[13px] text-text-muted">{service.blurb}</p>}
      {service.refusesCrew && <p className="px-5 pb-4 text-[13px] text-warning">Only works through a CLI’s own sign-in.</p>}
      <DialogGroup>
        <DialogRow title="Server" subtitle={service.host || service.registry} />
        {tools > 0 && <DialogRow title="Tools" subtitle={`${tools} ${tools === 1 ? "tool" : "tools"}`} />}
        <DialogRow title="Registry" subtitle={service.registry} />
      </DialogGroup>
      <DialogFooter>
        {!back && (
          <Button variant="ghost" onClick={ui.close}>
            Cancel
          </Button>
        )}
        <Button variant="primary" disabled={service.refusesCrew} onClick={() => ui.open({ kind: "connect", serviceId })}>
          Install
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/* ── A custom connector ─────────────────────────────────────────────── */

type Kind = "remote" | "local";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** A name from what was typed: the host's main word, or the command's package. */
function guessName(kind: Kind, target: string): string {
  const word =
    kind === "remote"
      ? (hostOf(target).replace(/^(www|mcp|api)\./, "").split(".")[0] ?? "")
      : (target.split(/\s+/).filter((part) => !part.startsWith("-") && !["npx", "uvx", "node", "python", "bunx"].includes(part))[0] ?? "")
          .split("/")
          .pop()!
          .replace(/(^mcp-|-mcp(-server)?$|-server$)/g, "");
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : "";
}

export function CustomDialog() {
  const s = useIntegrations();
  const [kind, setKind] = useState<Kind>("remote");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState("");
  const [name, setName] = useState("");
  const target = kind === "remote" ? url.trim() : command.trim();
  const ok = kind === "remote" ? /^https?:\/\/[^\s/]+\.[^\s]+/.test(target) : target.length > 0;
  const fallback = ok ? guessName(kind, target) : "";
  const machine = machineOf(s, s.vault.machine).name;
  const add = () => {
    const label = name.trim() || fallback || "Custom";
    const host = kind === "remote" ? hostOf(target) : machine;
    const service = registerService({
      id: `custom:${target}`,
      name: label,
      registry: target,
      publisher: "Custom connector",
      host,
      glyph: label.charAt(0).toUpperCase(),
      hue: [...target].reduce((n, ch) => n + ch.charCodeAt(0) * 13, 0) % 360,
      category: "Productivity",
      blurb: "",
      transport: kind === "remote" ? "remote" : "stdio",
      tools: [],
    });
    // Remote signs in like any connector; local has nothing to sign in to.
    if (kind === "remote") ui.open({ kind: "connect", serviceId: service.id });
    else ui.land(actions.addLocal(service.id));
  };
  return (
    <Dialog label="Custom connector">
      <DialogHeader
        mark={
          <span className="grid size-10 shrink-0 place-items-center rounded-[26%] bg-card ring-1 ring-hairline">
            {kind === "remote" ? <GlobeIcon className="size-5 text-icon" /> : <TerminalIcon className="size-5 text-icon" />}
          </span>
        }
        title="Custom connector"
      />
      <form
        className="flex flex-col gap-4 px-5 pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (ok) add();
        }}
      >
        <Pills
          label="Where it runs"
          value={kind}
          onChange={setKind}
          className="self-start"
          options={[
            { value: "remote", label: "Remote", icon: <GlobeIcon className="size-3.5" /> },
            { value: "local", label: "Local", icon: <TerminalIcon className="size-3.5" /> },
          ]}
        />
        {kind === "remote" ? (
          <Field label="Server URL">
            <TextInput autoFocus value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" />
          </Field>
        ) : (
          <>
            <Field label="Command" hint={`Runs on ${machine}.`}>
              <TextInput autoFocus value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx -y @acme/mcp-server" className="font-mono text-[12.5px]" />
            </Field>
            <Field label="Environment" hint="One KEY=value per line.">
              <TextArea value={env} onChange={(event) => setEnv(event.target.value)} placeholder="ACME_API_KEY=…" className="min-h-16 font-mono text-[12.5px]" />
            </Field>
          </>
        )}
        <Field label="Name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder={fallback || "Optional"} />
        </Field>
        <button type="submit" hidden />
      </form>
      <DialogFooter
        start={
          <Button variant="ghost" onClick={ui.close}>
            Cancel
          </Button>
        }
      >
        <Button variant="primary" disabled={!ok} onClick={add}>
          Install
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
