import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from "firebase/ai";
import { firebaseConfig, RECAPTCHA_SITE_KEY, CLOUD_MODEL } from "./firebase-config.js";

export { CLOUD_MODEL };

export const app = initializeApp(firebaseConfig);

// In `npm run dev` only: use the App Check debug provider. The token comes from the
// gitignored .env.local; if it's blank the SDK generates one and logs it to the console.
if (import.meta.env.DEV) {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN || true;
}

export const appCheck = initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
});

// Limited-use tokens enable App Check replay protection.
export const ai = getAI(app, {
  backend: new GoogleAIBackend(),
  useLimitedUseAppCheckTokens: true,
});

// Hybrid model: Gemini Nano in Chrome when available, cloud Gemini otherwise.
export const model = getGenerativeModel(ai, {
  mode: InferenceMode.PREFER_ON_DEVICE,
  inCloudParams: { model: CLOUD_MODEL },
  onDeviceParams: {
    createOptions: {
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    },
  },
}, {
  // SDK default is 180s, which looks like a hang when the cloud model is overloaded.
  timeout: 30_000,
});
