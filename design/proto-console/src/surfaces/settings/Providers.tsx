import { PROVIDERS } from "@crew/fixtures";
import { Badge, Button, Card, ProviderMark, Row } from "@/ui";

/** Versions the daemon would report after scanning PATH. */
const VERSION: Record<string, string> = {
  claude: "2.4.1",
  cursor: "0.9.6",
  codex: "0.48.0",
  opencode: "1.2.9",
};

const MISSING = [
  { id: "gemini-cli", label: "Gemini CLI", binary: "gemini" },
  { id: "aider", label: "Aider", binary: "aider" },
  { id: "goose", label: "Goose", binary: "goose" },
];

export function Providers() {
  return (
    <>
      <Card title="Detected">
        {PROVIDERS.map((provider) => (
          <Row
            key={provider.id}
            label={
              <span className="flex items-center gap-2">
                <ProviderMark provider={provider.id} />
                <span>{provider.label}</span>
                <Badge tone="green">detected</Badge>
              </span>
            }
            description={
              <span className="font-mono text-xs text-ink-3">
                {provider.binary} · v{VERSION[provider.id] ?? "0.0.0"} · {provider.models.length}{" "}
                models
              </span>
            }
            control={
              <Button disabled title="Per-provider configuration is not built yet.">
                Configure…
              </Button>
            }
          />
        ))}
      </Card>

      <Card title="Not found">
        {MISSING.map((entry) => (
          <Row
            key={entry.id}
            label={
              <span className="flex items-center gap-2">
                <ProviderMark provider={entry.id} className="opacity-50" />
                <span className="text-ink-3">{entry.label}</span>
                <Badge>not installed</Badge>
              </span>
            }
            description={
              <span className="font-mono text-xs text-ink-4">
                {entry.binary} · no binary on PATH
              </span>
            }
            control={
              <Button disabled title="Crew does not install provider CLIs.">
                Configure…
              </Button>
            }
          />
        ))}
      </Card>

      <p className="text-sm text-ink-4">
        Discovery happens in the daemon: it scans PATH at launch, reads each binary's version and
        model list, and watches for changes while Crew runs. This page only reports what it found —
        it cannot install a CLI, and there is nothing to configure per provider yet.
      </p>
    </>
  );
}
