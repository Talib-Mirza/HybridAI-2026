import { initializeApp } from "firebase/app";
import { initializeAppCheck, CustomProvider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from "firebase/ai";
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

export { getGenerativeModel, InferenceMode, CLOUD_MODEL };
