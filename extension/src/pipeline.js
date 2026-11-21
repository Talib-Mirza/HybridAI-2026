// Waypoint's two AI jobs:
//   pickElement — on-device (Gemini Nano) grounding: choose ONE control from a shortlist of real ids.
//   planRoute   — cloud (Gemini + Google Search) planning: a multi-page route described in words.
import { ai, getGenerativeModel, InferenceMode, CLOUD_MODEL, PLANNER_MODEL } from "./firebase-ext.js";

const STOP = new Set(
  "the and for how what where this that with can you want need please into from page button click firebase console get let set use".split(" ")
);
const SYNONYMS = {
  enable: ["enforce", "activate", "turn on"],
  disable: ["unenforce", "deactivate", "turn off"],
  enforce: ["enforced", "enforcement"],
  add: ["create", "new", "register", "manage"],
  register: ["add", "manage"],
  remove: ["delete", "revoke"],
  delete: ["remove", "revoke"],
  setting: ["settings", "config", "configure"],
  debug: ["debug"],
  token: ["tokens"],
};

const stem = (w) => w.slice(0, 5);
const words = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

function queryStems(question) {
  const set = new Set();
  for (const w of words(question)) {
    set.add(stem(w));
    for (const syn of SYNONYMS[w] || []) words(syn).forEach((x) => set.add(stem(x)));
  }
  return set;
}

function score(item, stems) {
  let s = 0;
  for (const w of words(item.label)) if (stems.has(stem(w))) s += 3;
  for (const w of words(item.context)) if (stems.has(stem(w))) s += 1;
  return s;
}

/** Cheap, deterministic pre-filter so the prompt fits Gemini Nano's small context. */
export function shortlist(question, items, k = 40) {
  if (items.length <= k) return items;
  const stems = queryStems(question);
  return items
    .map((it, idx) => ({ it, idx, s: score(it, stems) }))
    .sort((a, b) => b.s - a.s || a.idx - b.idx)
    .slice(0, k)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.it);
}

/** True when some visible control's label shares a word with the target (used to wait for slow pages). */
export function hasKeywordHit(target, items) {
  const stems = queryStems(target);
  return items.some((it) => words(it.label).some((w) => stems.has(stem(w))));
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Rung 1 of the ladder: an exact visible-label match needs no model at all. */
export function exactMatch(target, items) {
  const t = norm(target);
  if (!t) return null;
  return items.find((it) => norm(it.label) === t && !it.state.includes("disabled")) || null;
}

export const line = (it) =>
  [it.id, it.role, `"${it.label}"`, it.context, it.state].filter(Boolean).join(" | ");

const pageHeader = (outline) =>
  `Page title: ${outline.title}\nPage path: ${outline.path}\nPage headings: ${outline.headings.join(" / ") || "(none)"}`;

/** On-device first: Nano picks one id from an enum of real candidates, so it cannot invent an element. */
export async function pickElement({ question, outline, forceCloud = false }) {
  const cands = shortlist(question, outline.items);
  if (!cands.length) return { elementId: "none", confidence: 0, explanation: "No controls on this page.", source: "none" };

  const schema = {
    type: "object",
    properties: {
      elementId: { type: "string", enum: [...cands.map((c) => c.id), "none"] },
      confidence: { type: "number" },
      completesGoal: { type: "boolean" },
      alreadyDone: { type: "boolean" },
      explanation: { type: "string" },
    },
    required: ["elementId", "confidence", "completesGoal", "alreadyDone", "explanation"],
  };

  const model = getGenerativeModel(
    ai,
    {
      mode: forceCloud ? InferenceMode.ONLY_IN_CLOUD : InferenceMode.PREFER_ON_DEVICE,
      inCloudParams: {
        model: CLOUD_MODEL,
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0 },
      },
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: "text", languages: ["en"] }],
          expectedOutputs: [{ type: "text", languages: ["en"] }],
        },
        promptOptions: { responseConstraint: schema },
      },
    },
    { timeout: 30_000 }
  );

  const prompt = `You are Waypoint, a guide that points a user to the right control on a web page.
${pageHeader(outline)}

The user wants: "${question}"

Candidate controls on this page (id | role | label | context | state):
${cands.map(line).join("\n")}

Choose the single control the user should interact with NEXT to make progress on what they want. Prefer a control whose label matches the request. If no candidate helps, choose "none".
confidence: 0 to 1, how sure you are that this is the right control.
completesGoal: true only if using this control directly accomplishes what the user wants, here on this page; false if it is only a first step that leads to another page.
alreadyDone: true only if the chosen control's state or row cells show the user's goal is ALREADY in place (for example a status reading "Enforced" when they want to enforce); otherwise false.
explanation: one short sentence (max 25 words) telling the user what to do with this control and why.`;

  const t0 = performance.now();
  const result = await model.generateContent(prompt);
  const r = result.response;
  const out = JSON.parse(r.text());
  return {
    ...out,
    source: r.inferenceSource,
    ms: Math.round(performance.now() - t0),
    sent: prompt,
    candidates: cands.length,
    total: outline.items.length,
  };
}

function extractJson(text) {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Planner returned no JSON");
  return JSON.parse(text.slice(a, b + 1));
}

/** Escalation: cloud Gemini, grounded with Google Search, plans the route in words (never selectors). */
export async function planRoute({ goal, outline }) {
  const nav = outline.items
    .slice(0, 70)
    .map((it) => [it.role, `"${it.label}"`, it.context, it.state].filter(Boolean).join(" | "));
  const prompt = `You are guiding a user through the Firebase console web UI (console.firebase.google.com). Use your knowledge of the current Firebase console layout and documentation.

Goal: "${goal}"

The user is currently on:
${pageHeader(outline)}
Visible controls on this page (role | label | context | state; personal values are redacted):
${nav.join("\n")}

Return the steps as JSON: each step has "instruction" (short imperative sentence for the user), "target" (the control's visible label exactly as it appears on screen) and "where" (where on screen it is).

Example of a complete route for a DIFFERENT goal ("turn on email/password sign-in", starting from the console home page):
1. target "My Project" — open the project from its card
2. target "Build" — expand Build in the left navigation
3. target "Authentication" — open Authentication
4. target "Sign-in method" — open the Sign-in method tab
5. target "Email/Password" — open the Email/Password provider row
6. target "Enable" — switch Enable on, then review and save yourself

Rules:
- Plan the COMPLETE route from the current page to the goal, including steps on pages the user hasn't reached yet. You only see the current page's controls; for later pages, use your knowledge of the console's left navigation, tabs and buttons.
- Start from the CURRENT page. At most 8 steps. Each step is one click or one field to fill.
- "target" must be visible text in the console UI: a left-navigation item, a tab name, a row name or a button label.
- If a step means opening a project, use the project's name exactly as shown on its card as the target.
- Never invent values or secrets. Stop before any final irreversible confirmation and tell the user to review it themselves.`;

  // Note: Google Search grounding returns 429 on the free tier, so planning runs ungrounded for now;
  // docs grounding will come from fetching the relevant Firebase docs page ourselves.
  const run = async (modelName, timeout) => {
    const schema = {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              instruction: { type: "string" },
              target: { type: "string" },
              where: { type: "string" },
            },
            required: ["instruction", "target", "where"],
          },
        },
      },
      required: ["steps"],
    };
    const model = getGenerativeModel(
      ai,
      {
        mode: InferenceMode.ONLY_IN_CLOUD,
        inCloudParams: {
          model: modelName,
          generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseJsonSchema: schema },
        },
      },
      { timeout }
    );
    const t0 = performance.now();
    const result = await model.generateContent(prompt);
    const r = result.response;
    const plan = extractJson(r.text());
    return {
      steps: plan.steps || [],
      model: modelName,
      grounded: !!r.candidates?.[0]?.groundingMetadata,
      ms: Math.round(performance.now() - t0),
      sent: prompt,
    };
  };

  try {
    return await run(PLANNER_MODEL, 15_000);
  } catch (e) {
    console.warn("[Waypoint] planner fallback:", e?.message);
    return await run(CLOUD_MODEL, 30_000);
  }
}
