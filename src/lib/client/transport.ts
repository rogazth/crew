import { invoke } from "@tauri-apps/api/core";
import type { DaemonInfo, Event, Response } from "../protocol";

type Listener = (payload: unknown) => void;

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const listeners = new Map<string, Set<Listener>>();
const streams = new Map<number, (bytes: Uint8Array) => void>();
const buffered = new Map<number, Uint8Array[]>();
const bufferedBytes = new Map<number, number>();
const closed = new Set<number>();
const BUFFER_MAX_BYTES = 256 * 1024;
const reconnectHooks = new Set<() => void>();
const writes: Array<{ id: number; bytes: Uint8Array; resolve: () => void }> = [];
const WRITE_CAP = 256;

let nextId = 1;
let socket: WebSocket | null = null;
let opened: Promise<void> | null = null;
let reconnecting = false;
let ready = false;

function connect(): Promise<void> {
  if (!opened) {
    opened = open().catch((error) => {
      opened = null;
      throw error;
    });
  }
  return opened;
}

async function open(): Promise<void> {
  const info = await invoke<DaemonInfo>("daemon_info");
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(info.url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      const again = ready;
      socket = ws;
      ready = true;
      ws.send(JSON.stringify({ auth: info.token }));
      flushWrites();
      resolve();
      if (again) for (const hook of reconnectHooks) hook();
    };
    ws.onerror = () => reject(new Error("Crew daemon connection failed"));
    ws.onmessage = onMessage;
    ws.onclose = () => {
      socket = null;
      opened = null;
      failPending(new Error("Crew daemon disconnected"));
      scheduleReconnect();
    };
  });
}

function failPending(error: Error) {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  window.setTimeout(() => {
    reconnecting = false;
    void connect().catch(() => scheduleReconnect());
  }, 250);
}

function onMessage(event: MessageEvent) {
  if (typeof event.data !== "string") {
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    if (bytes.byteLength < 4) return;
    const id = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    const payload = bytes.subarray(4);
    if (closed.has(id)) return;
    const handler = streams.get(id);
    if (handler) {
      handler(payload);
      return;
    }
    const queue = buffered.get(id) ?? [];
    let size = bufferedBytes.get(id) ?? 0;
    while (queue.length > 0 && size + payload.byteLength > BUFFER_MAX_BYTES) {
      const old = queue.shift();
      if (!old) break;
      size -= old.byteLength;
    }
    if (size + payload.byteLength > BUFFER_MAX_BYTES) return;
    queue.push(payload);
    buffered.set(id, queue);
    bufferedBytes.set(id, size + payload.byteLength);
    return;
  }

  const message = JSON.parse(event.data) as Response | Event;
  if ("event" in message && message.event) {
    for (const listener of listeners.get(message.event) ?? []) listener(message.payload);
    return;
  }
  if (!("id" in message)) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.result);
  else waiter.reject(new Error(message.error ?? "Request failed"));
}

async function request<T>(method: string, params: object = {}): Promise<T> {
  await connect();
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("Crew daemon is not connected");
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(value as T), reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function on(event: string, listener: Listener): () => void {
  void connect();
  const set = listeners.get(event) ?? new Set();
  set.add(listener);
  listeners.set(event, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(event);
  };
}

function onReconnect(hook: () => void): () => void {
  reconnectHooks.add(hook);
  return () => {
    reconnectHooks.delete(hook);
  };
}

function openStream(id: number, onBytes: (bytes: Uint8Array) => void): () => void {
  closed.delete(id);
  streams.set(id, onBytes);
  const queue = buffered.get(id);
  if (queue) {
    buffered.delete(id);
    bufferedBytes.delete(id);
    for (const chunk of queue) onBytes(chunk);
  }
  return () => {
    if (streams.get(id) === onBytes) streams.delete(id);
    buffered.delete(id);
    bufferedBytes.delete(id);
    closed.add(id);
  };
}

function sendFrame(ws: WebSocket, id: number, bytes: Uint8Array) {
  const frame = new Uint8Array(4 + bytes.byteLength);
  new DataView(frame.buffer).setUint32(0, id, true);
  frame.set(bytes, 4);
  ws.send(frame);
}

function flushWrites() {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (writes.length) {
    const item = writes.shift();
    if (!item) break;
    sendFrame(ws, item.id, item.bytes);
    item.resolve();
  }
}

function writeStream(id: number, bytes: Uint8Array): Promise<void> {
  const ws = socket;
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendFrame(ws, id, bytes);
    return Promise.resolve();
  }
  if (writes.length >= WRITE_CAP) return Promise.reject(new Error("Crew daemon is not connected"));
  return new Promise((resolve, reject) => {
    writes.push({ id, bytes, resolve, reject });
    void connect().catch(() => {});
  });
}

export const transport = { request, on, onReconnect, openStream, writeStream };
