/**
 * Installed in the page's own world, in every frame, before its scripts run.
 * The requests already name Google Chrome (identity.ts); this makes the page's
 * scripts agree. Bot checks compare `navigator.userAgentData` with the
 * `sec-ch-ua` header and look for what `window.chrome` holds in Chrome, and
 * Electron's Chromium has neither, so without this every site behind one of
 * those checks asks the person to prove they are human.
 *
 * Google's sign-in is left to passForFirefoxOnSignIn: there the page has to
 * look like Firefox instead.
 *
 * The preload hands this function to `executeInMainWorld`, which copies its
 * source into the page. It must not close over imports: only its arguments
 * and globals arrive there.
 */
export function passForChrome(target?: object): boolean {
  // No argument when the preload runs it in the page. A test passes its own object.
  type Brand = { brand: string; version: string };
  type Fn = (...args: never[]) => unknown;
  const scope = (target ?? globalThis) as {
    location: { hostname: string; protocol: string };
    chrome?: Record<string, unknown>;
    Function?: { prototype: { toString: () => string } };
    NavigatorUAData?: { prototype: object };
    performance?: {
      timing: Record<string, number>;
      now: () => number;
      getEntriesByType: (type: string) => { name?: string; startTime: number; nextHopProtocol?: string }[];
    };
  };
  if (scope.location.protocol === "https:" && scope.location.hostname === "accounts.google.com") return false;

  // What Function.prototype.toString shows for each replacement: Chrome's own source, which is none.
  const natives = new WeakMap<object, string>();
  const native = <F extends Fn>(fn: F, name: string): F => {
    natives.set(fn, `function ${name}() { [native code] }`);
    return fn;
  };
  const functionProto = scope.Function?.prototype;
  if (functionProto) {
    const original = functionProto.toString;
    Object.defineProperty(functionProto, "toString", {
      configurable: true,
      writable: true,
      enumerable: false,
      value: native(function toString(this: unknown) {
        return (typeof this === "function" && natives.get(this)) || original.call(this);
      }, "toString"),
    });
  }

  // Chrome's list is Chromium's with Google Chrome after it, the way the header has it.
  const withChrome = (list: unknown): unknown => {
    if (!Array.isArray(list)) return list;
    const brands = list as Brand[];
    const chromium = brands.find((b) => b?.brand === "Chromium");
    if (!chromium || brands.some((b) => b?.brand === "Google Chrome")) return list;
    return Object.freeze([...brands.map((b) => ({ brand: b.brand, version: b.version })), { brand: "Google Chrome", version: chromium.version }]);
  };

  const ua = scope.NavigatorUAData?.prototype as Record<string, unknown> | undefined;
  if (ua) {
    const brands = Object.getOwnPropertyDescriptor(ua, "brands");
    const read = brands?.get;
    if (read) {
      // Chrome hands back the same frozen array each time.
      const cached = new WeakMap<object, unknown>();
      Object.defineProperty(ua, "brands", {
        ...brands,
        get: native(function (this: object) {
          const list = read.call(this);
          if (!cached.has(this)) cached.set(this, withChrome(list));
          return cached.get(this);
        }, "get brands"),
      });
    }
    const highEntropy = ua.getHighEntropyValues as ((hints: unknown) => Promise<Record<string, unknown>>) | undefined;
    if (typeof highEntropy === "function") {
      ua.getHighEntropyValues = native(function getHighEntropyValues(this: unknown, hints: unknown) {
        return highEntropy.call(this, hints).then((values) => {
          if ("brands" in values) values.brands = withChrome(values.brands);
          if ("fullVersionList" in values) values.fullVersionList = withChrome(values.fullVersionList);
          return values;
        });
      }, "getHighEntropyValues");
    }
    const serialize = ua.toJSON as (() => Record<string, unknown>) | undefined;
    if (typeof serialize === "function") {
      ua.toJSON = native(function toJSON(this: unknown) {
        const out = serialize.call(this);
        if ("brands" in out) out.brands = withChrome(out.brands);
        return out;
      }, "toJSON");
    }
  }

  // Chrome's window.chrome on a page no extension talks to: loadTimes, csi and app.
  const chrome = scope.chrome;
  const perf = scope.performance;
  if (chrome && typeof chrome === "object" && !("app" in chrome)) {
    const navEntry = () => perf?.getEntriesByType("navigation")[0];
    const firstPaint = () => perf?.getEntriesByType("paint").find((e) => e.name === "first-paint")?.startTime;
    chrome.loadTimes = native(function loadTimes() {
      const t = perf?.timing ?? {};
      const start = t.navigationStart ?? 0;
      const paint = firstPaint();
      const protocol = navEntry()?.nextHopProtocol ?? "";
      const spdy = protocol === "h2" || protocol === "h3";
      return {
        requestTime: start / 1000,
        startLoadTime: start / 1000,
        commitLoadTime: (t.responseStart ?? 0) / 1000,
        finishDocumentLoadTime: (t.domContentLoadedEventEnd ?? 0) / 1000,
        finishLoadTime: (t.loadEventEnd ?? 0) / 1000,
        firstPaintTime: paint === undefined ? 0 : (start + paint) / 1000,
        firstPaintAfterLoadTime: 0,
        navigationType: "Other",
        wasFetchedViaSpdy: spdy,
        wasNpnNegotiated: spdy,
        npnNegotiatedProtocol: spdy ? protocol : "unknown",
        wasAlternateProtocolAvailable: false,
        connectionInfo: protocol || "http/1.1",
      };
    }, "loadTimes");
    chrome.csi = native(function csi() {
      const t = perf?.timing ?? {};
      return {
        startE: t.navigationStart ?? 0,
        onloadT: t.domContentLoadedEventEnd ?? 0,
        pageT: perf?.now() ?? 0,
        tran: 15,
      };
    }, "csi");
    chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
      RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
      getDetails: native(function getDetails() {
        return null;
      }, "getDetails"),
      getIsInstalled: native(function getIsInstalled() {
        return false;
      }, "getIsInstalled"),
      installState: native(function installState(callback?: (state: string) => void) {
        if (typeof callback === "function") setTimeout(() => callback("not_installed"), 0);
      }, "installState"),
      runningState: native(function runningState() {
        return "cannot_run";
      }, "runningState"),
    };
  }
  return true;
}
