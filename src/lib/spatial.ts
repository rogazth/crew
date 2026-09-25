export type Direction = "up" | "down" | "left" | "right";

export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Arrow keys over a mix of grid tiles and full-width rows: the nearest box in
 * that direction. Vertical moves aim from the box's leading edge, so leaving a
 * row lands on the first tile of a grid, and a tile lands on the one under it.
 * Horizontal moves only stay on the same line; off its end there is nothing.
 */
export function nearest(from: Box, boxes: Box[], dir: Direction): number {
  const width = from.right - from.left;
  const height = from.bottom - from.top;
  const x = from.left + Math.min(width / 2, 16);
  const cy = from.top + height / 2;
  let best = -1;
  let bestScore = Infinity;
  boxes.forEach((box, index) => {
    const ey = (box.top + box.bottom) / 2;
    let score: number;
    if (dir === "up" || dir === "down") {
      const dy = ey - cy;
      if (dir === "down" ? dy <= 2 : dy >= -2) return;
      score = Math.abs(dy) + Math.max(0, box.left - x, x - box.right) * 3;
    } else {
      const overlap = Math.min(from.bottom, box.bottom) - Math.max(from.top, box.top);
      if (overlap < Math.min(height, box.bottom - box.top) / 2) return;
      const dx = (box.left + box.right) / 2 - (from.left + from.right) / 2;
      if (dir === "right" ? dx <= 2 : dx >= -2) return;
      score = Math.abs(dx);
    }
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

export const ARROWS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};
