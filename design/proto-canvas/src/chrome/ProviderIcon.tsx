import { Icon, type GlyphName } from "@/ui/Icon";

const GLYPH: Record<string, GlyphName> = {
  claude: "sparkles",
  cursor: "code",
  codex: "braces",
  opencode: "terminal",
};

export function ProviderIcon({ provider, size = 14, className }: { provider: string; size?: number; className?: string }) {
  return <Icon name={GLYPH[provider] ?? "bot"} size={size} className={className} />;
}
