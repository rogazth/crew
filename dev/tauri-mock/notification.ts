export async function isPermissionGranted(): Promise<boolean> {
  return true;
}

export async function requestPermission(): Promise<"granted" | "denied" | "default"> {
  return "granted";
}

export function sendNotification(options: { title: string; body?: string }): void {
  console.info("[mock notification]", options.title, options.body ?? "");
}
