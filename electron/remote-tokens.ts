import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, safeStorage } from "electron";

type Store = Record<string, string>;

function file(): string {
  return path.join(app.getPath("userData"), "remote-tokens.json");
}

async function read(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const store: Store = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "string") store[id] = value;
    }
    return store;
  } catch {
    return {};
  }
}

async function write(store: Store): Promise<void> {
  await mkdir(path.dirname(file()), { recursive: true });
  await writeFile(file(), JSON.stringify(store), { mode: 0o600 });
}

export async function putToken(id: string, token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("The keychain is not available");
  const store = await read();
  store[id] = safeStorage.encryptString(token).toString("base64");
  await write(store);
}

export async function getToken(id: string): Promise<string | null> {
  const blob = (await read())[id];
  if (!blob || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(blob, "base64"));
  } catch {
    return null;
  }
}

export async function dropToken(id: string): Promise<void> {
  const store = await read();
  delete store[id];
  await write(store);
}
