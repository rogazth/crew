import { Menu } from "@base-ui/react/menu";
import { BrainIcon, CheckIcon, ChevronDownIcon, LockIcon, LockOpenIcon, PencilIcon, SparklesIcon, type LucideIcon as Icon } from "lucide-react";
import { PANEL, ROW } from "./kit";
import { ModelPicker } from "./ModelPicker";
import {
  ACCESSES,
  EFFORT_LABELS,
  accessesOf,
  effortsOf,
  fitChoice,
  type Access,
  type AgentChoice,
  type Effort,
  type ProviderId,
} from "../lib/providers";

const ACCESS_ICONS: Record<Access, Icon> = { ask: LockIcon, edits: PencilIcon, auto: SparklesIcon, full: LockOpenIcon };

const CHIP =
  "flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] leading-4 text-text ring-1 ring-hairline outline-none transition-colors duration-100 hover:bg-hover focus-visible:ring-focus/50 data-popup-open:bg-hover";

type Props = {
  value: AgentChoice;
  onChange: (next: AgentChoice) => void;
  /** A running session keeps its CLI: only its models are offered. */
  lockProvider?: boolean;
};

/** The composer's model, effort and access chips, the same in Home and in a chat. */
export function ModelControls({ value, onChange, lockProvider = false }: Props) {
  const efforts = effortsOf(value.provider, value.model);
  return (
    <>
      <ModelPicker
        trigger="chip"
        provider={value.provider}
        model={value.model}
        lockProvider={lockProvider}
        onChange={(provider: ProviderId, model) => onChange(fitChoice({ ...value, provider, model }))}
      />
      {efforts.length > 0 && (
        <EffortPicker value={value.effort} efforts={efforts} onChange={(effort) => onChange(fitChoice({ ...value, effort }))} />
      )}
    </>
  );
}

export function EffortPicker({
  value,
  efforts,
  onChange,
}: {
  value: Effort | "";
  efforts: Effort[];
  onChange: (effort: Effort) => void;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger aria-label="Effort" title="How hard the model thinks" className={CHIP}>
        <BrainIcon className="size-3.5 shrink-0 text-icon" />
        <span className="truncate">{value ? EFFORT_LABELS[value] : "Effort"}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-icon" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={4} className="z-50">
          <Menu.Popup className={PANEL}>
            <div className="px-2 pt-1 pb-1.5 text-[11px] text-text-muted">Effort</div>
            <Menu.RadioGroup value={value} onValueChange={(next) => onChange(next as Effort)}>
              {efforts.map((id) => (
                <Menu.RadioItem key={id} value={id} closeOnClick className={ROW}>
                  <span className="min-w-0 flex-1 truncate">{EFFORT_LABELS[id]}</span>
                  <Menu.RadioItemIndicator>
                    <CheckIcon className="size-4 shrink-0" />
                  </Menu.RadioItemIndicator>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function AccessPicker({
  provider,
  value,
  onChange,
  hint,
}: {
  provider: string;
  value: Access;
  onChange: (access: Access) => void;
  /** A line under the list: what ⇧Tab does here. */
  hint?: string;
}) {
  const offered = accessesOf(provider);
  const current = ACCESSES.find((a) => a.id === value) ?? ACCESSES[0]!;
  const Glyph = ACCESS_ICONS[current.id];
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger aria-label="Access" title={current.description} className={CHIP}>
        <Glyph className="size-3.5 shrink-0 text-icon" />
        <span className="truncate">{current.label}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-icon" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={`${PANEL} w-76`}>
            <div className="px-2 pt-1 pb-1.5 text-[11px] text-text-muted">Access</div>
            <Menu.RadioGroup value={value} onValueChange={(next) => onChange(next as Access)}>
              {ACCESSES.filter((a) => offered.includes(a.id)).map((access) => {
                const Row = ACCESS_ICONS[access.id];
                return (
                  <Menu.RadioItem key={access.id} value={access.id} closeOnClick className={`${ROW} h-auto items-start py-1.5`}>
                    <Row className="mt-0.5 size-4 shrink-0 text-icon" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{access.label}</span>
                      <span className="text-[12px] leading-snug whitespace-normal text-text-muted">{access.description}</span>
                    </span>
                    <Menu.RadioItemIndicator className="mt-0.5">
                      <CheckIcon className="size-4 shrink-0" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                );
              })}
            </Menu.RadioGroup>
            {hint && <div className="px-2 pt-1.5 pb-1 text-[11px] text-text-muted">{hint}</div>}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
