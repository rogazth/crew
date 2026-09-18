import type { Block, Question, ToolStatus } from "../types";
import { MARKDOWN_KITCHEN_SINK, PLAN_REPLY, SHORT_REPLY } from "./markdown";
import { NOW } from "./workspace";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let seq = 0;
const id = (prefix: string) => `${prefix}-${(seq += 1)}`;

type Partial_ = Omit<Block, "id" | "role" | "text">;

const user = (text: string, at: number, extra: Partial_ = {}): Block => ({
  id: id("u"),
  role: "user",
  text,
  at,
  ...extra,
});

const assistant = (text: string, at: number, extra: Partial_ = {}): Block => ({
  id: id("a"),
  role: "assistant",
  text,
  at,
  ...extra,
});

const reasoning = (text: string, at: number): Block => ({
  id: id("r"),
  role: "reasoning",
  text,
  at,
});

const note = (text: string, at: number): Block => ({ id: id("n"), role: "system", text, at });

type ToolArgs = {
  name: string;
  title: string;
  at: number;
  status?: ToolStatus;
  detail?: NonNullable<Block["tool"]>["detail"];
  usage?: Block["usage"];
};

const tool = ({ name, title, at, status = "completed", detail, usage }: ToolArgs): Block => ({
  id: id("t"),
  role: "tool",
  text: title,
  at,
  tool: { callId: id("call"), name, title, status, ...(detail ? { detail } : {}) },
  ...(usage ? { usage } : {}),
});

const cmd = (command: string, at: number, output?: string, exitCode = 0) =>
  tool({
    name: "Bash",
    title: command,
    at,
    status: exitCode === 0 ? "completed" : "failed",
    detail: { kind: "command", command, exitCode, ...(output ? { output } : {}) },
  });

const read = (path: string, at: number, preview?: string, lineStart?: number, lineEnd?: number) =>
  tool({
    name: "Read",
    title: `Read ${path}`,
    at,
    detail: {
      kind: "file",
      path,
      ...(preview ? { preview } : {}),
      ...(lineStart !== undefined ? { lineStart } : {}),
      ...(lineEnd !== undefined ? { lineEnd } : {}),
    },
  });

const edit = (path: string, at: number, added: number, removed: number, diff?: string) =>
  tool({
    name: "Edit",
    title: `Edit ${path}`,
    at,
    detail: { kind: "edit", path, added, removed, ...(diff ? { diff } : {}) },
  });

const grep = (query: string, at: number, matches: number) =>
  tool({ name: "Grep", title: `Grep ${query}`, at, detail: { kind: "search", query, matches } });

const fetchUrl = (url: string, at: number, title: string) =>
  tool({ name: "WebFetch", title: `Fetch ${url}`, at, detail: { kind: "fetch", url, title } });

const messageTo = (to: string, text: string, at: number) =>
  tool({ name: "message_agent", title: `Message ${to}`, at, detail: { kind: "message", to, text } });

/**
 * A Crew tool the daemon does not normalise, so it arrives with arguments and no
 * detail — exactly as the real thing does. `crewToolLine` is what makes it read.
 */
const crewCall = (
  name: string,
  args: Record<string, unknown>,
  at: number,
  status: ToolStatus = "completed",
): Block => ({
  id: id("t"),
  role: "tool",
  // What a provider that titles a call with its input actually sends. This is
  // the row that reads `{` in the app today.
  text: JSON.stringify(args).slice(0, 40),
  at,
  tool: {
    callId: id("call"),
    name: `mcp__crew__${name}`,
    title: JSON.stringify(args).slice(0, 40),
    status,
    args,
  },
});

/** An outbound letter whose twin never arrives: the target is busy, so it waits. */
const messageWaiting = (to: string, text: string, at: number) =>
  crewCall("message_agent", { to, text }, at);

const approval = (
  name: string,
  title: string,
  at: number,
  input: Record<string, unknown>,
  decided?: "allow" | "always" | "deny",
): Block => ({
  id: id("ap"),
  role: "approval",
  text: title,
  at,
  approval: { requestId: (seq += 1), name, input, ...(decided ? { decided } : {}) },
});

const question = (
  at: number,
  questions: Question[],
  answers?: Record<string, string>,
  dismissed?: boolean,
): Block => ({
  id: id("q"),
  role: "question",
  text: questions[0]?.header ?? "Question",
  at,
  question: {
    requestId: (seq += 1),
    questions,
    ...(answers ? { answers } : {}),
    ...(dismissed ? { dismissed: true } : {}),
  },
});

const fromAgent = (name: string, agentId: string, text: string, at: number, extra: Partial_ = {}): Block => ({
  id: id("fa"),
  role: "user",
  text,
  at,
  fromAgent: { id: agentId, name },
  ...extra,
});

// ---------------------------------------------------------------------------
// Sample payloads
// ---------------------------------------------------------------------------

const LINT_OUTPUT = `
> crew@0.1.0 lint
> eslint src

/Users/you/crew/src/surfaces/chat/Activity.tsx
  312:8  warning  React Hook useEffect has a missing dependency: 'advance'  react-hooks/exhaustive-deps

✖ 1 problem (0 errors, 1 warning)
`.trim();

const TEST_OUTPUT = `
 RUN  v3.2.7 /Users/you/crew

 ✓ src/lib/tabs.test.ts (14 tests) 6ms
 ✓ src/lib/blocks.test.ts (11 tests) 9ms
 ✓ src/lib/transcript.test.ts (18 tests) 22ms
 ✓ src/lib/toolDetail.test.ts (16 tests) 7ms
 ✓ src/lib/activity.test.ts (12 tests) 5ms
 ✓ src/lib/routines.test.ts (21 tests) 14ms
 ✓ src/lib/cron.test.ts (9 tests) 3ms
 ✓ src/lib/fuzzy.test.ts (6 tests) 2ms

 Test Files  8 passed (8)
      Tests  107 passed (107)
   Start at  02:14:09
   Duration  1.28s
`.trim();

const CARGO_FAIL = `
   Compiling crew-core v0.1.0 (/Users/you/crew/crates/crew-core)
error[E0308]: mismatched types
   --> crates/crew-core/src/providers/mod.rs:184:24
    |
184 |         Some(ToolDetail::Message { to: raw.target, text })
    |                                        ^^^^^^^^^^ expected \`String\`, found \`Option<String>\`
    |
help: consider using \`unwrap_or_default\`
    |
184 |         Some(ToolDetail::Message { to: raw.target.unwrap_or_default(), text })
    |                                                  +++++++++++++++++++++

error: could not compile \`crew-core\` (lib) due to 1 previous error
`.trim();

const PROVIDERS_PREVIEW = `pub enum ToolDetail {
    Command { command: String, exit_code: Option<i32>, output: Option<String> },
    File { path: String, line_start: Option<u32>, line_end: Option<u32>, preview: Option<String> },
    Edit { path: String, added: Option<u32>, removed: Option<u32> },
    Search { query: String, matches: Option<u32> },
    Fetch { url: String, title: Option<String> },
    Message { to: String, text: String },
    Output { text: String },
}`;

const TOOLDETAIL_DIFF = `@@ -44,9 +44,14 @@ export function toolLine(block: Block): ToolLine {
 export function toolLine(block: Block): ToolLine {
   const detail = detailOf(block);
   const failed = block.tool?.status === "failed";
-  const title = block.tool?.title ?? block.text;
-  if (!detail) return { text: title, mono: false, failed };
+  const title = (block.tool?.title ?? block.text).trim();
+  if (!detail) {
+    // A provider that sent no detail still owes the reader a sentence; the raw
+    // input is how "{" reached the screen.
+    const readable = title && !title.startsWith("{") ? title : null;
+    return { text: readable ?? \`Used \${block.tool?.name ?? "a tool"}\`, mono: false, failed };
+  }

   switch (detail.kind) {
     case "command": {`;

// ---------------------------------------------------------------------------
// Thread 1 — harness: the long one. Three days, every block kind.
// ---------------------------------------------------------------------------

const t0 = NOW - 3 * DAY - 2 * HOUR;
const t1 = NOW - 1 * DAY - 5 * HOUR;
const t2 = NOW - 55 * MIN;

export const harnessThread: Block[] = [
  user("Tomemos el seam multi-provider en serio. Quiero que un tool call de codex y uno de claude se vean idénticos en el transcript.", t0),
  reasoning(
    "The renderer already has a normalised ToolDetail type, but only the Claude adapter fills it. Codex sends exec_command with a different envelope and opencode sends bare names. The right fix is in Rust, at the adapter boundary, not in the renderer. Let me read what exists first.",
    t0 + 4_000,
  ),
  read("crates/crew-core/src/providers/mod.rs", t0 + 6_000, PROVIDERS_PREVIEW, 1, 42),
  read("src/lib/toolDetail.ts", t0 + 9_000, undefined, 1, 60),
  grep("ToolDetail::", t0 + 11_000, 34),
  grep("exec_command", t0 + 12_000, 7),
  assistant(
    `El tipo ya existe en Rust y en TS, pero sólo el adaptador de Claude lo llena. Codex manda \`exec_command\` con otro sobre y opencode manda sólo el nombre.

Tres pasos:

1. \`providers/mod.rs\` — una función \`normalise(raw) -> Option<ToolDetail>\` que cada adaptador llama antes de emitir \`tool.started\`.
2. \`providers/codex.rs\` — mapear \`exec_command\`, \`apply_patch\` y \`read_file\`.
3. \`toolDetail.ts\` — que la ausencia de detail nunca imprima el input crudo.

Empiezo por el 1.`,
    t0 + 20_000,
    { usage: { inputTokens: 18_400, outputTokens: 620, costUsd: 0.0912, durationMs: 21_000 } },
  ),

  user("Dale. Y por favor arregla lo del `{`, se ve horrible.", t0 + 4 * MIN),
  reasoning("The `{` comes from toolLine falling back to block.text when no detail exists, and block.text is the provider's raw JSON input for providers that don't send a title. Guard it.", t0 + 4 * MIN + 3_000),
  read("src/lib/toolDetail.ts", t0 + 4 * MIN + 5_000, undefined, 40, 70),
  edit("src/lib/toolDetail.ts", t0 + 4 * MIN + 12_000, 6, 2, TOOLDETAIL_DIFF),
  edit("src/lib/toolDetail.test.ts", t0 + 4 * MIN + 16_000, 18, 0),
  cmd("npm run test -- toolDetail", t0 + 4 * MIN + 20_000, TEST_OUTPUT),
  assistant(
    `Arreglado. \`toolLine\` ahora garantiza una frase: si el proveedor no manda \`detail\` ni un título legible, la fila dice \`Used <nombre de la tool>\` en vez del input crudo.

Dos tests nuevos cubren el caso: input que empieza con \`{\`, y título vacío.`,
    t0 + 4 * MIN + 24_000,
    { usage: { inputTokens: 21_100, outputTokens: 240, costUsd: 0.1043, durationMs: 24_500 } },
  ),

  // --- day 2 -------------------------------------------------------------
  fromAgent(
    "Relay",
    "s-relay",
    "Tomá el seam de proveedores. El transcript depende de que ToolDetail sea fiel.",
    t1 - 2 * HOUR,
  ),
  user("Seguimos. Mapeá codex.", t1, {
    files: [{ name: "codex-stream.jsonl", path: "/Users/you/crew/docs/protocols/codex.jsonl", kind: "file", size: 48_211 }],
  }),
  reasoning("They attached the captured codex protocol. I should read it before guessing at field names.", t1 + 2_000),
  read("docs/protocols/codex.jsonl", t1 + 4_000, undefined, 1, 30),
  grep("\"type\":\"exec_command\"", t1 + 6_000, 41),
  edit("crates/crew-core/src/providers/codex.rs", t1 + 14_000, 84, 11),
  cmd("cargo test -p crew-core", t1 + 22_000, CARGO_FAIL, 1),
  reasoning("`raw.target` is an Option<String> for message tools because codex omits the field when the target is the parent. Default to the parent id.", t1 + 24_000),
  edit("crates/crew-core/src/providers/mod.rs", t1 + 28_000, 3, 1),
  cmd("cargo test -p crew-core", t1 + 34_000, "running 41 tests\n....................\ntest result: ok. 41 passed; 0 failed; 0 ignored"),
  cmd("npm run lint", t1 + 38_000, LINT_OUTPUT),
  assistant(
    `Codex mapeado. \`exec_command\` → \`command\`, \`apply_patch\` → \`edit\`, \`read_file\` → \`file\`.

El \`cargo test\` falló primero porque \`raw.target\` es \`Option<String>\` — codex omite el campo cuando el destino es el padre. Ahora cae al id del padre.

Queda un warning de eslint en \`Activity.tsx\` que ya estaba antes.`,
    t1 + 42_000,
    { usage: { inputTokens: 44_800, outputTokens: 310, costUsd: 0.2214, durationMs: 43_000 } },
  ),

  approval(
    "Bash",
    "git commit -m 'feat(providers): codex tool calls normalise into ToolDetail'",
    t1 + 50 * MIN,
    { command: "git commit -am 'feat(providers): codex tool calls normalise into ToolDetail'" },
    "allow",
  ),
  cmd(
    "git commit -am 'feat(providers): codex tool calls normalise into ToolDetail'",
    t1 + 50 * MIN + 2_000,
    "[master 4f9a1c2] feat(providers): codex tool calls normalise into ToolDetail\n 4 files changed, 118 insertions(+), 15 deletions(-)",
  ),

  note("Session resumed after the daemon restarted.", t1 + 3 * HOUR),

  // --- today -------------------------------------------------------------
  user("¿Cómo va el soporte por proveedor? Dame la tabla completa.", t2),
  reasoning(
    "They want the support matrix. I have it from the adapter code and the protocol captures. Let me lay it out as a table, and include the code that does the normalising so the claim is checkable.",
    t2 + 3_000,
  ),
  fetchUrl("https://base-ui.com/react/overview/quick-start", t2 + 6_000, "Base UI — Quick start"),
  assistant(MARKDOWN_KITCHEN_SINK, t2 + 14_000, {
    usage: { inputTokens: 51_200, outputTokens: 1_840, costUsd: 0.3187, durationMs: 34_000 },
  }),

  fromAgent(
    "Relay",
    "s-relay",
    "El renderer va a necesitar el campo `usage` de codex para el footer de turno. ¿Lo tenés o lo agrego yo al adapter?",
    t2 + 20 * MIN,
  ),
  fromAgent(
    "Relay",
    "s-relay",
    "Además: ¿el `message` normalizado ya incluye el id del agente destino, o sigue mandando el nombre? El sidebar necesita el id para abrir la pestaña.",
    t2 + 20 * MIN + 40_000,
  ),
  reasoning("Two questions from Relay. The first is mine, the second is already done. Answer both in one message back.", t2 + 21 * MIN),
  messageTo(
    "s-relay",
    "usage de codex: lo agrego yo, está en el evento `turn.done` que hoy descarto. Sale hoy.\n\nmessage: ya manda el id. `ToolDetail::Message.to` es el session id desde el commit 4f9a1c2; `agentLabel()` lo traduce a nombre en el renderer.",
    t2 + 21 * MIN + 10_000,
  ),
  assistant(
    "Le respondí a Relay: el `usage` de codex lo agrego yo (está en `turn.done`, que hoy descarto), y el `message` ya manda id, no nombre, desde 4f9a1c2.",
    t2 + 21 * MIN + 14_000,
  ),

  question(
    t2 + 30 * MIN,
    [
      {
        question: "¿Qué hago con los proveedores que no soportan approvals?",
        header: "Approvals",
        multiSelect: false,
        options: [
          { label: "Correr siempre en modo autónomo", description: "El agente no pide permiso. Rápido, pero sin freno." },
          { label: "Bloquear las tools peligrosas", description: "Las de escritura y shell no se ofrecen al proveedor." },
          { label: "Emular el approval en el daemon", description: "Interceptamos la llamada antes de ejecutarla. Más trabajo, mismo UX." },
        ],
      },
      {
        question: "¿Qué tools emulo primero?",
        header: "Alcance",
        multiSelect: true,
        options: [
          { label: "Bash / shell" },
          { label: "Edit / Write" },
          { label: "WebFetch" },
          { label: "message_agent" },
        ],
      },
    ],
    {
      "¿Qué hago con los proveedores que no soportan approvals?": "Emular el approval en el daemon",
      "¿Qué tools emulo primero?": "Bash / shell, Edit / Write",
    },
  ),
  assistant(
    "Perfecto — emulación en el daemon, empezando por shell y edición. Eso significa que el harness intercepta la llamada, levanta `approval.requested` por su cuenta y sólo ejecuta cuando vuelve la decisión. El proveedor nunca se entera.",
    t2 + 31 * MIN,
    { usage: { inputTokens: 58_000, outputTokens: 190, costUsd: 0.3401, durationMs: 9_200 } },
  ),

  user("Dale. Andá.", t2 + 40 * MIN),
  reasoning("Starting the interception layer. First read the harness supervisor to find where tool calls cross the boundary.", t2 + 40 * MIN + 2_000),
  read("crates/crew-core/src/harness.rs", t2 + 40 * MIN + 4_000, undefined, 820, 910),
  grep("fn dispatch_tool", t2 + 40 * MIN + 6_000, 3),
  edit("crates/crew-core/src/harness.rs", t2 + 40 * MIN + 18_000, 142, 6),
  approval("Edit", "Edit crates/crew-core/src/providers/opencode.rs", t2 + 41 * MIN, {
    file_path: "/Users/you/crew/crates/crew-core/src/providers/opencode.rs",
  }),
  tool({
    name: "Bash",
    title: "cargo build -p crew-core",
    at: t2 + 42 * MIN,
    status: "pending",
    detail: { kind: "command", command: "cargo build -p crew-core" },
  }),
];

// ---------------------------------------------------------------------------
// Thread 2 — Relay: the orchestrator. Agent-to-agent traffic is the point.
// ---------------------------------------------------------------------------

const n0 = NOW - 2 * DAY;
const n1 = NOW - 4 * HOUR;
const n2 = NOW - 26 * MIN;

export const relayThread: Block[] = [
  user("Necesito tres agentes más: uno para el renderer, uno para el daemon y uno que documente. Armalos vos.", n0 - 40 * MIN),
  reasoning(
    "They want a team, not three identical agents. Each one gets a provider that suits its job: the renderer agent wants something fast at UI work, the daemon agent something strong at Rust, the scribe something cheap because it writes prose all day. I inherit my own autonomy, so none of them can be allowed more than I am.",
    n0 - 40 * MIN + 4_000,
  ),
  crewCall("list_agents", {}, n0 - 40 * MIN + 7_000),
  crewCall(
    "create_agent",
    {
      name: "renderer",
      description:
        "You own the React shell: chrome, surfaces and the transcript. You do not touch the Rust crates — that is daemon's. When a design decision is above you, write to Relay rather than guessing.",
      provider: "cursor",
      model: "composer-2.5",
    },
    n0 - 40 * MIN + 12_000,
  ),
  crewCall(
    "create_agent",
    {
      name: "daemon",
      description:
        "You own crates/crew-core and crates/crewd: the harness, the session store, the PTY and the search index. You do not touch src/. Report anything that changes the wire protocol to Relay before you land it.",
      provider: "codex",
      model: "gpt-5.6-sol",
    },
    n0 - 40 * MIN + 19_000,
  ),
  crewCall(
    "create_agent",
    {
      name: "scribe",
      description:
        "You keep docs/ honest. Nobody asks you to write; you read what the others land and fix what the docs now claim wrongly. Prefer a schema over prose wherever a schema will do.",
      provider: "opencode",
      model: "opencode/ling-3.0-flash-fin-free",
    },
    n0 - 40 * MIN + 24_000,
  ),
  assistant(
    `Listos los tres, cada uno con el proveedor que le conviene:

- **renderer** — cursor / Composer 2.5. Rápido en UI, y el shell es casi todo iteración.
- **daemon** — codex / GPT-5.6 Sol. Es el que mejor aguanta Rust largo.
- **scribe** — opencode / Ling 3.0 Flash. Escribe prosa todo el día; que sea gratis.

Los tres heredan mi autonomía, así que ninguno puede hacer más de lo que puedo yo. Las descripciones son instrucciones permanentes: dicen qué tocan y, sobre todo, qué **no**.`,
    n0 - 40 * MIN + 30_000,
    { usage: { inputTokens: 6_200, outputTokens: 280, costUsd: 0.0331, durationMs: 31_000 } },
  ),

  user("Repartí el trabajo del design system entre renderer, harness y scribe.", n0),
  reasoning("Three agents, three lanes. I should message each one with a scoped brief rather than a shared one, so nobody reads work that isn't theirs.", n0 + 3_000),
  messageTo("s-renderer", "Tomá el shell: sidebar, tabs, command palette. No toques el transcript todavía.", n0 + 8_000),
  messageTo("s-harness", "Tomá el seam de proveedores. El transcript depende de que ToolDetail sea fiel.", n0 + 9_000),
  messageTo("s-scribe", "Documentá el contrato de bloques mientras los otros dos trabajan.", n0 + 10_000),
  assistant(
    "Repartido. renderer toma el shell, harness el seam de proveedores, scribe el contrato de bloques. Les dije explícitamente qué **no** tocar, que es donde se pisan.",
    n0 + 14_000,
    { usage: { inputTokens: 9_800, outputTokens: 120, costUsd: 0.0501, durationMs: 15_000 } },
  ),

  fromAgent("renderer", "s-renderer", "Shell listo. El sidebar resiste 400 sesiones sin jank; el virtualizado no hizo falta.", n1),
  fromAgent("renderer", "s-renderer", "Una cosa: el `Sidebar` de Kumo fuerza su propio color de fondo con una clase del mismo peso. Tuve que meter la variable inline. ¿Lo dejo así o lo saco de Kumo?", n1 + 90_000),
  fromAgent("renderer", "s-renderer", "Y los botones de Kumo tienen relieve, el sidebar es plano. Se nota.", n1 + 150_000),
  fromAgent("harness", "s-harness", "Codex mapeado, claude y cursor ya estaban. opencode manda sólo nombres, no hay detail que normalizar.", n1 + 12 * MIN),
  fromAgent(
    "scribe",
    "s-scribe",
    "Contrato escrito en docs/protocols/blocks.md. Encontré tres campos que el renderer lee y el daemon nunca escribe: `hidden`, `files` en bloques de tool, y `usage` fuera del último bloque del turno.",
    n1 + 40 * MIN,
  ),
  reasoning(
    "Renderer found the real problem: two design languages in one window. That's above their pay grade — it's a decision for the human. Scribe found three dead fields, which is a cheap fix. Let me summarise upward instead of deciding.",
    n1 + 41 * MIN,
  ),
  assistant(PLAN_REPLY, n1 + 42 * MIN, {
    usage: { inputTokens: 33_400, outputTokens: 410, costUsd: 0.1822, durationMs: 28_000 },
  }),

  user("El tercero lo decido yo. Mientras tanto, que scribe borre los tres campos muertos.", n2),
  messageTo("s-scribe", "Borrá `hidden` de los bloques de tool, `files` donde no aplica y el `usage` fuera del último bloque. Con tests.", n2 + 4_000),
  fromAgent("scribe", "s-scribe", "Hecho. 3 campos fuera, 11 tests tocados, ninguno rojo.", n2 + 9 * MIN),
  fromAgent("scribe", "s-scribe", "Aproveché y agregué el schema JSON del bloque a docs/. Ahora el contrato es verificable, no prosa.", n2 + 9 * MIN + 30_000),
  assistant(
    "Listo. scribe sacó los tres campos muertos y de paso dejó el contrato como schema JSON verificable en vez de prosa.",
    n2 + 10 * MIN,
    { usage: { inputTokens: 36_100, outputTokens: 95, costUsd: 0.1901, durationMs: 7_400 } },
  ),

  // Three letters to an agent that is mid-turn: they sit in its box until it
  // finishes. Nothing in the app today says so.
  messageWaiting(
    "s-harness",
    "Cuando salgas del turno: el footer de turno necesita `usage` de codex. ¿Lo tomás vos?",
    NOW - 12 * MIN,
  ),
  messageWaiting(
    "s-harness",
    "Otra: opencode no manda detail para ninguna tool. ¿Lo dejamos degradado o inventamos el detail desde el nombre?",
    NOW - 11 * MIN,
  ),
  messageWaiting(
    "s-triage",
    "Mañana a las 9 quiero el triage de CI con los flaky separados de las regresiones reales.",
    NOW - 9 * MIN,
  ),
  crewCall(
    "upsert_routine",
    {
      agent_id: "s-scribe",
      name: "Docs drift check",
      prompt:
        "Compare docs/ARCHITECTURE.md against the current crate layout. Report anything the doc claims that the code no longer does.",
      schedule: { kind: "interval", minutes: 60 },
      enabled: true,
    },
    NOW - 8 * MIN,
  ),
  crewCall(
    "update_description",
    {
      text: "You are the orchestrator of this workspace. You split work, you hand it out, and you decide nothing that belongs to the user — design direction, naming and scope come back up. Prefer writing to an agent over doing its job.",
    },
    NOW - 7 * MIN,
  ),
  crewCall(
    "continue_after_turn",
    {
      text: "Chase harness for the codex `usage` field once it is out of its turn, then close the design-system thread with the user.",
    },
    NOW - 6 * MIN,
  ),
  assistant(
    "Dejé tres cartas: dos a harness (que está en turno, así que esperan en su buzón) y una a triage para mañana. También le puse a scribe la rutina de drift horaria y me reescribí las instrucciones para no volver a decidir cosas que son tuyas.",
    NOW - 5 * MIN,
    { usage: { inputTokens: 38_900, outputTokens: 210, costUsd: 0.2044, durationMs: 22_000 } },
  ),
  question(NOW - 3 * MIN, [
    {
      question: "¿Sigo con la migración del transcript o espero tu decisión de diseño?",
      header: "Siguiente",
      multiSelect: false,
      options: [
        { label: "Seguir con el transcript", description: "Empiezo por los tool rows, que no dependen del look." },
        { label: "Esperar", description: "Freno hasta que cierres el design system." },
        { label: "Prototipar las tres variantes", description: "Armo las tres y decidís viendo." },
      ],
    },
  ]),
];

// ---------------------------------------------------------------------------
// Thread 3 — renderer: short, finished, unread.
// ---------------------------------------------------------------------------

const r0 = NOW - 40 * MIN;

export const rendererThread: Block[] = [
  fromAgent(
    "Relay",
    "s-relay",
    "Tomá el shell: sidebar, tabs, command palette. No toques el transcript todavía.",
    r0 - 26 * HOUR,
  ),
  messageTo(
    "s-relay",
    "Shell listo. El sidebar resiste 400 sesiones sin jank; el virtualizado no hizo falta.",
    r0 - 5 * HOUR,
  ),
  messageTo(
    "s-relay",
    "Una cosa: el `Sidebar` de Kumo fuerza su propio color de fondo con una clase del mismo peso. Tuve que meter la variable inline. ¿Lo dejo así o lo saco de Kumo?",
    r0 - 5 * HOUR + 90_000,
  ),
  messageTo("s-relay", "Y los botones de Kumo tienen relieve, el sidebar es plano. Se nota.", r0 - 5 * HOUR + 150_000),
  user("El orden manual del sidebar se pierde al recargar.", r0),
  reasoning("Manual order is stored by the daemon in session_reorder, which rewrites a whole workspace at once — so a reorder inside one kind clobbers the other kind's order.", r0 + 2_000),
  read("crates/crew-core/src/session_store.rs", r0 + 4_000, undefined, 1_240, 1_300),
  edit("crates/crew-core/src/session_store.rs", r0 + 9_000, 22, 14),
  edit("src/hooks/useSessions.ts", r0 + 11_000, 5, 3),
  cmd("npm run test", r0 + 14_000, TEST_OUTPUT),
  assistant(SHORT_REPLY, r0 + 17_000, {
    usage: { inputTokens: 12_900, outputTokens: 180, costUsd: 0.0688, durationMs: 17_500 },
  }),
];

// ---------------------------------------------------------------------------
// Thread 4 — scribe: it failed. Error states.
// ---------------------------------------------------------------------------

const s0 = NOW - 6 * HOUR;

export const scribeThread: Block[] = [
  fromAgent(
    "Relay",
    "s-relay",
    "Documentá el contrato de bloques mientras los otros dos trabajan.",
    s0 - 30 * HOUR,
  ),
  messageTo(
    "s-relay",
    "Contrato escrito en docs/protocols/blocks.md. Encontré tres campos que el renderer lee y el daemon nunca escribe: `hidden`, `files` en bloques de tool, y `usage` fuera del último bloque del turno.",
    s0 - 20 * HOUR,
  ),
  fromAgent(
    "Relay",
    "s-relay",
    "Borrá `hidden` de los bloques de tool, `files` donde no aplica y el `usage` fuera del último bloque. Con tests.",
    s0 - 9 * HOUR,
  ),
  messageTo("s-relay", "Hecho. 3 campos fuera, 11 tests tocados, ninguno rojo.", s0 - 8 * HOUR),
  messageTo(
    "s-relay",
    "Aproveché y agregué el schema JSON del bloque a docs/. Ahora el contrato es verificable, no prosa.",
    s0 - 8 * HOUR + 30_000,
  ),
  user("Generá el changelog desde el último tag.", s0),
  cmd("git describe --tags --abbrev=0", s0 + 2_000, "v0.1.0"),
  cmd("git log v0.1.0..HEAD --oneline", s0 + 4_000, "fatal: ambiguous argument 'v0.1.0..HEAD': unknown revision", 128),
  reasoning("The tag exists locally but the range fails — probably a shallow clone with no history behind the tag.", s0 + 6_000),
  cmd("git rev-parse --is-shallow-repository", s0 + 8_000, "true"),
  tool({
    name: "Bash",
    title: "git fetch --unshallow",
    at: s0 + 10_000,
    status: "failed",
    detail: {
      kind: "command",
      command: "git fetch --unshallow",
      exitCode: 128,
      output: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    },
  }),
  note("Session ended: the provider process exited with code 1.", s0 + 12_000),
  assistant(
    "No pude: el repo es un clon shallow y `git fetch --unshallow` necesita credenciales que no tengo. Dos salidas: corré `git fetch --unshallow` vos y me lo pedís de nuevo, o armo el changelog desde los commits que sí tengo (los últimos 50).",
    s0 + 13_000,
    { usage: { inputTokens: 4_200, outputTokens: 110, costUsd: 0.0221, durationMs: 13_400 } },
  ),
];

// ---------------------------------------------------------------------------
// Thread 5 — daemon: a huge run, for testing folding and performance.
// ---------------------------------------------------------------------------

const d0 = NOW - 2 * HOUR - 19 * MIN;

function bigRun(): Block[] {
  const out: Block[] = [user("Auditá todo el crate y arreglá lo que encuentres.", d0)];
  const files = [
    "harness.rs", "session_store.rs", "pty.rs", "search.rs", "scheduler.rs",
    "providers/mod.rs", "providers/claude.rs", "providers/codex.rs",
    "providers/cursor.rs", "providers/opencode.rs", "transport.rs", "lib.rs",
  ];
  let at = d0 + 2_000;
  out.push(reasoning("Twelve files. Read them all first, then fix in one pass so the edits don't fight each other.", at));
  for (const f of files) {
    at += 900;
    out.push(read(`crates/crew-core/src/${f}`, at));
  }
  at += 2_000;
  out.push(reasoning("Four real problems: an unbounded channel in the PTY reader, a lock held across an await in the store, a missing index on the FTS table, and dead code in cursor.rs.", at));
  for (const [f, added, removed] of [
    ["pty.rs", 14, 6],
    ["session_store.rs", 31, 22],
    ["search.rs", 9, 1],
    ["providers/cursor.rs", 0, 47],
  ] as const) {
    at += 1_400;
    out.push(edit(`crates/crew-core/src/${f}`, at, added, removed));
  }
  at += 2_000;
  out.push(cmd("cargo clippy --all-targets -- -D warnings", at, "    Finished `dev` profile [unoptimized + debuginfo] target(s) in 12.44s"));
  at += 3_000;
  out.push(cmd("cargo test -p crew-core", at, "test result: ok. 41 passed; 0 failed; 0 ignored"));
  at += 2_000;
  out.push(cmd("cargo bench --bench search -- --quick", at, "search/fts5/10k   time:   [1.8123 ms 1.8340 ms 1.8592 ms]\n                  change: [-31.402% -30.118% -28.771%] (p = 0.00 < 0.05)\n                  Performance has improved."));
  at += 4_000;
  out.push(
    assistant(
      `Cuatro cosas reales:

1. **PTY reader con canal sin límite** — un proceso que escupe rápido llenaba memoria hasta que el lector alcanzaba. Ahora es bounded con backpressure.
2. **Lock sostenido a través de un await** en \`session_store\` — bloqueaba todas las escrituras mientras una sola consulta iba a disco.
3. **Falta un índice** en la tabla FTS: la búsqueda por sesión hacía scan completo. 30% más rápido en el bench.
4. **47 líneas muertas** en \`cursor.rs\`, de cuando el adaptador parseaba SSE a mano.

Clippy limpio, 41 tests verdes.`,
      at,
      { usage: { inputTokens: 128_400, outputTokens: 520, costUsd: 0.7412, durationMs: 214_000 } },
    ),
  );
  return out;
}

export const daemonThread: Block[] = [
  user("Los tests flaky me están comiendo la mañana. ¿Podés delegarlo?", NOW - 15 * DAY),
  reasoning(
    "This is a job, not a task: it runs every morning, it needs its own history of which tests flake, and it should not eat my context. That is an agent, and a cheap one — the work is re-running tests and counting, not reasoning.",
    NOW - 15 * DAY + 3_000,
  ),
  crewCall(
    "create_agent",
    {
      name: "triage",
      description:
        "Every morning, read the night's CI failures. Split them into flaky, real regression, and infra. File only the real ones, with a minimal repro and a link to the failing run. Never file something already filed.",
      provider: "claude",
      model: "claude-haiku-4-5",
    },
    NOW - 15 * DAY + 9_000,
  ),
  crewCall(
    "upsert_routine",
    {
      agent_id: "s-triage",
      name: "Morning CI triage",
      prompt: "Read last night's CI failures and file the real ones.",
      schedule: { kind: "daily", hour: 9, minute: 0, days: [1, 2, 3, 4, 5] },
      enabled: true,
    },
    NOW - 15 * DAY + 14_000,
  ),
  messageTo(
    "s-triage",
    "Sos nuevo. Tu primera corrida es mañana 9:00. Si algo no te queda claro del pipeline, preguntame a mí, no al usuario.",
    NOW - 15 * DAY + 18_000,
  ),
  assistant(
    `Delegado. Creé **triage** con Haiku 4.5 — el trabajo es re-correr tests y contar, no razonar, así que no tiene sentido pagarle un modelo grande.

Le dejé la rutina de lunes a viernes 9:00 y un mensaje de arranque explicándole a quién preguntar. Su primera corrida es mañana.`,
    NOW - 15 * DAY + 24_000,
    { usage: { inputTokens: 141_000, outputTokens: 190, costUsd: 0.7788, durationMs: 25_000 } },
  ),
  ...bigRun(),
];

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Thread 6 — captured verbatim from a real daemon run.
//
// `design/tools/agent-probe.mjs` booted crewd, created an agent on opencode and
// asked it to create another agent and write to it. These are the blocks that
// came back, unedited. They are the worst case in the whole fixture set and the
// only ones that are not invented: every Crew tool arrives as `output` holding a
// JSON blob, and a letter routed through `call_tool` loses its `message` detail
// entirely. See design/FINDINGS.md.
// ---------------------------------------------------------------------------

const capture = (name: string, title: string, output: string, at: number): Block => ({
  id: id("cap"),
  role: "tool",
  text: title,
  at,
  tool: {
    callId: id("call"),
    name,
    title,
    status: "completed",
    detail: { kind: "output", text: output },
  },
});

const c0 = NOW - 34 * MIN;

export const leadThread: Block[] = [
  user(
    'Create one agent called "reviewer" whose job is reviewing pull requests, then send it a short message telling it what to start with. Use your tools.',
    c0,
  ),
  capture(
    "crew_list_agents",
    "Crew list agents",
    `[\n  {\n    "autonomy": "full",\n    "description": "You are the lead of this workspace.",\n    "id": "05a2d346-4fca-4ee5-81ec-f7d0a93c99dd",\n    "model": "opencode/ling-3.0-flash-fin-free",\n    "name": "lead",\n    "provider": "opencode",\n    "self": true,\n    "status": "working"\n  }\n]`,
    c0 + 1_400,
  ),
  capture(
    "crew_find_tool",
    "Crew find tool create agent",
    `{\n  "matches": [\n    {\n      "description": "Create a new agent in this workspace. It stays idle until the user messages it or a routine wakes it.",\n      "inputSchema": { "properties": { "name": { "type": "string" }, "description": { "type": "string" } }, "required": ["name", "description"] },\n      "name": "create_agent"\n    }\n  ]\n}`,
    c0 + 3_100,
  ),
  capture(
    "crew_call_tool",
    "Crew call tool create_agent",
    `{\n  "autonomy": "full",\n  "id": "600cbf85-7068-4b15-b0f8-2b5ed0567305",\n  "model": "opencode/ling-3.0-flash-fin-free",\n  "name": "reviewer",\n  "provider": "opencode",\n  "status": "idle"\n}`,
    c0 + 5_900,
  ),
  capture(
    "crew_call_tool",
    "Crew call tool message_agent",
    `{\n  "delivered": true,\n  "note": "reviewer is reading it now. Its reply will reach you as a message.",\n  "to": "reviewer",\n  "waiting": 0\n}`,
    c0 + 7_600,
  ),
  assistant(
    "Created the **reviewer** agent with full autonomy for pull request review, then sent it its first instruction.",
    c0 + 9_800,
    { usage: { inputTokens: 5_120, outputTokens: 96, durationMs: 10_100 } },
  ),
];

/** The other half of that capture: what the agent it created actually received. */
export const reviewerThread: Block[] = [
  note("Created by lead", c0 + 5_900),
  fromAgent(
    "lead",
    "s-lead",
    "Welcome! Your first task is to review the current pull requests in the workspace. Start by checking for open PRs and summarising what each one changes.",
    c0 + 7_600,
  ),
  note(
    "opencode decides its own permissions: it has no way to ask Crew, so it runs under your own autonomy setting.",
    c0 + 7_700,
  ),
];

export const threads: Record<string, Block[]> = {
  "s-lead": leadThread,
  "s-reviewer": reviewerThread,
  "s-harness": harnessThread,
  "s-relay": relayThread,
  "s-renderer": rendererThread,
  "s-scribe": scribeThread,
  "s-daemon": daemonThread,
  /** An agent that has never been talked to: the empty state. */
  "s-triage": [],
  "s-flake": [],
  "s-ledger-api": [],
  "s-nerb-site": [],
};

export function threadFor(sessionId: string): Block[] {
  return threads[sessionId] ?? [];
}
