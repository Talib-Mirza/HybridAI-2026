// Waypoint's two AI jobs:
//   pickElement — on-device (Gemini Nano) grounding: choose ONE control from a shortlist of real ids.
//   planRoute   — cloud Gemini planning: a multi-page route described in words, re-planned from the
//                 live page whenever a step isn't where the plan expected.
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
  // Menus and hover-revealed controls are how hidden things are reached: keep them in the shortlist.
  let s = /collapsed|on hover/.test(item.state || "") ? 1 : 0;
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
  return items.find((it) => norm(it.label) === t && !/disabled|current|selected/.test(it.state)) || null;
}

/** The step's target is where the user already is (the current nav link or the selected tab). */
export function alreadyHere(target, items) {
  const t = norm(target);
  return !!t && items.some((it) => norm(it.label) === t && /current|selected/.test(it.state));
}

/**
 * No-AI "already done" check: the matched control's status shows the goal's action in the past tense
 * (goal "enforce …" and a row reading "Enforced", "enable" → "Enabled"). Negated forms don't count.
 */
export function looksDone(goal, item) {
  const verbs = new Set(words(goal).map(stem));
  const parts = [...(item.context || "").replace(/^row cells:\s*/, "").split(" · "), item.state || ""];
  const hit = parts.find((p) => words(p).some((w) => /ed$/.test(w) && !/^(un|not|dis)/.test(w) && verbs.has(stem(w))));
  return hit ? hit.trim() : null; // the status text that shows it, e.g. "Basic - Enforced Replay - Monitoring"
}

/**
 * Does the label name something specific to the goal, beyond the page's own topic? ("Ask Gemini about
 * App Check" on the App Check page shares only the page's topic with "manage App Check debug tokens".)
 */
export function specificToGoal(goal, label, outline) {
  const topic = new Set(words(`${outline.title} ${outline.headings.join(" ")}`).map(stem));
  const goalStems = [...queryStems(goal)].filter((st) => !topic.has(st));
  const labelStems = new Set(words(label).map(stem));
  return goalStems.some((st) => labelStems.has(st));
}

export const line = (it) =>
  [it.id, it.role, `"${it.label}"`, it.context, it.state].filter(Boolean).join(" | ");

const pageHeader = (outline) =>
  `Page title: ${outline.title}\nPage path: ${outline.path}\nPage headings: ${outline.headings.join(" / ") || "(none)"}`;

/**
 * Compact candidate lines for Nano: a context fragment shared by most candidates (e.g. every control is
 * "under" the app's name) carries no information, so it is dropped to keep the prompt short.
 */
function compactLines(cands) {
  const count = new Map();
  for (const c of cands) for (const f of new Set((c.context || "").split("; "))) count.set(f, (count.get(f) || 0) + 1);
  const common = new Set([...count].filter(([f, n]) => f && n > cands.length / 2).map(([f]) => f));
  return cands.map((c) => {
    const ctx = (c.context || "").split("; ").filter((f) => f && !common.has(f)).join("; ");
    return [c.id, c.role, `"${c.label}"`, ctx, c.state].filter(Boolean).join(" | ");
  });
}

/**
 * On-device first: Nano picks one id from an enum of real candidates, so it cannot invent an element.
 * Kept deliberately lean: Nano's time goes mostly into writing output, so it returns only an id and two
 * flags (no free-text explanation or self-rated confidence); the bubble text comes from the label or plan.
 */
export async function pickElement({ question, outline, forceCloud = false }) {
  const cands = shortlist(question, outline.items, 30);
  if (!cands.length) return { elementId: "none", source: "none", candidates: 0, total: 0 };

  const schema = {
    type: "object",
    properties: {
      elementId: { type: "string", enum: [...cands.map((c) => c.id), "none"] },
      completesGoal: { type: "boolean" },
      opensMenu: { type: "boolean" },
    },
    required: ["elementId", "completesGoal", "opensMenu"],
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

Controls on this page (id | role | label | context | state):
${compactLines(cands).join("\n")}

Choose the control the user should use NEXT. Prefer one whose label matches the request. State "current" is the page the user is already on: never choose it. State "hidden" or "on hover" controls exist but need a menu opened or the row hovered; you may choose them. If the needed control isn't listed but probably sits inside a collapsed menu (state "collapsed"), choose that menu. If nothing helps, choose "none".
completesGoal: true only if using this control directly does what the user wants, on this page.
opensMenu: true if you chose a collapsed menu to reveal what the user needs.`;

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

/**
 * Escalation: cloud Gemini plans the route in words (never selectors). Site-agnostic: it only sees the
 * goal and the current page's redacted outline. When a step can't be found, it is called again with the
 * steps already done and the missing target, so it re-plans from what is actually on screen.
 */
export async function planRoute({ goal, outline, done = [], failed = null }) {
  // Navigation and menu toggles first: they carry the app's structure, which is what a route needs.
  const isNav = (it) => /collapsed|expanded|hidden/.test(it.state) || /navigation/.test(it.context);
  const nav = [...outline.items.filter(isNav), ...outline.items.filter((it) => !isNav(it))]
    .slice(0, 80)
    .map((it) => [it.role, `"${it.label}"`, it.context, it.state].filter(Boolean).join(" | "));
  const replan = failed
    ? `\nSteps the user has already completed: ${done.length ? done.map((d) => `"${d}"`).join(" → ") : "(none)"}
The previous plan expected a control labelled "${failed}" on this page, but it is NOT here. That plan was wrong or out of date. Re-plan the remaining route from the controls that ARE on this page.\n`
    : "";
  const prompt = `You are guiding a user through a web app's UI. Use your knowledge of this app's current layout, but trust the visible controls over your memory: apps get redesigned and renamed.

Goal: "${goal}"

The user is currently on:
${pageHeader(outline)}
Visible controls on this page (role | label | context | state; personal values are redacted):
${nav.join("\n")}
${replan}

Return the steps as JSON: each step has "instruction" (short imperative sentence for the user), "target" (the control's visible label exactly as it appears on screen) and "where" (where on screen it is).

Example of a complete route in a DIFFERENT app (goal "invite a teammate to my workspace", starting on the dashboard, where the left navigation has collapsed sections "Workspace" and "Billing"):
1. target "Acme Team" — open the workspace from its card
2. target "Workspace" — open the collapsed Workspace section in the left navigation
3. target "Members" — open Members
4. target "Invite" — click Invite
5. target "Email address" — type the teammate's email, then review and send it yourself

Rules:
- Plan the COMPLETE route from the current page to the goal, including steps on pages the user hasn't reached yet. You only see the current page's controls; for later pages, use your knowledge of the app's navigation, tabs and buttons.
- Start from the CURRENT page. At most 8 steps. Each step is one click or one field to fill.
- "target" must be visible text in the UI: a navigation item, a tab name, a row name or a button label. When the next control is already listed above, use its label exactly.
- Controls with state "collapsed" are menus or sections whose items are NOT listed above. Apps reorganise their navigation into such groups, so if the item you need isn't listed, open the collapsed group whose name best fits it (e.g. a "Users" page usually sits under a group like "Admin" or "People"), then continue with the item itself.
- State "current" or "selected" marks where the user already is: never make it a step.
- Actions on one specific item (an app, user, file, key) usually live in that item's own row menu, e.g. a "⋮", "More" or "Open menu for <item>" button, often shown only on hover. Include the step that opens it before the action itself.
- Navigate with the app's own navigation, tabs and buttons. Don't route through a search box unless no listed control or collapsed group could lead there.
- If a step means opening a project, use the project's name exactly as shown on its card as the target.
- Never invent values or secrets. Stop before any final irreversible confirmation and tell the user to review it themselves.`;

  // Deliberately ungrounded: re-planning from the live page corrects stale knowledge on any site, with
  // no Search latency or billing (Search grounding also returns 429 on the free tier).
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
