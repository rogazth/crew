declare const __CREW_SHA__: string;
declare const __CREW_RELEASE__: boolean;

// esbuild replaces the identifier at compile time; `typeof` keeps a bundle built
// without the define from throwing a ReferenceError here.
export const sha: string = typeof __CREW_SHA__ === "string" ? __CREW_SHA__ : "unknown";
// Only scripts/release-publish.mjs compiles with it on: every other package is a local one.
export const release: boolean = typeof __CREW_RELEASE__ === "boolean" ? __CREW_RELEASE__ : false;
