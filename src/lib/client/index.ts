import { invoke } from "@tauri-apps/api/core";
import type { DaemonInfo, Event, Response } from "../protocol";

type Listener = (payload: unknown) => void;

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const listeners = new Map<string, Set<Listener>>();
const streams = new Map<number, (bytes: Uint8Array) => void>();
const buffered = new Map<number, Uint8Array[]>();

let nextId = 1;
let socket: WebSocket | null = null;
let opened: Promise<void> | null = null;
let reconnecting = false;

function connect(): Promise<void> {
  opened ??= open();
  return opened;
}

async function open(): Promise<void> {
  const info = await invoke<DaemonInfo>("daemon_info");
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(info.url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      socket = ws;
      ws.send(JSON.stringify({ auth: info.token }));
      resolve();
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
    const handler = streams.get(id);
    if (handler) {
      handler(payload);
      return;
    }
    const queue = buffered.get(id) ?? [];
    queue.push(payload);
    buffered.set(id, queue);
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

function openStream(id: number, onBytes: (bytes: Uint8Array) => void): () => void {
  streams.set(id, onBytes);
  const queue = buffered.get(id);
  if (queue) {
    buffered.delete(id);
    for (const chunk of queue) onBytes(chunk);
  }
  return () => {
    if (streams.get(id) === onBytes) streams.delete(id);
    buffered.delete(id);
  };
}

function writeStream(id: number, bytes: Uint8Array) {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const frame = new Uint8Array(4 + bytes.byteLength);
  new DataView(frame.buffer).setUint32(0, id, true);
  frame.set(bytes, 4);
  ws.send(frame);
}

export const client = { request, on, openStream, writeStream };
