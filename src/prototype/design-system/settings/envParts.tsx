// PROTOTYPE — throwaway. The small pieces a machine is drawn with on both
// Environments and Providers: its glyph, the tone of its state, its dot.
import { LaptopIcon, ServerIcon } from "lucide-react";
import { stateLabel, toneOf, type EnvMock } from "./envMock";
import { Chip, type Tone } from "./ui";

const DOT: Record<Tone, string> = {
  success: "bg-success",
  info: "bg-info",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-text-muted/60",
  accent: "bg-accent",
};

export function EnvGlyph({ env, className = "size-4" }: { env: EnvMock; className?: string }) {
  const Glyph = env.kind === "local" ? LaptopIcon : ServerIcon;
  return <Glyph aria-hidden className={`shrink-0 ${className}`} />;
}

export function StateDot({ env, className = "size-1.5" }: { env: EnvMock; className?: string }) {
  const tone = toneOf(env);
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-full ${DOT[tone]} ${env.state === "connecting" || env.busy ? "animate-pulse motion-reduce:animate-none" : ""} ${className}`}
    />
  );
}

export function StateChip({ env }: { env: EnvMock }) {
  return <Chip tone={toneOf(env)}>{stateLabel(env)}</Chip>;
}
