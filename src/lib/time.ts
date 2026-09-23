const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const DAY_YEAR = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** "5:40 PM" in the user's locale. */
export function clock(at: number): string {
  return CLOCK.format(at);
}

/** "Today", "Yesterday", "Tuesday", "Mar 3", "Mar 3, 2025": how far back a day reads. */
export function dayName(at: number, now = Date.now()): string {
  const day = new Date(at);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? WEEKDAY.format(day)
    : day.getFullYear() === today.getFullYear() ? DAY.format(day) : DAY_YEAR.format(day);
}

/** "Today 5:40 PM", "Yesterday …", "Tuesday …", "Mar 3 …": the transcript's date breaks. */
export function dayLabel(at: number, now = Date.now()): string {
  return `${dayName(at, now)} ${CLOCK.format(at)}`;
}

/** "9s", "3m 12s", "1h 4m": how long the agent worked. */
export function duration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Compact elapsed label: 2h 19m, 4m, now. */
export function elapsed(since: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
