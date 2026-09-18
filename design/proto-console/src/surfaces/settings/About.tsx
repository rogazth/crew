import { Card, Row } from "@/ui";
import { store } from "@/lib/store";

const BUILD = "console · 8f21c4a · 2026-09-18";

export function About() {
  return (
    <>
      <Card title="Build">
        <Row
          label="Version"
          description="Prototype, not a release. Nothing here writes to disk except your preferences."
          control={<span className="font-mono text-sm text-ink">0.1.0</span>}
        />
        <Row
          label="Build"
          description="The commit this window was bundled from."
          control={<span className="font-mono text-sm text-ink-3">{BUILD}</span>}
        />
        <Row
          label="Stack"
          description="One window, one daemon. The daemon owns the provider CLIs and outlives the window."
          control={
            <span className="font-mono text-sm text-ink-3">Electron · React 19 · Rust daemon</span>
          }
        />
      </Card>

      <Card title="Links">
        <Row
          label={
            <button
              type="button"
              onClick={() => store.notify("No update feed yet — the daemon does not check for releases.")}
              className="text-accent-ink hover:underline"
            >
              Release notes
            </button>
          }
          description="There is no update feed yet, so this only says so rather than opening an empty page."
        />
        <Row
          label={
            <button
              type="button"
              onClick={() => store.notify("Logs live in ~/Library/Logs/crew — not readable from here yet.")}
              className="text-accent-ink hover:underline"
            >
              Open daemon logs
            </button>
          }
          description="The log viewer is not built. The files are on disk under ~/Library/Logs/crew."
        />
      </Card>

      <p className="text-sm text-ink-4">
        Three prototypes explore the same application: Ink, Console and Canvas. This window is
        Console — near-monochrome, mono where mono means something, zero elevation. The other two
        are separate builds.
      </p>
    </>
  );
}
