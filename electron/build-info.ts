declare const __CREW_SHA__: string;
declare const __CREW_RELEASE__: boolean;

// esbuild replaces the identifier at compile time; `typeof` keeps a bundle built
// without the define from throwing a ReferenceError here.
export const sha: string = typeof __CREW_SHA__ === "string" ? __CREW_SHA__ : "unknown";
// Only scripts/release-publish.mjs compiles with it on: every other package is a local one.
export const release: boolean = typeof __CREW_RELEASE__ === "boolean" ? __CREW_RELEASE__ : false;

declare const __CREW_UPDATE_FEED__: { releases: string; key: string } | null;
/**
 * A stand-in release feed and the key it signs with. Only scripts/update-e2e.mjs
 * compiles one in, to walk a local build through real updates; every other
 * build, the published one included, reads GitHub and checks Crew's key.
 */
export const updateFeed: { releases: string; key: string } | null =
  typeof __CREW_UPDATE_FEED__ === "object" ? __CREW_UPDATE_FEED__ : null;
