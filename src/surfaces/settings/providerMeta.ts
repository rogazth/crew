// What the Providers page says about each CLI that the machine does not:
// its name, its maker, and the command each install method runs (the daemon
// runs the real one; this is the preview shown before it starts).
import type { ProviderJobMethod } from "../../lib/protocol";
import type { ProviderId } from "../../lib/providers";

export type ProviderMeta = {
  name: string;
  vendor: string;
  blurb: string;
  install: Partial<Record<ProviderJobMethod, string>>;
};

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  claude: {
    name: "Claude Code",
    vendor: "Anthropic",
    blurb: "Fable, Opus, Sonnet and Haiku",
    install: {
      npm: "npm install -g @anthropic-ai/claude-code",
      brew: "brew install --cask claude-code",
      script: "curl -fsSL https://claude.ai/install.sh | bash",
    },
  },
  codex: {
    name: "Codex",
    vendor: "OpenAI",
    blurb: "GPT-6 and GPT-5.6",
    install: { npm: "npm install -g @openai/codex", brew: "brew install codex" },
  },
  opencode: {
    name: "OpenCode",
    vendor: "SST",
    blurb: "Open source, any model you have a key for",
    install: {
      npm: "npm install -g @opencode/cli",
      brew: "brew install anomalyco/tap/opencode-v2",
      script: "curl -fsSL https://opencode.ai/install | bash",
    },
  },
  cursor: {
    name: "Cursor",
    vendor: "Anysphere",
    blurb: "Models from many vendors, one subscription",
    install: { script: "curl https://cursor.com/install -fsS | bash" },
  },
};

export const METHOD_LABELS: Record<ProviderJobMethod, string> = {
  npm: "npm",
  brew: "Homebrew",
  script: "Install script",
  native: "Built-in",
};
