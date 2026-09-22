declare const __CREW_SHA__: string;

// esbuild replaces the identifier at compile time; `typeof` keeps a bundle built
// without the define from throwing a ReferenceError here.
export const sha: string = typeof __CREW_SHA__ === "string" ? __CREW_SHA__ : "unknown";
