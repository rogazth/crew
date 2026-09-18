import { useEffect, useState } from "react";

export type Route =
  | { kind: "session"; id: string }
  | { kind: "file"; path: string }
  | { kind: "search" }
  | { kind: "routines"; id?: string }
  | { kind: "settings"; section: string }
  | { kind: "home" };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  if (!raw) return { kind: "home" };
  const [head, ...rest] = raw.split("/");
  const tail = rest.join("/");
  switch (head) {
    case "session":
      return tail ? { kind: "session", id: decodeURIComponent(tail) } : { kind: "home" };
    case "file":
      return tail ? { kind: "file", path: decodeURIComponent(tail) } : { kind: "home" };
    case "search":
      return { kind: "search" };
    case "routines":
      return tail ? { kind: "routines", id: decodeURIComponent(tail) } : { kind: "routines" };
    case "settings":
      return { kind: "settings", section: tail || "general" };
    default:
      return { kind: "home" };
  }
}

export function formatRoute(route: Route): string {
  switch (route.kind) {
    case "session":
      return `#/session/${route.id}`;
    case "file":
      return `#/file/${route.path}`;
    case "search":
      return "#/search";
    case "routines":
      return route.id ? `#/routines/${route.id}` : "#/routines";
    case "settings":
      return `#/settings/${route.section}`;
    case "home":
      return "#/";
  }
}

/** Reads the hash on boot and on back/forward; writing it never grows history. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(typeof location === "undefined" ? "" : location.hash),
  );
  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export function writeHash(route: Route) {
  const next = formatRoute(route);
  if (location.hash === next) return;
  history.replaceState(null, "", next);
}
