/**
 * The text of an OSC 52 write (`Pc;base64`), or null for anything else. A read
 * (`Pc;?`) is refused: a program on the other end of the PTY does not get to
 * see the clipboard.
 */
export function oscClipboardText(data: string): string | null {
  const split = data.indexOf(";");
  if (split < 0) return null;
  const payload = data.slice(split + 1);
  if (payload === "?") return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * What an OSC 777 notification says (`notify;title;body`): its body, or its
 * title when the body is empty. The title is often just the program's name.
 */
export function osc777Message(data: string): string | undefined {
  const [, title = "", ...body] = data.split(";");
  const text = body.join(";").trim() || title.trim();
  return text || undefined;
}
