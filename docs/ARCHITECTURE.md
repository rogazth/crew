# Crew — propuesta técnica

App de escritorio para manejar agentes de código. Workspaces, agentes con chat propio, terminales del proveedor, y un file explorer rápido.

Nada aquí es invención: cada decisión apunta a un archivo concreto en `reference/`.

## Corrección de premisa

> "la búsqueda de R1 funcionó muy bien, si esa es la velocidad que nos ofrece rust, lo añadiría al stack"

La búsqueda de R1 **no es Rust**. Es esto:

```rust
// reference/R1/src-tauri/src/fs.rs:97
fn git_ls_files(root: &Path) -> Option<Vec<ProjectFile>> {
    Command::new("git").arg("-C").arg(root)
        .args(["ls-files", "-co", "--exclude-standard", "-z"]).output()
}
```

Un subproceso `git`, cap de 20.000 archivos, y **81 líneas de TypeScript** haciendo fuzzy match sobre el array en memoria (`src/lib/fuzzy.ts`). La búsqueda de contenido es un shell-out a `git grep` (`search.rs:70`).

Esa velocidad se reproduce en TypeScript puro.

**Rust igual entra al stack, pero por otras razones:** `crewd` maneja PTY y supervisión de procesos hijos con cleanup garantizado vía `Drop`. El shell es Electron; la UI habla con el host solo a través de `src/lib/host.ts`.

## Stack

Copiar R1 casi literal. Está probado, es chico, y lo tienes en el disco.

| Capa | Elección | Evidencia |
| --- | --- | --- |
| Shell | Electron | `electron/` — Crew.app spawnea `crewd`; `src/lib/host.ts` es el único módulo que toca `window.crewHost` |
| Backend | Rust, un archivo por concern | 18 archivos, 15k líneas total |
| Store | `rusqlite` bundled + migraciones versionadas | `session_store.rs:375` |
| Frontend | React 19 + Vite + TypeScript | sin librería de estado |
| Estilos | Tailwind v4 (`@tailwindcss/vite`) | sin runtime CSS-in-JS |
| Editor | **`@pierre/diffs`**, no Monaco ni CodeMirror | ver "Editor" abajo |
| Terminal | `xterm.js` + `@xterm/addon-fit` | |
| Markdown | `streamdown` | diseñado para streaming de tokens |

Sin Redux, sin Zustand, sin TanStack Query. R1 no usa ninguno y su UI es la más rápida de las cuatro referencias.

## Estructura

### Rust — `crates/`

Un archivo por concern, sin submódulos. Es la convención de R1 y aguanta 15k líneas sin dolor.

```
crewd/src/main.rs  daemon: handshake JSON, teardown, `--mcp` / `call`
crewd/src/lib.rs   websocket + RPC
workspace.rs       crear/listar workspaces (nombre + path)
agent.rs           spawn/write/kill de CLIs de proveedor
bridge.rs          socket UNIX: relay de tool calls de los agentes al renderer
mcp.rs             servidor MCP por stdio y CLI dentro del agente
pty.rs             terminales interactivas (el 2º elemento)
files.rs           listar, leer, escribir
search.rs          git ls-files + git grep
store.rs           SQLite + migraciones
```

### Frontend — `src/`

```
App.tsx        el shell. MÁXIMO 300 LÍNEAS (ver "Límites duros")
chrome/        el marco: Sidebar, TabBar, Composer, CommandPalette
surfaces/      lo que llena un pane: AgentChat, TerminalView, FileEditor
lib/           lógica pura, testeable sin React
hooks/         glue de React
```

`chrome` = lo que rodea. `surfaces` = lo que se mete en un pane. Si un archivo toca el host nativo y no es `src/lib/host.ts`, está mal ubicado.

## Modelo de datos

El schema de R1 (`session_store.rs:11`) más una tabla de workspaces:

```sql
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  kind                 TEXT NOT NULL,          -- 'agent' | 'terminal'
  name                 TEXT NOT NULL,
  provider             TEXT NOT NULL,          -- 'claude' en el MVP
  model                TEXT NOT NULL DEFAULT '',
  provider_session_id  TEXT,                   -- opaco: lo emite el proveedor
  blocks_json          TEXT NOT NULL DEFAULT '[]',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX sessions_workspace_updated_idx
  ON sessions (workspace_id, updated_at DESC);
```

Tres decisiones que vienen de R1 y hay que respetar:

1. **`provider_session_id` es opaco.** Crew nunca lo parsea. Es el id que el proveedor le puso a su última corrida: se guarda para poder rastrearla, no para reanudarla. Ningún turno se reanuda — cada uno abre una sesión limpia y recibe el tail que arma `working_set.rs`.
2. **`blocks_json` era el transcript entero en una columna.** Aguantó hasta que hizo falta búsqueda transversal; desde la migración 10 los mismos bloques viven además como filas en `messages` con un índice FTS5 (`crates/crew-core/src/messages.rs`). La columna sigue escribiéndose: es lo que el hub hidrata al abrir una sesión. Las filas son para buscar, paginar y filtrar por fecha.
3. **`schema_migrations` desde el día uno.** `store.rs` corre migraciones numeradas al abrir.

`kind` distingue tus dos elementos: `agent` abre `AgentChat`, `terminal` abre `TerminalView`.

### Lo que se agregó después (migraciones 10 y 11)

```sql
-- 10: el transcript como filas, más el índice y la dedupe de envíos
CREATE TABLE messages (session_id, pos, id, role, text, at, extra_json, PRIMARY KEY (session_id, pos));
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid');
CREATE TABLE send_nonces (session_id, nonce, at, PRIMARY KEY (session_id, nonce));

-- 11: el buzón entre agentes
CREATE TABLE mailbox (id PRIMARY KEY, to_session, from_session, from_name, text, at, delivered_at);
```

`pos` es la posición del bloque en el transcript, no el `seq` del `TranscriptHub`
—ese cuenta eventos vivos, y diez bloques pueden ser mil deltas—. El flush no
reescribe el transcript: compara huellas por bloque y escribe solo las filas que
se movieron.

## Agentes desechables y el buzón

Un agente no es un proceso que vive: despierta con un mensaje, trabaja, y suelta
su CLI. Los cuatro proveedores corren un proceso por turno (Claude tenía uno
persistente; su ventana de gracia son cinco segundos, lo justo para que un
agente en loop no pague arranque en frío cada vuelta).

Los agentes no se llaman entre sí. `message_agent` deja una carta en el buzón
del otro; el daemon le arranca un turno con el remitente puesto, y la respuesta
vuelve igual. Nunca bloquea: esperar la respuesta trabaría el caso obvio —dos
agentes que se escriben—. Si el destinatario está ocupado, la carta espera; el
turno que termina drena el buzón (`TurnHost::drain_mailbox`).

**Escribirse a uno mismo es el loop.** Un agente que deja una nota a su propio
nombre la recibe como turno nuevo apenas termina el actual. Veinticinco vueltas
seguidas sin que hable nadie más lo cortan y lo dicen en el transcript.

## Las rutinas las dispara el daemon

Una rutina es una orden permanente: "cada día hábil a las 09:00, mirá Jira y
contame qué se movió". Se disparaba desde un `setTimeout` del renderer, así que
solo corría con la app abierta —que no es una orden permanente, y que la regla
de arriba ya excluía: al daemon va todo lo que debe seguir vivo cuando el
cliente no está—.

`crewd` arma un timer para la más próxima (con tope de 60 s por espera, porque
los timers se corren al suspender), la dispara como turno oculto con el prompt
guardado, y deja una nota `Routine · <nombre>` en el transcript. Si el agente
está ocupado, la corrida se anota como `skipped`: una rutina que se apila es
peor que una que se saltea una vuelta.

El renderer conserva la pantalla —escribirlas, el historial, y un "Run now" que
pasa por el mismo camino que el horario—. Una corrida que nadie pidió es lo
único que la pantalla no puede enterarse sola, así que cada vez que el historial
se mueve el daemon emite `routines-changed` y la lista se relee.

## Las tools que Crew le da al agente

`tools/list` devuelve cinco: `list_agents`, `message_agent`, `search_messages`,
`find_tool` y `call_tool`. El resto del catálogo se descubre con `find_tool`,
que rankea por nombre, keywords y descripción y contesta con el schema listo
para llamar. Cien tools costarían más prompt que la conversación, y la mayoría
de los turnos no necesita ninguna.

Cursor llega al bridge por `crew call` sin MCP, así que `tools/list_changed` no
es una opción; el gateway es la respuesta portable.

## El seam multi-provider

R1 lo resuelve con la abstracción más barata posible: **Rust no sabe qué es un proveedor.** Solo resuelve un path y supervisa un proceso.

```rust
// reference/R1/src-tauri/src/harness.rs:245
pub fn harness_resolve_claude() -> Result<CursorBinary, String>
pub fn harness_spawn(session_id, command, args, cwd) -> Result<(), String>
pub fn harness_write(session_id, data) -> Result<(), String>
pub fn harness_kill(session_id) -> Result<(), String>
```

Los eventos salen por el bus de Tauri: `agent-stdout`, `agent-stderr`, `agent-exit`.

Todo el parseo de protocolo vive en TypeScript, un adapter por proveedor:

```
src/lib/providers/
  runtime.ts    la interfaz `ProviderRuntime` y el registry
  claude.ts     helpers puros: parsea stream-json de claude
src/lib/claudeTurn.ts   el runtime de Claude: proceso persistente por agente
```

Agregar Codex es un archivo nuevo y una fila en el registry.

## El runtime del agente vive fuera de React

```
src/lib/transcript.ts    bloques por sesión; publica por frame, guarda con debounce
src/lib/agentRuntime.ts  send/stop/respond; escribe status y provider_session_id
src/lib/scheduler.ts     routines: guardar, borrar y "Run now" (el timer es del daemon)
src/lib/agentTools.ts    los tools que un agente tiene sobre Crew (agentes, rutinas)
src/hooks/useThread.ts   useSyncExternalStore sobre transcript.ts
```

Los agentes llegan a Crew por `bridge.rs`: `crew --mcp` (Claude, Codex,
opencode) o `crew call` (Cursor) escriben una línea JSON en el socket UNIX, y
`crew_core::tools::handle` la resuelve contra el store (`crewd/src/lib.rs:286`).
El catálogo, el ranking de `find_tool` y cada handler viven en
`crates/crew-core/src/tools.rs`; el renderer no participa.

Un tab cerrado o un reload del webview no pierden el turno: el runtime sigue
escribiendo el transcript en SQLite, y al arrancar `reconcile()` mata huérfanos
(`agent_kill_all`) y baja a `idle` cualquier `working` que nadie esté empujando.

Rust agrupa las líneas de stdout por evento IPC (8 ms de coalescing, tope de
256 líneas / 64 KiB) y las descarta si el proceso ya no es el dueño de la sesión.

Un `claude` parado son ~200 MB de node: el proceso muere al terminar el turno,
y el siguiente arranca con un `--session-id` nuevo.

## Editor

R2 usa Monaco: 2338 referencias en su `app.asar`, con `createDiffEditor` y `DiffEditorWidget` para diffs. No lo copiamos — `monaco-editor` pesa 97.9 MB desempaquetado. R2 lo absorbe porque es Electron con un asar de 136 MB; una app Tauri que existe por su huella chica, no.

| | Monaco | CodeMirror 6 | `@pierre/diffs` |
| --- | --- | --- | --- |
| Desempaquetado | 97.9 MB | 1.25 MB + langs | 6.9 MB |
| Look de fábrica | VS Code | plano | Shiki, listo |
| Virtualización | sí | manual | incluida |
| Highlighting en worker | sí | no | incluido |
| Diffs | nativo | `@codemirror/merge` | su especialidad |
| Madurez | 10 años | 4 años | ~7 meses |

`@pierre/diffs` es un editor completo, no un visor: `dist/editor/pieceTable.js` (la estructura de buffer de VS Code), `editStack.js` para undo/redo, `EditableInstance` / `DiffsEditor` / `EditorSelection`, exports `./edit` y `./worker` con pool, más `Virtualizer` y `searchPanel`. Apache-2.0, mantenido por los autores de Bootstrap.

**Por qué gana acá:** en Crew el agente escribe el código y el humano principalmente lee. CM6 gana cuando tecleas mucho — Lezer reparsea incrementalmente en el hilo principal. Shiki tokeniza con gramáticas TextMate, más pesado al teclear, y por eso Pierre trae workers. Para una superficie 90% lectura, ese modelo es mejor. Además resuelve el tema visual sin trabajo, y cubre los diffs del post-MVP sin una segunda librería.

**Riesgo y mitigación:** siete meses de vida, la API puede moverse, y su lado diff está más maduro que el de edición. El editor vive detrás de un único componente `surfaces/FileEditor.tsx` con interfaz angosta (`path`, `content`, `onChange`). Migrar a CodeMirror 6 es un archivo.

**Configuración obligatoria:** importar los lenguajes de Shiki de forma granular. Los 6.9 MB son casi todos gramáticas; traerlas completas anula la huella chica que motiva todo el stack.

## Reglas de performance

Cada una sale de leer las referencias, no de teoría.

1. **Nunca camines el filesystem si hay git.** `git ls-files` primero, walk recursivo solo como fallback (`fs.rs:91`).
2. **Cap duro en la lista de archivos.** 20.000. Sobre eso, el fuzzy match en memoria deja de ser instantáneo.
3. **Fuzzy match en el cliente, sobre array en memoria.** Sin índice, sin FTS, sin ida y vuelta a Rust por tecla.
4. **`spawn_blocking` para todo lo que toque disco.** `search.rs:43` lo hace para no bloquear el runtime de Tauri.
5. **Nada de Monaco.** 97.9 MB desempaquetado contra los 6.9 de Pierre.
6. **Virtualiza el transcript.** Un chat de agente llega a miles de bloques. El editor ya trae la suya.
7. **Eventos, no polling.** El bus de Tauri empuja; nada de `setInterval`.
8. **`Drop` mata los hijos.** `HarnessHost` y `PtyHost` implementan `Drop` para que cerrar la app no deje procesos huérfanos (`harness.rs:201`, `pty.rs:105`).

## Límites duros

Lo que separa esto de las referencias que envejecieron mal.

- **`App.tsx` ≤ 300 líneas.** R1 tiene 4842. Es su peor archivo y el motivo por el que sería doloroso extenderlo. El estado de panes/tabs va a `lib/`, no al componente.
- **Cero worktrees, cero git status, cero diffs.** Fuera del MVP, explícitamente.
- **Sin monorepo.** t3code pesa 523 MB y necesita Effect, `contracts` y un paquete ACP propio. No vas ahí.
- **Sin capa de repositorio sobre SQLite.** `store.rs` habla SQL.

## Orden de construcción

| # | Entrega | Estado |
| --- | --- | --- |
| 1 | Tauri, `store.rs` con migraciones, CRUD de workspaces | ✅ |
| 2 | Sidebar + persistencia del workspace activo | ✅ |
| 3 | `files.rs` + CommandPalette con fuzzy en memoria | ✅ |
| 4 | Tabs + `FileEditor` | ⚠️ tabs y lectura listos; falta montar `@pierre/diffs` |
| 5 | `pty.rs` + `TerminalView` | ✅ xterm.js sobre `pty.rs`; `claude --session-id` / `--resume` |
| 6 | `agent.rs` + `claude.ts` + `AgentChat` | ✅ |
| 7 | Persistencia del transcript y resume | ✅ runtime fuera de React, reconcile al arrancar |
| 8 | Autonomía por agente, notificaciones nativas, routines | ✅ |
| 9 | Adapters Codex y Cursor (un proceso por turno, sin approvals) | ✅ |
| 10 | Transcript como filas + FTS5, tail, búsqueda con fecha y orden | ✅ |
| 11 | Buzón entre agentes, agentes desechables, loop por auto-mensaje | ✅ |
| 12 | Adapter opencode (modelos gratis, sin credenciales) | ✅ |
| 13 | Gateway de tools (`find_tool` / `call_tool`) | ✅ |

Del 1 al 4 es andamiaje conocido. El 5 y 6 son el producto.

## Lo que NO se copia

| Referencia | Qué evitar | Por qué |
| --- | --- | --- |
| R1 | `App.tsx` de 4842 líneas | God component |
| R1 | `checkpoint.rs`, `linear.rs`, `notes.rs` | Features fuera de alcance |
| t3code | Effect, monorepo pnpm, `contracts`, `effect-acp` | Costo de mantenimiento que ya rechazaste |
| t3code | `native/libghostty-vt` | xterm.js alcanza |
| R3 | split `host` / `coordinator` / `box` | Diseñado para una VM remota que no tienes |
| R3 | gateway, OTel, Statsig, webauthn | Infra de producto comercial |
| R2 | orquestación, gates, dispatch | Sirve después; el MVP no coordina agentes entre sí |
