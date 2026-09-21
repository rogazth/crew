# Crew como daemon + cliente — arquitectura y fases

**Ejecutado.** Estado: **fases 1, 2 y 4 mezcladas en master el 2026-09-04; ver §10.** Este documento deja por escrito qué requisito rompe qué, qué evidencia lo respalda y en qué orden se construye, para no volver a discutirlo desde cero.

Decisiones tomadas el 2026-09-04:

- El backend es un **daemon Rust** (`crewd`). La app es un **cliente**. El mismo daemon corre en el Mac hoy y en una VM mañana.
- El shell del cliente pasa de Tauri a **Electron**, porque el navegador embebido necesita Chromium.
- El **navegador vive en el cliente**, no en el daemon. Los agentes lo conducen por CDP a través del daemon.
- El import de sesiones del navegador del sistema **queda fuera de alcance** por ahora.

## 0. Los dos disparadores

1. **Navegador embebido** con tabs que pueden ser conducidos por agentes o sesiones, con lock para que dos agentes —o un agente y el usuario— no se pisen. Además: DevTools embebido y selector de elementos como el de R2.
2. **Modo remoto.** El MVP corre todo en el Mac. Después, `crewd` se instala en un servidor y la app en el Mac es solo consumidor: los recursos que usan los agentes son los de la VM.

El primero saca al navegador de "un pane más" y obliga a cambiar de motor. El segundo obliga a que el backend sea un proceso propio con un protocolo de red, y descarta cargar el Rust dentro del proceso de Electron.

## 1. Por qué el navegador exige Chromium

Contrastado contra R2, un IDE Electron para agentes (Electron 43.4.1). El checkout vive fuera del repo.

| Requisito | WKWebView (wry / Tauri hoy) | Chromium + CDP |
| --- | --- | --- |
| Agentes conducen tabs | Solo `evaluateJavaScript` → eventos **no confiables**; muchos sitios los ignoran | `Input.dispatchMouseEvent` genera eventos confiables |
| DevTools dentro de Crew | Imposible. El inspector se adjunta desde Safari; el panel no se embebe | `setDevToolsWebContents`, caso nativo |
| Selector de elementos | Funciona (inyección JS + overlay) | Funciona |
| Particiones por tab | `WKWebsiteDataStore`, mal expuesto por wry | `session` de Electron, primera clase |
| Lock por tab | Estado propio, independiente del motor | Igual |

Los dos primeros deciden: **no hay camino a DevTools embebido ni a input confiable sin Chromium.**

### Alternativas descartadas

| Opción | Por qué no |
| --- | --- |
| **Quedarse en wry / WKWebView** | Muere en los dos requisitos de arriba. No es cuestión de esfuerzo: no existe la API |
| **CEF en Tauri** | Hay bindings, incluso de la org de Tauri, pero nadie los usa en producción en macOS. Helpers firmados a mano y un framework de 200 MB que igual se paga. Sería Electron con más trabajo y menos gente que lo haya sufrido antes |
| **Ventana Chromium superpuesta sobre la ventana Tauri** | macOS no permite reparentar vistas entre procesos. Sincronizar posiciones y pelear con el foco |
| **Chromium externo + screencast CDP dentro de Tauri** | Es el modo screencast remoto de R2 usado donde no fue diseñado. Sirve para agentes, no para un humano que navega: scroll con latencia, sin video decente |
| **Fork de Chromium** | Build de 1–4 h, ~100 GB, rebase cada ~4 semanas. Ni Vivaldi ni Brave escriben su UI en C++. No arregla nada de Crew |

### El costo real de la feature, verificado en R2

- `src/main/browser` son **494 archivos** de TS en el main process.
- R2 empaqueta un binario externo por plataforma (`agent-browser` ~0.27) además del bridge CDP propio.
- `anti-detection.ts` se inyecta con `Page.addScriptToEvaluateOnNewDocument` antes de cualquier JS de la página, para que Turnstile y similares no detecten el debugger adjunto.
- Dos caminos de render: `host-guest/` (webviews locales con particiones, el default) y `stream-remote/` (screencast por CDP para entornos remotos).

El navegador es la parte cara del plan. La migración de shell es la parte barata.

### El costo de Electron

Sube el baseline: cientos de MB en disco frente a diez, más memoria por proceso y más arranque. Se paga en arranque y RAM, no en el render: React sobre Chromium rinde igual o mejor que sobre WKWebView, y el chunk de entrada de 1.16 MB vale igual.

La comparación relevante: Cursor y R2 son Electron. La ventaja de Tauri era no embarcar un Chromium; en cuanto el navegador es requisito, se embarca uno sí o sí, y entonces lo barato es que ese Chromium también pinte la UI. Dos motores serían peor que uno.

## 2. Qué hace R2 con el backend, verificado

| Pieza | Implementación real |
| --- | --- |
| PTY | `node-pty` ^1.1.0 — addon nativo C++. JS solo recibe `Buffer` |
| Base de datos | `node:sqlite` built-in, sincrónico in-process |
| Search | Spawn del binario `rg` |
| Changes / status | Spawn del CLI de `git` + parseo de stdout |
| File watching | `@parcel/watcher` ^2.5.6 — addon nativo C++ |
| Trabajo pesado | `worker_threads` |
| Terminal render | xterm 6.1 + `addon-webgl` 0.20 |

El main process es un orquestador. El trabajo pesado ya está en C++, Swift, un binario externo o la GPU antes de que JS lo vea.

La ingeniería de verdad está en `src/main/git/coalesced-probe.ts` y `git-status-read-lease-owner.ts`: **evitan correr git dos veces.** Coalescen probes concurrentes bajo una misma key, con read leases y un stale de 60 s. Un `git status` en un repo grande son 200–800 ms; no correrlo cuatro veces ahorra 2 s. El patrón hay que copiarlo, en el lenguaje que sea. No es un argumento de migración: se puede hacer hoy.

## 3. Arquitectura

### La idea central

Tres piezas con fronteras duras:

| Pieza | Lenguaje | Dueño de |
| --- | --- | --- |
| `crewd` | Rust | PTYs, procesos de agentes, parseo de sus streams, transcripts, sqlite, workspaces, routines, watcher, bridge MCP |
| Shell Electron | Node | Ventanas, menús, webviews del navegador, CDP, DevTools, conexión al daemon |
| UI React | TS | Vista. Habla con un `CrewClient` que no sabe si el daemon es local o remoto |

El daemon escucha en **loopback TCP con un token** en un archivo 0600 y expone un **WebSocket**.

- Local: el shell lo spawnea como hijo y el renderer se conecta a `127.0.0.1`.
- Remoto: un túnel SSH trae el mismo puerto al Mac y el renderer se conecta a la misma dirección.

**Cero diferencia de código entre los dos modos.** Así lo hacen VS Code Server y el runtime remoto de R2.

El renderer se conecta directo al daemon, sin pasar por el main de Electron. El event loop de JS del main nunca ve un byte de PTY. Un panic de Rust tumba el daemon, no la app; el shell lo relanza y el cliente resincroniza.

### La regla para decidir qué va al daemon

**Todo lo que debe seguir vivo cuando el cliente no está.**

Hoy está en el lugar equivocado para el modo remoto:

- `agent.rs` solo spawnea el binario y mueve stdout. El parseo del stream de Claude, Codex y Cursor a bloques vive en `src/lib/providers/`.
- `transcript.ts` persiste cada 600 ms **desde el renderer**.

Con la tapa del Mac cerrada, el agente en la VM sigue produciendo eventos que nadie parsea ni guarda. Providers, transcripts, estado de sesión y locks bajan al daemon. `agentRuntime.ts` ya vive fuera de React: su lógica baja a Rust y él queda como cliente de eventos. La UI mantiene una proyección y se resincroniza al reconectar.

### El protocolo

1. **Tipos en Rust como fuente de verdad**, TS generado con `specta` o `ts-rs`. Un mensaje se define en un solo lugar.
2. **Tres formas de mensaje**: request/response con id, eventos que empuja el servidor, y **streams binarios con id de canal** para PTY y stdout de agentes. Los frames binarios de WebSocket resuelven el multiplexado sin inventar framing.
3. **Streams resumibles.** `pty.rs` ya coalesce a 8 ms y tiene acks con contador y marca de agua de 256 KB; es la mitad del trabajo. Falta un ring buffer por PTY en el daemon para que una reconexión pida "desde el byte N". Sin esto el modo remoto se siente frágil con cada corte de wifi.
4. **Capacidades bidireccionales.** El navegador vive en el cliente pero los agentes viven en el daemon. El cliente registra "tengo navegador" y el daemon enruta hacia él las tool calls del agente. `bridge.rs` ya hace esto en una dirección (socket Unix para `crew --mcp` / `crew call`); se generaliza.

### El navegador en modo remoto

Navegador en el Mac, agentes en la VM conduciéndolo por CDP tunelizado. El humano lo usa con latencia cero, las cookies están donde está la persona, y una acción de agente tolera 30 ms de ida y vuelta. Necesita port forwarding de la VM al Mac para que el navegador local vea la app que corre en la VM.

La alternativa —Chromium headless en la VM con screencast al Mac, el modo remoto de R2— solo tiene sentido si el navegador es casi exclusivo de agentes. No es el caso.

### Organización del repo

```
crates/
  crew-core/       dominio puro, sin transporte. Lo que ya existe menos Tauri
  crew-protocol/   tipos de mensajes, codegen a TS
  crewd/           binario: WebSocket, auth, multiplexado, ring buffers
  crew-cli/        crew --mcp y crew call, clientes del daemon
apps/
  desktop/         Electron: main, preload, renderer
packages/
  client/          CrewClient en TS: conexión, RPC, streams, reconexión. Sin React
  ui/              la app React actual
```

Regla de dependencias: `core` no conoce a `crewd`, `crewd` no conoce a Electron, `client` no conoce a React. Cada capa se testea sola.

### Alternativas descartadas para el backend

| Opción | Por qué no |
| --- | --- |
| **napi-rs en proceso** | Lo más rápido en local por microsegundos por frame, y cero camino a remoto. Habría que reescribir el borde en seis meses |
| **Sidecar con JSON-RPC sobre stdio** | Paga serialización por frame y no da conexión directa desde el renderer. WebSocket con frames binarios es el mismo aislamiento sin ese costo |
| **gRPC con tonic** | Streams tipados, pero desde un renderer necesita grpc-web y un proxy |
| **MessagePack / Cap'n Proto** | No hasta medir. Los frames binarios ya cubren el volumen; los mensajes de control son pequeños |
| **WASM** | Pierde threads y filesystem directo |

## 4. Superficie actual de Crew

Medido el 2026-09-04.

| Módulo | LOC | Destino |
| --- | --- | --- |
| `pty.rs` | 575 | `crew-core`. El coalescing y los acks se quedan |
| `agent.rs` | 457 | `crew-core`, crece con el parseo de providers |
| `store.rs` | 260 | `crew-core` |
| `session.rs` | 249 | `crew-core` |
| `files.rs` | 231 | `crew-core` |
| `mcp.rs` | 178 | `crew-core` |
| `routine.rs` | 148 | `crew-core` |
| `workspace.rs` | 119 | `crew-core` |
| `bridge.rs` | 162 | `crewd`. Es el socket para el MCP externo, sobrevive; solo cambia el `emit` |
| `lib.rs` | 93 | Se reescribe: es el `invoke_handler` de Tauri |
| `menu.rs` | 51 | Se va: lo reemplaza `Menu` de Electron |
| **Total Rust** | **2.543** | ~2.400 sobreviven |
| **Total TS/TSX** | **14.286** | Intacto salvo `providers/`, `transcript.ts` y `agentRuntime.ts`, que bajan al daemon |

Borde actual: **46 `invoke` distintos** y un puñado de `listen`. `pty.rs` expone cinco comandos (`spawn`, `write`, `resize`, `ack`, `kill`) más el evento de datos. El `CrewClient` que los reemplaza es pequeño.

## 5. Fases

1. **Extraer `crewd` sin salir de Tauri.** El webview de Tauri se conecta a `ws://127.0.0.1` igual que lo hará Electron. Se reemplazan los 46 `invoke` y los `listen` por el `CrewClient`. Riesgo bajo, medible, la app funciona cada día. ~1 semana.
2. **Bajar el runtime de agentes al daemon.** Providers, transcripts, estado de sesión. Es la parte con más lógica y no depende de Electron. 1–2 semanas.
3. **Spike de Electron, un día.** Ver §6. Si falla, no se migra y no se perdió nada.
4. **Shell Electron.** Ventanas, menús, spawn del daemon. Como el renderer ya habla WebSocket, es un cambio de shell puro. ~1 semana.
5. **Navegador.** La feature grande, sobre una base que no se vuelve a mover.
6. **Modo remoto.** Túnel SSH y selector de conexión. Casi todo el trabajo se hizo en 1 y 2.
7. **Solo si se mide que duele:** `gitoxide` para status, `grep-searcher` para search, en proceso, sin spawn. Nunca reimplementar git a mano: el CLI es el contrato, gitoxide es el atajo.

Watcher: `notify` en Rust desde el día uno. No meter `@parcel/watcher`.

El trade-off: las fases 1 y 2 retrasan el navegador dos o tres semanas. A cambio, el navegador y el modo remoto se construyen una vez y no dos, y la app nunca queda rota durante una migración de shell.

## 6. El spike que valida la migración

Antes de la fase 4, un día en un scratch:

1. Electron en blanco con un `WebContentsView`.
2. Debugger adjunto y `Input.dispatchMouseEvent` contra un sitio que ignore eventos sintéticos.
3. DevTools embebido con `setDevToolsWebContents`.
4. Medir arranque en frío y memoria con una ventana abierta, y compararlo con Crew hoy.

Si 2 o 3 fallan, no se migra. Si pasan y los números de 4 son aceptables, la fase 4 es una semana porque el Rust sobrevive.

## 7. Premisa a vigilar

"Tauri + React no va a tener buen performance" **no está medido**. Los commits `ba4a466` y `e653dbb` son wins de performance en el transcript y el arranque, y valen igual sobre Chromium.

La migración se justifica por **capacidades del navegador y modo remoto**, no por velocidad. Si el argumento se desliza hacia "es que Tauri va lento", hay que parar y medir.

## 8. Preguntas abiertas

1. ¿El lock por tab es exclusivo (un dueño a la vez) o admite lectura concurrente con escritura exclusiva, como las read leases de git en R2?
2. ¿Qué pasa con una tool call de navegador cuando el cliente que tiene el navegador se desconecta? ¿Falla, espera con timeout, o el agente recibe "sin navegador"?
3. ¿Tamaño del ring buffer por PTY y por cuánto tiempo se retiene tras la desconexión de un cliente?
4. ¿Vale la pena `@xterm/addon-webgl` en Crew hoy, independiente de todo esto?

## 9. Primer paso concreto

Crear `crates/crew-protocol` con los tipos de los cinco comandos de `pty.rs` y su evento de datos, generar el TS, y levantar un `crewd` mínimo que sirva solo PTY por WebSocket. Conectar el terminal actual de Tauri a ese socket. Es la fase 1 en su versión más pequeña, y mide el borde con el flujo de datos más exigente que tiene la app.

## 10. Estado del port — 2026-09-04

Fases 1, 2 y 4 de §5 mezcladas en `master` en 67 commits (tres worktrees en paralelo con Grok 4.6, tres rondas de revisión adversarial cada uno). Sin navegador ni modo remoto todavía.

- `crates/crew-core`, `crates/crew-protocol` (ts-rs → `src/lib/protocol.ts`), `crates/crewd` (binario con handshake JSON, `--data-dir`, `--mcp`/`call`, teardown por SIGTERM/SIGHUP/stdin EOF).
- El daemon es dueño de turnos, parseo de providers, transcripts (seq + `transcript-apply`), tools de Crew e imágenes inline. El renderer es proyección.
- PTY: un espacio de offsets absolutos, ring buffer con `pty_attach { id, from }`, replay bajo el lock del reader.
- `electron/` main + preload + menú; `src/lib/host.ts` es el único módulo que toca el host. `src-tauri` eliminado.

Residuales conocidos, ninguno bloqueante:

1. `turn_stop` durante el init de Claude mata el proceso pero no lo `detach`a; un segundo `turn_start` durante el init limpia el flag de stop y puede spawnear dos veces (`turns.rs` ~217-225, ~606-645).
2. Codex y Cursor no leen `stop_requested`.
3. `pty-error` por cola de entrada llena cierra el pane; `tokio::spawn` por frame de texto sin tope.
4. `session-status` en replay usa `now_millis` en vez del `updated_at` de la fila, y no tiene test.
5. Cmd+Q durante el handshake de `crewd` espera hasta 10 s.
6. Sin verificar a mano en la app: turno real de Claude bajo Electron, drop desde Finder, editor de archivos.
