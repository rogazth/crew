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
