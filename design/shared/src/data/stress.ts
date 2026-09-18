/**
 * Deliberately hostile fixtures.
 *
 * The demo data is what the app looks like on a good day. This is what it looks
 * like after six months: a workspace with four hundred sessions, a transcript
 * with five thousand blocks, a palette over twenty thousand files, a table with
 * five hundred rows, a terminal with fifty thousand lines.
 *
 * Everything here is seeded, so two runs produce the same numbers and a
 * regression is a regression rather than a different random shape.
 */
import type { Block, ProjectFile, Session, SessionStatus, Workspace } from "../types";
import type { TerminalLine } from "./terminal";
import { NOW } from "./workspace";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** xorshift32 — same sequence every run, no dependency. */
function rng(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

const pick = <T,>(random: () => number, list: readonly T[]): T =>
  list[Math.floor(random() * list.length)]!;

const WORDS = `harness transcript adapter provider daemon session block phase approval
question routine schedule mailbox letter workspace sidebar palette surface composer
mention attachment diff patch hunk token usage stream chunk delta cursor viewport
virtualiser observer reducer selector memo layout paint reflow budget threshold
invariant contract schema migration index snapshot replay envelope roster lineage`
  .split(/\s+/)
  .filter(Boolean);

function sentence(random: () => number, min = 6, max = 22): string {
  const n = min + Math.floor(random() * (max - min));
  const words = Array.from({ length: n }, () => pick(random, WORDS));
  const first = words[0]!;
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return `${words.join(" ")}.`;
}

function paragraph(random: () => number, sentences = 4): string {
  return Array.from({ length: sentences }, () => sentence(random)).join(" ");
}

const PATH_PARTS = ["src", "lib", "chrome", "surfaces", "hooks", "crates", "core", "providers", "ui", "app"];
const EXTENSIONS = ["ts", "tsx", "rs", "css", "md", "json", "toml", "mjs"];

function fakePath(random: () => number): string {
  const depth = 2 + Math.floor(random() * 4);
  const parts = Array.from({ length: depth }, () => pick(random, PATH_PARTS));
  return `${parts.join("/")}/${pick(random, WORDS)}.${pick(random, EXTENSIONS)}`;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export type StressThreadOptions = {
  /** How many blocks to produce. */
  blocks?: number;
  seed?: number;
  /** Span the timestamps over this many days, ending now. */
  days?: number;
  /** Fraction of blocks that are tool calls. Long agent runs are mostly tools. */
  toolRatio?: number;
};

/**
 * A transcript with a realistic block mix: mostly tool calls, punctuated by
 * reasoning, replies and the occasional approval or letter from another agent.
 *
 * The point of the mix is that it exercises grouping, not just row count — a
 * thousand identical rows fold into one line and prove nothing.
 */
export function stressThread(options: StressThreadOptions = {}): Block[] {
  const { blocks: total = 2_000, seed = 7, days = 30, toolRatio = 0.62 } = options;
  const random = rng(seed);
  const start = NOW - days * DAY;
  const step = (days * DAY) / Math.max(total, 1);
  const out: Block[] = [];
  let at = start;
  let calls = 0;

  for (let i = 0; i < total; i += 1) {
    at += step * (0.4 + random() * 1.2);
    const id = `stress-${seed}-${i}`;
    const roll = random();

    if (roll < toolRatio) {
      calls += 1;
      const kind = random();
      if (kind < 0.42) {
        const path = fakePath(random);
        out.push({
          id,
          role: "tool",
          text: `Read ${path}`,
          at,
          tool: {
            callId: `c-${id}`,
            name: "Read",
            title: `Read ${path}`,
            status: "completed",
            detail: {
              kind: "file",
              path: `/Users/you/crew/${path}`,
              lineStart: 1,
              lineEnd: 40 + Math.floor(random() * 300),
              ...(random() < 0.25 ? { preview: paragraph(random, 8) } : {}),
            },
          },
        });
      } else if (kind < 0.68) {
        const command = `npm run ${pick(random, ["test", "lint", "build", "check", "doctor"])}`;
        const failed = random() < 0.12;
        out.push({
          id,
          role: "tool",
          text: command,
          at,
          tool: {
            callId: `c-${id}`,
            name: "Bash",
            title: command,
            status: failed ? "failed" : "completed",
            detail: {
              kind: "command",
              command,
              exitCode: failed ? 1 : 0,
              output: Array.from({ length: 4 + Math.floor(random() * 30) }, () =>
                sentence(random, 4, 14),
              ).join("\n"),
            },
          },
        });
      } else if (kind < 0.86) {
        const path = fakePath(random);
        out.push({
          id,
          role: "tool",
          text: `Edit ${path}`,
          at,
          tool: {
            callId: `c-${id}`,
            name: "Edit",
            title: `Edit ${path}`,
            status: "completed",
            detail: {
              kind: "edit",
              path: `/Users/you/crew/${path}`,
              added: 1 + Math.floor(random() * 80),
              removed: Math.floor(random() * 40),
            },
          },
        });
      } else {
        const query = pick(random, WORDS);
        out.push({
          id,
          role: "tool",
          text: `Grep ${query}`,
          at,
          tool: {
            callId: `c-${id}`,
            name: "Grep",
            title: `Grep ${query}`,
            status: "completed",
            detail: { kind: "search", query, matches: Math.floor(random() * 200) },
          },
        });
      }
      continue;
    }

    if (roll < toolRatio + 0.12) {
      out.push({ id, role: "reasoning", text: paragraph(random, 3 + Math.floor(random() * 6)), at });
      continue;
    }

    if (roll < toolRatio + 0.2) {
      out.push({
        id,
        role: "user",
        text: sentence(random, 5, 30),
        at,
        ...(random() < 0.15
          ? {
              files: [
                {
                  name: "capture.png",
                  path: "/tmp/capture.png",
                  kind: "image" as const,
                  size: 120_000,
                },
              ],
            }
          : {}),
      });
      continue;
    }

    if (roll < toolRatio + 0.23) {
      out.push({
        id,
        role: "user",
        text: paragraph(random, 2),
        at,
        fromAgent: { id: "s-relay", name: "Relay" },
      });
      continue;
    }

    if (roll < toolRatio + 0.25) {
      out.push({
        id,
        role: "approval",
        text: `Edit ${fakePath(random)}`,
        at,
        approval: {
          requestId: i,
          name: "Edit",
          input: { file_path: fakePath(random) },
          decided: random() < 0.85 ? "allow" : "deny",
        },
      });
      continue;
    }

    const long = random() < 0.25;
    out.push({
      id,
      role: "assistant",
      text: long
        ? `## ${sentence(random, 3, 6)}\n\n${paragraph(random, 6)}\n\n${bulletList(random)}\n\n\`\`\`ts\n${codeBody(random)}\n\`\`\`\n\n${paragraph(random, 4)}`
        : paragraph(random, 2 + Math.floor(random() * 4)),
      at,
      usage: {
        inputTokens: 8_000 + Math.floor(random() * 90_000),
        outputTokens: 100 + Math.floor(random() * 2_000),
        costUsd: Number((random() * 0.9).toFixed(4)),
        durationMs: 3_000 + Math.floor(random() * 240_000),
      },
    });
  }

  void calls;
  return out;
}

function bulletList(random: () => number): string {
  return Array.from({ length: 3 + Math.floor(random() * 5) }, () => `- ${sentence(random, 5, 16)}`).join("\n");
}

function codeBody(random: () => number): string {
  return Array.from({ length: 6 + Math.floor(random() * 14) }, (_, i) =>
    i % 4 === 0
      ? `export function ${pick(random, WORDS)}(${pick(random, WORDS)}: string) {`
      : i % 4 === 3
        ? "}"
        : `  const ${pick(random, WORDS)} = ${pick(random, WORDS)}.${pick(random, WORDS)}();`,
  ).join("\n");
}

// ---------------------------------------------------------------------------
// Sessions, workspaces, files
// ---------------------------------------------------------------------------

const STATUSES: SessionStatus[] = ["idle", "working", "needs-input", "done", "error"];
const PROVIDERS = ["claude", "cursor", "codex", "opencode"];
const MODELS: Record<string, string[]> = {
  claude: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  cursor: ["auto", "composer-2.5", "cursor-grok-4.6-high"],
  codex: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna"],
  opencode: ["opencode/ling-3.0-flash-fin-free", "opencode/mimo-v2.5-free"],
};

/**
 * `count` sessions in one workspace, with a lineage tree so the list is not flat:
 * every fourth agent is created by an earlier one.
 */
export function stressSessions(count = 400, workspaceId = "ws-crew", seed = 11): Session[] {
  const random = rng(seed);
  const out: Session[] = [];
  for (let i = 0; i < count; i += 1) {
    const provider = pick(random, PROVIDERS);
    const kind = random() < 0.78 ? "agent" : "terminal";
    const parent = i > 3 && random() < 0.35 ? out[Math.floor(random() * i)] : undefined;
    out.push({
      id: `stress-s-${i}`,
      workspaceId,
      kind,
      name: `${pick(random, WORDS)}-${i}`,
      provider,
      model: kind === "agent" ? pick(random, MODELS[provider] ?? ["auto"]) : "",
      providerSessionId: random() < 0.7 ? `prov_${i}` : null,
      description: kind === "agent" ? sentence(random, 6, 18) : "",
      notifications: random() < 0.5,
      autonomy: random() < 0.4 ? "full" : "ask",
      status: pick(random, STATUSES),
      createdAt: NOW - Math.floor(random() * 90) * DAY,
      updatedAt: NOW - Math.floor(random() * 72) * HOUR,
      createdBy:
        parent && parent.kind === "agent" ? { id: parent.id, name: parent.name } : null,
    });
  }
  return out;
}

export function stressWorkspaces(count = 40, seed = 13): Workspace[] {
  const random = rng(seed);
  return Array.from({ length: count }, (_, i) => ({
    id: `stress-ws-${i}`,
    name: `${pick(random, WORDS)}-${i}`,
    path: `/Users/you/work/${pick(random, WORDS)}-${i}`,
    createdAt: NOW - Math.floor(random() * 400) * DAY,
  }));
}

/** A monorepo's worth of files, for the palette's fuzzy ranking. */
export function stressFiles(count = 20_000, seed = 17): ProjectFile[] {
  const random = rng(seed);
  const out: ProjectFile[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const relative = fakePath(random);
    out[i] = {
      relative,
      path: `/Users/you/crew/${relative}`,
      name: relative.split("/").pop() ?? relative,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pathological content
// ---------------------------------------------------------------------------

/** A table wider and longer than any transcript column. Must scroll, not stretch. */
export function hugeTable(rows = 500, columns = 12, seed = 19): string {
  const random = rng(seed);
  const head = Array.from({ length: columns }, (_, c) => `${pick(random, WORDS)}_${c}`);
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const body = Array.from({ length: rows }, (_, r) =>
    line(Array.from({ length: columns }, (_, c) => (c === 0 ? `row-${r}` : pick(random, WORDS)))),
  );
  return [line(head), line(head.map(() => "---")), ...body].join("\n");
}

/** Deeply nested lists, long unbroken tokens, and every inline mark at once. */
export function pathologicalMarkdown(seed = 23): string {
  const random = rng(seed);
  const nest = (depth: number): string =>
    depth === 0
      ? ""
      : `${"  ".repeat(6 - depth)}- ${sentence(random, 4, 12)}\n${nest(depth - 1)}`;
  return [
    "# Pathological",
    "",
    paragraph(random, 10),
    "",
    nest(6),
    "",
    "A token that cannot wrap: `" + "x".repeat(400) + "`",
    "",
    "A URL that cannot wrap: https://example.com/" + "segment/".repeat(60),
    "",
    "> " + paragraph(random, 8),
    "> ",
    "> > " + paragraph(random, 6),
    "> > ",
    "> > > " + paragraph(random, 4),
    "",
    hugeTable(120, 16, seed + 1),
    "",
    "```ts",
    Array.from({ length: 400 }, (_, i) => `const line${i} = ${JSON.stringify(sentence(random, 6, 18))};`).join("\n"),
    "```",
    "",
    Array.from({ length: 40 }, (_, i) => `${i + 1}. ${sentence(random, 6, 20)}`).join("\n"),
  ].join("\n");
}

/** Fifty thousand terminal lines, of the shape a real build produces. */
export function hugeTerminal(lines = 50_000, seed = 29): TerminalLine[] {
  const random = rng(seed);
  const out: TerminalLine[] = new Array(lines);
  for (let i = 0; i < lines; i += 1) {
    const roll = random();
    if (roll < 0.06) {
      out[i] = [
        { text: "   Compiling ", tone: "dim" },
        { text: pick(random, WORDS), tone: "accent" },
        { text: ` v0.${Math.floor(random() * 9)}.${Math.floor(random() * 9)}`, tone: "dim" },
      ];
    } else if (roll < 0.1) {
      out[i] = [
        { text: "warning", tone: "warn" },
        { text: `: ${sentence(random, 4, 12)}` },
      ];
    } else if (roll < 0.12) {
      out[i] = [{ text: "error", tone: "error" }, { text: `: ${sentence(random, 4, 12)}` }];
    } else if (roll < 0.16) {
      out[i] = [{ text: `  ${fakePath(random)}:${Math.floor(random() * 900)}`, tone: "path" }];
    } else {
      out[i] = [{ text: sentence(random, 6, 26), tone: roll < 0.4 ? "dim" : "default" }];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presets — what the stress harness drives
// ---------------------------------------------------------------------------

export const STRESS_PRESETS = {
  /** A working day's transcript. Should be indistinguishable from the demo data. */
  light: { blocks: 500, sessions: 40, files: 2_000 },
  /** A month. Folding and memoisation start to matter. */
  medium: { blocks: 2_000, sessions: 150, files: 8_000 },
  /** Six months and a big monorepo. This is the one that finds the bugs. */
  heavy: { blocks: 5_000, sessions: 400, files: 20_000 },
  /** Not realistic. Proves the ceiling and where it is. */
  absurd: { blocks: 20_000, sessions: 1_200, files: 60_000 },
} as const;

export type StressPreset = keyof typeof STRESS_PRESETS;

export type StressWorld = {
  preset: StressPreset;
  sessions: Session[];
  workspaces: Workspace[];
  files: ProjectFile[];
  threads: Record<string, Block[]>;
};

/**
 * A whole workspace at a given size. Only the first three sessions get a
 * transcript — building four hundred of them would measure the generator rather
 * than the UI.
 *
 * Every field is built on first read and cached. Eagerly, `heavy` means twenty
 * thousand paths and fifteen thousand blocks in one synchronous burst, which
 * showed up in a performance trace as a 250ms long task the prototypes were
 * being blamed for. A surface that never opens the palette should not pay for
 * twenty thousand files.
 */
export function stressWorld(preset: StressPreset = "heavy"): StressWorld {
  const spec = STRESS_PRESETS[preset];
  let sessions: Session[] | null = null;
  let workspaces: Workspace[] | null = null;
  let files: ProjectFile[] | null = null;
  const threads: Record<string, Block[]> = {};
  let threadProxy: Record<string, Block[]> | null = null;

  const allSessions = () => (sessions ??= stressSessions(spec.sessions));

  return {
    preset,
    get sessions() {
      return allSessions();
    },
    get workspaces() {
      return (workspaces ??= stressWorkspaces());
    },
    get files() {
      return (files ??= stressFiles(spec.files));
    },
    get threads() {
      // A Proxy so `threads[id]` builds only the transcript that was asked for,
      // while `Object.keys` still reports the three that exist.
      return (threadProxy ??= new Proxy(threads, {
        ownKeys: () => allSessions().slice(0, 3).map((s) => s.id),
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        has: (_target, key) =>
          typeof key === "string" && allSessions().slice(0, 3).some((s) => s.id === key),
        get(target, key) {
          if (typeof key !== "string") return undefined;
          if (key in target) return target[key];
          const index = allSessions()
            .slice(0, 3)
            .findIndex((session) => session.id === key);
          if (index < 0) return undefined;
          target[key] = stressThread({ blocks: spec.blocks, seed: 7 + index });
          return target[key];
        },
      }));
    },
  };
}
