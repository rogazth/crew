# Chat de agentes — plan de rediseño

Objetivo: el minimalismo de R3, los tokens de Cursor (`reference/cursor`), la transparencia de R1 (se ve qué hizo el agente sin ruido). Todo lo de abajo está verificado contra el código de Crew, el CLI real de Claude (2.1.259) y las dos referencias; nada es suposición.

## 0. Diagnóstico verificado

| Tema | Estado en Crew hoy | Evidencia |
| --- | --- | --- |
| Preguntas del agente (`AskUserQuestion`) | **No soportado.** Llega como `control_request / can_use_tool` y `handleControl` lo pinta como aprobación Allow/Deny. Allow reenvía el input sin `answers`. | `src/lib/claudeTurn.ts:438-470`, captura en `notes/claude-permissions-protocol.jsonl` |
| Radio / checkbox / wizard | No existe ninguno. R1 tampoco: auto-responde con la primera opción. | R1 `claudeProtocol.ts:625-640` |
| Aprobaciones | Allow/Deny por llamada. Sin "Always allow", sin diff para Edit/Write, sin el `input` en el bloque. | `src/lib/blocks.ts:33-37` |
| Thinking | Claude headless no emite bloques `thinking` (sonnet-5 y opus-5, con y sin `MAX_THINKING_TOKENS`: `thinking_tokens: 0`). Cursor sí (19 eventos en `notes/cursor-protocol.jsonl`) y `cursorTurn.ts` los descarta. | capturas `thinking*.jsonl` |
| Code highlight | streamdown 2.6 delega en `@streamdown/code`, que no está instalado. Kumo ya trae shiki (`@cloudflare/kumo/code`). Las tres cajas anidadas: `.crew-md` da padding+fondo a `[data-streamdown="code-block"]` **y** a `pre`, y streamdown mete header+body. | `src/index.css:212-224` |
| Imágenes | `AgentChat` solo tiene el picker. Ni drop ni paste (TerminalView sí, con `useFileDrop` + `writeTempFile`). Se mandan como lista de rutas en el texto y Claude gasta un tool call en leerlas. Sin thumbnail, sin lightbox. | `src/lib/providers/claude.ts:60-80` |
| Jerarquía | Usuario = card 6% tinta a la izquierda, asistente flush, mismo ancho. Línea de tokens/costo bajo cada respuesta. Empty state = tarjeta de identidad arriba-izquierda. Composer con ring 1.5px al focus. | `src/surfaces/chat/Message.tsx`, `AgentChat.tsx:85-107` |
| Routines | "Run on a schedule" = un switch dentro del AgentSheet, un routine por sesión, sin nombre, sin historial, arranca conversación nueva. | `src/chrome/AgentSheet.tsx:245-267`, `src/lib/routines.ts` |

### Protocolo capturado (Claude 2.1.259)

Pregunta, entrada:

```json
{"type":"control_request","request_id":"…","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion",
 "input":{"questions":[
   {"question":"Pick a color","header":"Color","multiSelect":false,"options":[{"label":"Red","description":"Red"},{"label":"Blue","description":"Blue"}]},
   {"question":"Pick toppings","header":"Toppings","multiSelect":true,"options":[…]}]},
 "tool_use_id":"toolu_…","requires_user_interaction":true}}
```

Pregunta, respuesta (aceptada; multiSelect = labels unidos por `", "`; texto libre = cualquier string):

```json
{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{
 "behavior":"allow","updatedInput":{"questions":[…],"answers":{"Pick a color":"Red","Pick toppings":"Cheese, Olives"}}}}}
```

Claude devuelve `tool_result: "Your questions have been answered: …"` y sigue. Cancelar = `behavior: "deny"`.

Aprobación, entrada: trae `permission_suggestions` (regla exacta, `destination: "localSettings"`) y `decision_reason`. Respuesta con regla de sesión:

```json
{"behavior":"allow","updatedInput":{…},
 "updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"curl:*"}],"behavior":"allow","destination":"session"}]}
```

Verificado: el segundo `curl` corrió sin pedir permiso. "Always allow" es viable sin tocar settings del usuario.

## 1. Dirección de diseño

Columna de 720px, tipografía 13/18 con tracking -0.08 (ya en `crew-prose`). Un solo color de tinta mezclado sobre transparente (ya en `--color-card`, `--color-hairline`).

- **Mensaje del usuario**: burbuja a la derecha, tinta sobre canvas (`crew-ink`, ya flipea con el tema), radio 16, esquina inferior derecha 4, máximo 75% del ancho. Adjuntos dentro de la burbuja.
- **Respuesta del asistente**: prosa flush sobre el canvas, sin burbuja. Los grupos de herramientas, el código y las preguntas viven en ese flujo, y una burbuja gris de 640px pelea con contenido ancho (R1 y Cursor hacen esto; Grok pone burbuja gris porque no muestra herramientas inline).
- **Ritmo**: mismo hablante 6px, cambio de hablante 20px, separador de fecha centrado 11px cuando pasan más de 30 minutos (Grok: "Today 5:40 PM").
- **Actividad**: fases colapsadas al estilo R1: "Read 3 files", "Edited sidebarPrefs.ts", "Ran 2 commands". La fase viva está abierta y con ventana de scroll corta (max-height 45vh), se pliega sola cuando el agente pasa a la siguiente. Chevron e icono comparten los 14px y se intercambian al hover. Plegado con `grid-template-rows: 1fr → 0fr` (sin medir alturas).
- **Thinking**: fila colapsable "Thinking…" → "Thought for 4s" (patrón AI Elements). Se abre mientras streamea, se cierra al terminar, nunca se abre al abrir el grupo.
- **Preguntas**: card en el flujo, con el `header` como título, opciones con keycap A/B/C (Grok), radio si `multiSelect: false`, checkbox si `true`, campo "Other" siempre. Más de una pregunta = pasos con pestañas por header y botón Submit al final. Respondida: la pregunta y las opciones elegidas como chips, sin controles. Dismiss = deny.
- **Aprobaciones**: card con el comando en mono (Bash) o el diff (Edit/Write, con `@pierre/diffs` que ya es dependencia, a partir de `old_string`/`new_string`/`content`). Botones Deny · Allow · Always allow. Esc = deny, Enter = allow.
- **Turn footer**: una línea 11px: "Worked for 9s · 5:40 PM", y copy. Tokens y costo van en el tooltip del tiempo, no en el flujo. Ninguna referencia muestra costo por mensaje.
- **Composer** (referencia Cursor): radio 16, borde 10% tinta que pasa a 20% al focus, sin ring. Plus en círculo de 6%, chip de modelo con chevron, send en tinta a la derecha. Chips de adjuntos con thumbnail cuando son imágenes. Drop y paste de imágenes.
- **Empty state**: solo el composer centrado verticalmente con el placeholder "Message {nombre}". La identidad ya está en la pestaña y el sidebar.
- **Código**: una sola caja, header con lenguaje y copy, cuerpo 12/16 mono, highlight shiki con los temas de Kumo. Inline code que parece ruta → chip con icono, clic abre el archivo en una pestaña (Crew ya tiene tabs de archivo).

## 2. Modelo y protocolo (todo en `lib/`, sin React)

```ts
// blocks.ts
type BlockRole = "user" | "assistant" | "reasoning" | "tool" | "approval" | "question" | "system";

type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description?: string }[] };
question?: { requestId: number; questions: Question[]; answers?: Record<string, string>; dismissed?: boolean };
approval?: { requestId: number; name: string; input: Record<string, unknown>; suggestions?: unknown[]; decided?: "allow" | "always" | "deny" };
files?: { name: string; path: string; kind: "image" | "file"; size?: number }[];

// HarnessEvent, nuevos
| { type: "reasoning.delta"; text: string }
| { type: "question.requested"; requestId; questions }
| { type: "question.resolved"; requestId; answers | null }
// approval.requested gana input + suggestions

// ProviderRuntime, nuevos
respondQuestion(sessionId, requestId, answers: Record<string, string> | null): void;
respondApproval(sessionId, requestId, decision: "allow" | "always" | "deny"): void;
```

- `claudeTurn.handleControl`: si `tool_name === "AskUserQuestion"` emite `question.requested` y responde con `updatedInput.answers`. Para el resto, `always` añade `updatedPermissions` con una regla por prefijo (`"<primera palabra>:*"` para Bash, `toolName` a secas para Edit/Read).
- `cursorTurn`: los eventos `thinking` pasan a `reasoning.delta`.
- `Transcript` agrupa por turno: user → fases → respuesta → footer. La lógica de fases vive en `lib/activity.ts` (puro): clasificación edit/research/run/think/other, tally con dedupe por ruta, labels con tiempo verbal. Se añade vitest solo para `lib/` (R1 tiene 622 líneas de tests para exactamente esto).
- Imágenes: se mandan como bloques `{type: "image", source: {type: "base64", media_type, data}}` (gif/jpeg/png/webp) en el mensaje de usuario, no como rutas. Para el thumbnail en el transcript, `read_file_base64` en Rust → `data:` URI (la CSP ya admite `img-src data:`; el asset protocol no está habilitado y no hace falta).
- Mock (`dev/tauri-mock/core.ts`): un turno que encadena Read → pregunta de 2 pasos → aprobación de Edit con diff → respuesta con código, y un seed con imagen adjunta. Es lo que se screenshotea en cada fase.

## 3. De dónde sale cada pieza

Regla: primero Kumo (Base UI debajo), luego Base UI a pelo, y solo si ninguno cuadra se copia con tweak local.

| Pieza | Fuente | Decisión |
| --- | --- | --- |
| Collapsible (thinking, fases) | Kumo `Collapsible` | Usar. El cuerpo animado con grid-rows es CSS propio. |
| Radio / checkbox de preguntas | Kumo `RadioGroup` / `Checkbox` | Usar con `variant`. Si la densidad de chat no cuadra, Base UI `Radio`/`CheckboxGroup` con clases propias. |
| Pasos del wizard | Kumo `Tabs` | Usar para los headers; Next/Submit son `Button`. |
| Lightbox | Base UI `Dialog` | Propio encima: Esc, ← →, zoom con rueda. Kumo `Dialog` es de formulario. |
| Diff en aprobaciones | `@pierre/diffs` | Ya es dependencia. |
| Highlight | `useShikiHighlighter` de `@cloudflare/kumo/code` dentro de `components.code` de Streamdown | No instalar `@streamdown/code`: sería un segundo shiki. |
| Header y copy del bloque de código | streamdown `CodeBlockHeader` / `CodeBlockCopyButton` | Ya vienen; solo CSS. |
| Scroller pegado al fondo | Propio (ya existe, umbral 16px) | De shadcn `MessageScroller` se copia solo el anclado del último turno (`min-height` del turno vivo para que el prompt suba arriba al enviar). No se instala `@shadcn/react`. |
| Message / Bubble / Attachment / Marker (shadcn) | No copiar | Son divs con Tailwind; se reproducen con nuestros tokens. |
| Reasoning (AI Elements) | Patrón | Solo el comportamiento de la etiqueta y auto open/close. |
| Approval Card, Tool Chips, Thinking (Beautiful UI) | Referencia visual | MIT, sin paquete claro. No se instala nada. |
| Shimmer del label vivo | CSS propio | Un keyframe. |
| Composer | Propio (ya existe) | Cambia el CSS al de Cursor. |

## 4. Fases

Cada fase termina con screenshot del mock (`CREW_MOCK=1 npx vite --port 1421`) y un commit.

| # | Entrega | Toca | Tiempo |
| --- | --- | --- | --- |
| 0 | Protocolo y modelo: roles `reasoning`/`question`, eventos, `respondQuestion`, `always`, Claude enruta AskUserQuestion, Cursor emite thinking, mock con el turno completo, vitest para `blocks.ts` y `activity.ts` | `lib/blocks.ts`, `lib/claudeTurn.ts`, `lib/cursorTurn.ts`, `lib/providers/runtime.ts`, `lib/agentRuntime.ts`, `dev/tauri-mock/core.ts` | 4h |
| 1 | Markdown y código: una caja, shiki de Kumo, chips de archivo clicables | `chat/Markdown.tsx`, `index.css` | 2h |
| 2 | Jerarquía: burbuja de usuario a la derecha, ritmo, separador de fecha, footer de turno con tooltip de costo | `chat/Message.tsx`, `chat/Transcript.tsx` | 2h |
| 3 | Actividad por fases y thinking colapsable | `lib/activity.ts`, `chat/Activity.tsx` (reemplaza `ActivityLine.tsx`) | 4h |
| 4 | Card de pregunta (radio, checkbox, pasos, Other, teclas A/B/C) y card de aprobación con diff y Always allow | `chat/QuestionCard.tsx`, `chat/ApprovalCard.tsx` | 4h |
| 5 | Adjuntos: thumbnails, lightbox, drop y paste en el chat, bloques de imagen a Claude | `chat/Attachments.tsx`, `lib/api.ts`, `agent.rs` (`read_file_base64`) | 3h |
| 6 | Composer al estilo Cursor y empty state sin tarjeta | `chat/Composer.tsx`, `AgentChat.tsx` | 2h |
| 7 | Routines (ver §5) | `lib/routines.ts`, `lib/scheduler.ts`, `chrome/RoutinesPane.tsx`, `store.rs` (migración) | 4h |

Total: unas 25 horas, tres días.

## 5. Routines (reemplaza "Run on a schedule")

Modelo Grok: cada agente tiene una lista de routines con nombre, instrucción, cuándo corre, activo/pausado, "Test run" y un historial de las últimas 20 corridas con estado.

```sql
-- migración
ALTER TABLE routines ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE routines ADD COLUMN runs_json TEXT NOT NULL DEFAULT '[]';   -- [{id, startedAt, finishedAt, status: running|ok|error, detail}]
-- se quita el UNIQUE(session_id): N routines por sesión
```

- **UI**: sección "Routines" en el AgentSheet con la lista (icono reloj / pausa, nombre, "Every weekday at 09:00" o "Paused"). Editor con tres campos: Name, Instruction, When (los presets actuales más un cron opcional). Header: Active, Test run, Delete. Historial debajo: "Today at 9:00 · ✓".
- **Cómo corre**: se anexa a la conversación existente como turno oculto con el prefijo `[routine] "Nombre" is due — every weekday at 09:00. Carry it out now. If nothing changed, end without filler.` En el transcript aparece una nota "Routine · Nombre · 9:00" y luego la respuesta. Grok hace exactamente esto; conservar el contexto de la conversación es lo que hace útil un routine.
- **Notificación**: solo si el agente produjo un mensaje. Silencio es un resultado válido.

Alternativa que no recomiendo: conversación nueva por corrida (lo actual). Pierde la memoria de lo que el routine vio la vez anterior, y llena el sidebar.

## 6. Decisiones abiertas

Recomendación primero; si no dices nada, se implementa la recomendación.

1. **Asistente flush** (recomendado) vs burbuja gris 6% como Grok. La burbuja se ve bien con texto corto y mal con código, diffs y fases.
2. **Costo en tooltip del footer** (recomendado) vs línea bajo cada respuesta (lo actual) vs solo un medidor de contexto en el composer (R1: nivel de contexto, no acumulado). Se puede añadir el medidor después sin tocar el transcript.
3. **Always allow por prefijo en sesión** (recomendado, `curl:*`) vs la regla exacta que sugiere Claude (`curl -s -o … example.com`, inútil para el siguiente comando) vs `destination: "localSettings"` (persistente, toca los settings del usuario).
4. **Routines anexadas a la conversación** (recomendado) vs conversación nueva.
5. **Imágenes como bloques base64** (recomendado) vs rutas. Ahorra el Read y funciona igual con Codex y Cursor, que también aceptan imágenes inline.

## Estado (2026-09-03)

Las siete fases están implementadas y verificadas en el mock (`CREW_MOCK=1`), cada una en su commit:

| # | Commit | Verificado |
| --- | --- | --- |
| 0 | `feat: answer agent questions and always-allow approvals over the Claude protocol` | vitest (`blocks`, `providers/claude`), flujo completo en el mock |
| 1 | `feat: highlight chat code with shiki and open file chips from markdown` | ts y php resaltados, chips clicables |
| 2 | `feat: right-align user turns and close replies with a footer instead of a cost line` | separadores de fecha, tooltip de costo |
| 3 | `feat: fold tool calls into phases and collapse thinking rows` | vitest (`activity`), fases plegadas y viva |
| 4 | `feat: answer questions with keyed choice cards and approve edits from a diff card` | teclas A/B/C, Enter, Esc; diff real de Edit |
| 5 | `feat: show image attachments as thumbnails with a viewer and send them inline` | thumbnails, lightbox, `read_file_base64` (cargo check) |
| 6 | `feat: restyle the composer after Cursor and center it on an empty chat` | empty state sin tarjeta |
| 7 | `feat: replace the schedule switch with per-agent routines` | migración 8, Test run anexado a la conversación |

Pendiente, fuera de este plan:

- Modo oscuro: Kumo no cambia con `prefers-color-scheme` en el navegador; en la app hay que confirmar cómo se activa. Los tokens del chat ya usan `light-dark()` y mezclas de tinta.
- Probar con `claude` real desde la app (el mock cubre el protocolo capturado, no el proceso).
- Cron libre en routines: hoy solo los presets (`CADENCES`).
