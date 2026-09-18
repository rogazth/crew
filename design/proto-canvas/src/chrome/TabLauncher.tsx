import { useMemo, useState } from "react";
import { STUB_KINDS, STUB_LABELS, commandKeys, rankBy } from "@crew/fixtures";
import { cx } from "@/lib/cx";
import { useStore } from "@/lib/store";
import { Avatar } from "@/ui/Avatar";
import { IconButton } from "@/ui/Button";
import { Icon, type GlyphName } from "@/ui/Icon";
import { Input } from "@/ui/Input";
import { Kbd } from "@/ui/Kbd";
import { Pop } from "@/ui/Popover";

const STUB_ICON: Record<string, GlyphName> = {
  terminal: "terminal",
  browser: "globe",
  sidechat: "bot",
};

export function TabLauncher() {
  const { launcher, setLauncher, wsSessions, openSession, openStub, setDrawer, statusOf } = useStore();
  const [query, setQuery] = useState("");

  const matches = useMemo(
    () => rankBy(wsSessions, query, (session) => session.name).slice(0, 8),
    [query, wsSessions],
  );

  const close = () => {
    setLauncher(false);
    setQuery("");
  };

  return (
    <Pop
      open={launcher}
      onOpenChange={(open) => (open ? setLauncher(true) : close())}
      align="end"
      width={320}
      className="p-1.5"
      trigger={
        <IconButton icon="plus" label={`New tab (${commandKeys("open-launcher")})`} size="sm" variant="ghost" className="shrink-0" />
      }
    >
      <div className="p-1">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Open…"
          className="h-8"
          leading={<Icon name="search" size={14} className="text-ink-38" />}
        />
      </div>

      <div className="flex flex-col gap-0.5 p-1">
        <LauncherRow
          icon="plus"
          label="New agent"
          keys={commandKeys("new-agent")}
          onClick={() => {
            close();
            setDrawer({ kind: "agent-sheet", mode: "create" });
          }}
        />
        {STUB_KINDS.map((stub) => (
          <LauncherRow
            key={stub}
            icon={STUB_ICON[stub] ?? "square"}
            label={STUB_LABELS[stub] ?? stub}
            onClick={() => {
              close();
              openStub(stub, STUB_LABELS[stub] ?? stub);
            }}
          />
        ))}
      </div>

      {matches.length > 0 && (
        <>
          <div className="my-1 h-px bg-[var(--line-soft)]" />
          <div className="px-2.5 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-38">
            Sessions
          </div>
          <div className="flex flex-col gap-0.5 p-1">
            {matches.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => {
                  close();
                  openSession(session.id);
                }}
                className="rise-1 flex h-9 items-center gap-2.5 rounded-[8px] px-2 text-base text-ink hover:bg-sunken"
              >
                {session.kind === "terminal" ? (
                  <span className="grid size-6 place-items-center rounded-chip bg-sunken text-ink-52">
                    <Icon name="terminal" size={14} />
                  </span>
                ) : (
                  <Avatar seed={session.name} size={24} status={statusOf(session.id)} />
                )}
                <span className="flex-1 truncate text-left">{session.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Pop>
  );
}

function LauncherRow({
  icon,
  label,
  keys,
  onClick,
}: {
  icon: GlyphName;
  label: string;
  keys?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx("rise-1 flex h-8 items-center gap-2.5 rounded-[8px] px-2 text-base text-ink hover:bg-sunken")}
    >
      <Icon name={icon} size={15} className="opacity-70" />
      <span className="flex-1 text-left">{label}</span>
      {keys && <Kbd>{keys}</Kbd>}
    </button>
  );
}
