import { execFile } from "node:child_process";
import type { MemoryPressure } from "../../src/lib/browser/retention";

/** Below this share of memory available, pages go cold sooner; below the second, all hidden ones go. */
const MODERATE_AVAILABLE = 0.15;
const CRITICAL_AVAILABLE = 0.05;

/**
 * The kernel's own reading on a Mac, the one Chrome discards tabs on:
 * 1 normal, 2 warn, 4 critical. Free memory means little there, since the
 * system fills it with cache and compresses before it pages.
 */
export function pressureOfLevel(level: number): MemoryPressure {
  if (level >= 4) return "critical";
  if (level >= 2) return "moderate";
  return "normal";
}

/** Elsewhere, from the share of memory still available. */
export function pressureOfMemory(total: number, free: number): MemoryPressure {
  if (!(total > 0)) return "normal";
  const available = free / total;
  if (available < CRITICAL_AVAILABLE) return "critical";
  if (available < MODERATE_AVAILABLE) return "moderate";
  return "normal";
}

function macLevel(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 2000 }, (error, stdout) => {
      const level = Number.parseInt(stdout, 10);
      resolve(error || Number.isNaN(level) ? null : level);
    });
  });
}

/** Normal when it can't be read: pages then go cold on time alone. */
export async function memoryPressure(): Promise<MemoryPressure> {
  if (process.platform === "darwin") {
    const level = await macLevel();
    return level === null ? "normal" : pressureOfLevel(level);
  }
  const { total, free } = process.getSystemMemoryInfo();
  return pressureOfMemory(total, free);
}
