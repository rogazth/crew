/**
 * Mermaid is the heaviest thing a note can ask for, so it loads on the first
 * diagram and never for a note without one. Renders are cached by source and
 * scheme: scrolling a diagram back into view costs nothing.
 */

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
let theme: string | null = null;
let next = 0;
const MAX_CACHED = 50;
const cache = new Map<string, Promise<string>>();
/** Finished renders, so a widget redrawn for a known diagram paints at full height at once. */
const done = new Map<string, string>();

const keyOf = (source: string, dark: boolean) => `${dark ? "d" : "l"}\0${source}`;

export function renderedMermaid(source: string, dark: boolean): string | undefined {
  return done.get(keyOf(source, dark));
}

const scheme = () => window.matchMedia("(prefers-color-scheme: dark)");

/** The scheme the page renders in, which kumo sets and `light-dark()` follows; not the OS setting. */
export function isDark(): boolean {
  if (typeof document === "undefined") return false;
  return getComputedStyle(document.documentElement).colorScheme.split(" ").includes("dark");
}

/** Fires when either the OS scheme or kumo's `data-mode` changes. */
export function onSchemeChange(listener: () => void): () => void {
  const query = scheme();
  query.addEventListener("change", listener);
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "class", "style"] });
  return () => {
    query.removeEventListener("change", listener);
    observer.disconnect();
  };
}

function load(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}

/** The diagram as SVG markup. Mermaid sanitizes it: `strict` drops scripts and click handlers. */
export function renderMermaid(source: string, dark: boolean): Promise<string> {
  const key = keyOf(source, dark);
  let svg = cache.get(key);
  if (!svg) {
    svg = load().then(async (mermaid) => {
      const wanted = dark ? "dark" : "neutral";
      if (theme !== wanted) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: wanted,
          fontFamily: "inherit",
        });
        theme = wanted;
      }
      const { svg } = await mermaid.render(`crew-mermaid-${next++}`, source);
      done.set(key, svg);
      if (done.size > MAX_CACHED) done.delete(done.keys().next().value!);
      return svg;
    });
    svg.catch(() => cache.delete(key));
    cache.set(key, svg);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  return svg;
}
