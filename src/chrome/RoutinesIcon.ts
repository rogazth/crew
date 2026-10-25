import { createLucideIcon } from "lucide-react";

/** Lucide's calendar-sync with a single loop: a schedule that comes back, without the two arrows of a refresh. */
export const RoutinesIcon = createLucideIcon("routines", [
  ["path", { d: "M16 2v3", key: "pin-right" }],
  ["path", { d: "M8 2v3", key: "pin-left" }],
  ["path", { d: "M3 9h4", key: "header" }],
  ["path", { d: "M21 8.517V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.517", key: "page" }],
  ["path", { d: "M11 10v4h4", key: "arrowhead" }],
  ["path", { d: "m11 14 1.535-1.605a5 5 0 1 1-1.37 4.9", key: "loop" }],
]);
