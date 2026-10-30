// Ports, timeouts and delays every other module measures against.

import { Context, Duration } from "effect";

export const BRIDGE_PROTOCOL_VERSION = 2;

/**
 * The most ports dialled on the strength of a token file alone. There is no port
 * range to configure here: a server writes a token file for the port it bound,
 * wherever that is, and the extension dials every port that has one. This only
 * bounds the connections a token directory full of files can create. It matches
 * the most ports one server will try (`--port-range`), so any range the server
 * accepts is found. Ports added in the popup are not counted.
 */
export const MAX_DISCOVERED_PORTS = 64;

/** The most origins remembered as granted; the one confirmed longest ago goes first. */
export const MAX_GRANTED_ORIGINS = 500;

export const DEFAULT_PROFILE_ID = "default";

/** The appex that answers `getTokens` over native messaging. */
export const NATIVE_HOST_ID = "app.eventra.MCPSafari.Extension";

/** Lowest and highest port a user or token may name. */
export const MIN_PORT = 1024;

export const MAX_PORT = 65535;

/**
 * Timing the background depends on. A reference with defaults, so production
 * never provides it and tests can shrink every wait to nothing.
 */
export interface BackgroundTiming {
  readonly reconnectBase: Duration.Duration;
  readonly reconnectMax: Duration.Duration;
  /** How long a discovered port may stay gone before it is suppressed. */
  readonly autoCleanup: Duration.Duration;
  /**
   * How many failed attempts a discovered port that has never answered gets
   * before it is left alone. One home for it: the two places that read it had
   * drifted to `>= 3` and `> 3`, so whether a port survived its fourth failure
   * depended on which one happened to look first.
   */
  readonly autoGiveUpAttempts: number;

  // ─── Website permission gating ───────────────────────────────────────
  //
  // Safari asks for website access with a modal dialog the first time the
  // extension touches an origin, and blocks every extension API for that tab
  // until the dialog is answered. The dialog can open behind another window,
  // where nobody knows it is there, so "blocked" lasts as long as it takes
  // someone to find it.
  //
  // Without a deadline that call rides the server's 30-second bridge timeout and
  // the agent is told the bridge timed out. That is not what happened, it is not
  // something a retry fixes, and it names none of the one action that would fix
  // it. So every tab-touching call is probed first with a cheap injection, and a
  // probe that stalls or fails becomes a named `permission_required`.
  //
  // `permissions.contains` cannot do this job on Safari: it reports what the
  // manifest asked for rather than what the user granted, so it answers true for
  // origins with no access. Probing with a real call is the only reliable test.
  readonly permissionProbe: Duration.Duration;
  /**
   * For gated calls that are quick when permitted and so can be deadlined
   * directly, without the extra round trip a probe costs.
   */
  readonly permissionDeadline: Duration.Duration;
  /**
   * Listing tabs blocks on the same dialog, and no per-tab probe helps because the
   * block is not attributable to one tab. Measured against real Safari, a listing
   * held up this way still completes, in around nine seconds, so this sits just
   * under the bridge timeout rather than anywhere near that. A deadline tight
   * enough to catch the slow case turns a listing that would have arrived into a
   * failure, and tabs_context is the call every session starts with.
   */
  readonly tabListing: Duration.Duration;
  /**
   * Long enough to spare the per-frame calls within one request a probe each,
   * short enough that granting access is picked up on the next retry.
   */
  readonly permissionCache: Duration.Duration;

  // ─── Navigation ──────────────────────────────────────────────────────
  /**
   * How long a page load is given to finish, for `navigate` and for the load an
   * interaction starts. Well under the server's 30-second bridge timeout, which
   * the dispatch before it and the settling after it also have to fit inside.
   */
  readonly navigationTimeout: Duration.Duration;
  /** With no sign of a navigation by now, the call settles on the current tab. */
  readonly noNavigationTimeout: Duration.Duration;
  /** A URL change with no `loading` is a same-document navigation; settle once it goes quiet. */
  readonly sameDocumentSettle: Duration.Duration;
  /**
   * How long after an interaction is dispatched the tab is watched for a page
   * load before concluding the interaction started none. A click on a link or a
   * form submit begins its navigation in the same task as the event, and Safari
   * reports the load within a few tens of milliseconds, so this is a generous
   * margin for that report rather than a guess at page speed. It is also what
   * every click, key press and form change pays when it navigates nowhere,
   * which is why it is not longer. A navigation the page starts later than this,
   * from a timer or after a fetch, is not waited for; a `wait` pending when it
   * begins survives it instead.
   */
  readonly navigationStartWindow: Duration.Duration;

  // ─── Settling delays ─────────────────────────────────────────────────
  /** After activating a tab and focusing its window for native input. */
  readonly nativeFocusSettle: Duration.Duration;
  /** After activating a tab so `captureVisibleTab` sees it. */
  readonly screenshotActivateSettle: Duration.Duration;
  /** After re-injecting the content scripts, before asking again. */
  readonly injectionSettle: Duration.Duration;
}

export const BackgroundTiming = Context.Reference<BackgroundTiming>("mcpsafari/background/BackgroundTiming", {
  defaultValue: () => ({
    reconnectBase: Duration.seconds(1),
    reconnectMax: Duration.seconds(5),
    autoCleanup: Duration.minutes(2),
    autoGiveUpAttempts: 3,
    permissionProbe: Duration.seconds(2),
    permissionDeadline: Duration.seconds(10),
    tabListing: Duration.seconds(25),
    permissionCache: Duration.seconds(2),
    navigationTimeout: Duration.seconds(15),
    noNavigationTimeout: Duration.millis(1500),
    sameDocumentSettle: Duration.millis(500),
    navigationStartWindow: Duration.millis(400),
    nativeFocusSettle: Duration.millis(100),
    screenshotActivateSettle: Duration.millis(300),
    injectionSettle: Duration.millis(100),
  }),
});
