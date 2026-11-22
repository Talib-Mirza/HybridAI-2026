import { initializeApp } from "firebase/app";
import { initializeAppCheck, CustomProvider } from "firebase/app-check";
import { getAI, getGenerativeModel as sdkModel, GoogleAIBackend, InferenceMode } from "firebase/ai";
import { firebaseConfig, CLOUD_MODEL } from "../../src/firebase-config.js";

// Manifest V3 extensions can't load reCAPTCHA's remote script, so the extension authenticates to
// App Check with a debug token (the hackathon rules accept these). The token is read at build time
// from the gitignored .env.local and is never committed; dist-extension/ is gitignored too.
self.FIREBASE_APPCHECK_DEBUG_TOKEN = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true;

export const app = initializeApp(firebaseConfig);

initializeAppCheck(app, {
  // Never called while a debug token is set; it only satisfies the API.
  provider: new CustomProvider({
    getToken: () => Promise.reject(new Error("Waypoint uses an App Check debug token")),
  }),
  isTokenAutoRefreshEnabled: true,
});

// Limited-use tokens enable App Check replay protection.
export const ai = getAI(app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true });

// Route planning: fast, reliable flash-lite. (gemini-3.8-flash was timing out from demand in testing;
// pipeline.js falls back to CLOUD_MODEL if this ever fails.)
export const PLANNER_MODEL = "gemini-3.5-flash-lite";

// ---------- Availability: which side can run right now ----------
// Every model in Waypoint is made through getGenerativeModel below, so this is the one place that knows
// whether Gemini Nano and cloud Gemini can be used. Calls are re-routed to the side that's up:
//   - no Nano: "prefer on-device" goes to the cloud; "on-device only" fails fast (the caller then sends the
//     cloud a smaller prompt, so page text still never leaves the device);
//   - no cloud: "prefer on-device" stays on the device; "cloud only" fails fast (the caller falls back).
// The cloud counts as down while the browser is offline, and for a short while after a call fails for a
// connectivity reason (network, quota, App Check), so a guide doesn't wait on the same failure again.
// Trace's "Simulate an outage" setting turns either side off to try the fallbacks.
export class Unavailable extends Error {
  constructor(side, reason) {
    super(side === "device" ? `Gemini Nano is unavailable: ${reason}` : `Cloud Gemini is unavailable: ${reason}`);
    this.unavailable = side; // "device" | "cloud"
    this.reason = reason;
  }
}
const sim = { device: true, cloud: true };
let cloudDown = { until: 0, reason: "" };
let onChange = () => {};
const CLOUD_RETRY_MS = 45_000;
const NET = /fetch|network|offline|ERR_|quota|exhausted|\b429\b|\b50[0-4]\b|app.?check|\b403\b|api key|permission denied|unauthenti/i;

export function setSimulation(s) {
  sim.device = !(s === "no-nano" || s === "neither");
  sim.cloud = !(s === "no-cloud" || s === "neither");
  onChange();
}
export function onAvailabilityChange(fn) {
  onChange = fn;
}
export function deviceUsable() {
  return sim.device;
}
/** null when the cloud can be used, else why not (in words). */
export function cloudProblem() {
  if (!sim.cloud) return "turned off by Simulate an outage";
  if (globalThis.navigator?.onLine === false) return "this computer is offline";
  if (Date.now() < cloudDown.until) return cloudDown.reason;
  return null;
}
function cloudFailed(e) {
  const msg = String(e?.message || e);
  if (e?.unavailable || !NET.test(msg)) return;
  const reason = /quota|exhausted|429/i.test(msg)
    ? "its quota is used up for now"
    : /app.?check|403|permission|unauthenti|api key/i.test(msg)
      ? "it refused this extension's App Check token"
      : "it couldn't be reached";
  const was = cloudProblem();
  cloudDown = { until: Date.now() + CLOUD_RETRY_MS, reason };
  if (!was) onChange();
  setTimeout(() => !cloudProblem() && onChange(), CLOUD_RETRY_MS + 50);
}

function failing(err) {
  const reject = () => Promise.reject(err);
  return { generateContent: reject, generateContentStream: reject };
}

export function getGenerativeModel(aiInstance, cfg, opts) {
  const cloudWhy = cloudProblem();
  const deviceOk = sim.device;
  let mode = cfg.mode;
  if (mode === InferenceMode.ONLY_ON_DEVICE && !deviceOk) return failing(new Unavailable("device", "turned off by Simulate an outage"));
  if (mode === InferenceMode.ONLY_IN_CLOUD && cloudWhy) return failing(new Unavailable("cloud", cloudWhy));
  if (mode === InferenceMode.PREFER_ON_DEVICE && !deviceOk) {
    if (cloudWhy) return failing(new Unavailable("cloud", `${cloudWhy}, and Gemini Nano is off`));
    mode = InferenceMode.ONLY_IN_CLOUD;
  } else if (mode === InferenceMode.PREFER_ON_DEVICE && cloudWhy) mode = InferenceMode.ONLY_ON_DEVICE;
  const model = sdkModel(aiInstance, { ...cfg, mode }, opts);
  if (mode === InferenceMode.ONLY_ON_DEVICE) return model;
  // Calls that may reach the cloud: a connectivity failure marks the cloud as down for a while.
  return {
    generateContent: (...a) => model.generateContent(...a).catch((e) => (cloudFailed(e), Promise.reject(e))),
    generateContentStream: (...a) => model.generateContentStream(...a).catch((e) => (cloudFailed(e), Promise.reject(e))),
  };
}

export { InferenceMode, CLOUD_MODEL };
