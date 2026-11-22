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
  // Repeated controls ("Expand this log entry" × 30) would crowd out everything else: keep two of each.
  const seenLabel = new Map();
  items = items.filter((it) => {
    const key = `${it.role}|${it.label}`;
    const n = (seenLabel.get(key) || 0) + 1;
    seenLabel.set(key, n);
    return n <= 2;
  });
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

/**
 * Could this control be the kind of thing the plan described? Strict only where names collide in
 * practice: a plan's "Settings" tab must not land on the app's "Settings" navigation item, and a form
 * field must be something you can type in or toggle.
 */
export function kindFits(kind, item) {
  if (!kind || !item) return true;
  const nav = /navigation/.test(item.context || "");
  const field = /^(textbox|combobox|select|checkbox|switch|radio|searchbox|spinbutton)$/.test(item.role);
  switch (kind) {
    case "tab":
      return item.role === "tab" || (!nav && /^(link|button)$/.test(item.role));
    case "field":
      return field;
    case "menu item":
      // An option in a popup menu a previous step opened, never the app's always-visible navigation.
      return !field && !nav;
    case "row":
      // An item in a list: the row itself or the link that names it, not an icon button in its cells.
      return item.role === "row" || item.role === "link" || item.role === "treeitem" || item.role === "option";
    default:
      // Planners blur navigation / button / row; only clear mismatches count (typing into a link).
      return !field || kind === "navigation";
  }
}

/** Rung 1 of the ladder: an exact visible-label match needs no model at all. */
export function exactMatch(target, items, kind = null) {
  const t = norm(target);
  if (!t) return null;
  const hits = items.filter((it) => norm(it.label) === t && !/disabled|current|selected/.test(it.state) && kindFits(kind, it));
  // Same name twice: one the user can actually reach (not behind an open drawer or dialog) first; then
  // the page's own control over the app's navigation ("Settings" tab vs "Settings" menu).
  const reachable = hits.filter((it) => !/covered/.test(it.state));
  const pool = reachable.length ? reachable : hits;
  return pool.find((it) => it.main) || pool[0] || null;
}

/**
 * Near-exact match, still no AI: a visible label whose words are all in the planned target (the plan
 * said "Open menu for X Web App", the button says "Open menu for X"), at least two words and most of the
 * target. Ties go to the longest label.
 */
export function closeMatch(target, items, kind = null) {
  const t = norm(target).split(" ").filter(Boolean);
  if (t.length < 2) return null;
  const want = new Set(t);
  let best = null;
  for (const it of items) {
    if (/disabled|current|selected/.test(it.state) || !kindFits(kind, it)) continue;
    const l = norm(it.label).split(" ").filter(Boolean);
    if (l.length < 2 || !l.every((w) => want.has(w)) || l.length / t.length < 0.6) continue;
    const bl = best ? norm(best.label).split(" ").length : 0;
    const better =
      !best ||
      (/covered/.test(best.state) && !/covered/.test(it.state)) ||
      (!/covered/.test(it.state) === !/covered/.test(best.state) && (l.length > bl || (l.length === bl && it.main && !best.main)));
    if (better) best = it;
  }
  return best;
}

/** The step's target is where the user already is (the current nav link or the selected tab). */
export function alreadyHere(target, items) {
  const t = norm(target);
  // Accessible labels can wrap the visible text, e.g. "Selected Tab: APIs" for the "APIs" tab.
  return !!t && items.some((it) => ` ${norm(it.label)} `.includes(` ${t} `) && /current|selected/.test(it.state));
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
  // The user's own words only: synonyms help find candidates, but aren't evidence ("add" ≈ "new" matched
  // "opens in new tab").
  // "…debug tokens for HybridAI-2026": the trailing "for/in/on X" is where it lives, not what to do, so
  // "Open HybridAI-2026" is a step on the way, not the goal itself.
  const core = goal.replace(/[?.!]+$/, "").replace(/\s+(?:for|in|on|within|inside|under|from)\s+(?:the\s+|my\s+|our\s+)?[^\s,]+(?:\s+(?:project|app|account|workspace|site|org))?$/i, "");
  // "Open AudioLibrary" doesn't complete "delete the AudioLibrary project": opening is only the way in.
  if (/^(?:open|go to|view)\b/i.test(label.trim()) && !/^(?:please\s+)?(?:open|go to|view|show|take me|where (?:is|are|do i find))\b/i.test(goal.trim())) return false;
  const coreUse = words(core).filter((w) => !topic.has(stem(w))).length >= 2 ? core : goal;
  const goalStems = words(coreUse).map(stem).filter((st) => !topic.has(st));
  const labelStems = new Set(words(label).map(stem));
  return goalStems.some((st) => labelStems.has(st));
}

/** "Open X" / "go to X" / "show me X" → "X" (else null). */
export function navTarget(goal) {
  const m = goal.trim().match(/^(?:please\s+)?(?:open|go to|show(?: me)?|take me to|navigate to|bring up)\s+(?:the\s+|my\s+)?(.+?)[.!?]*$/i);
  return m ? m[1] : null;
}

/** "Open X" / "go to X" / "show me X": does this label name X? Then clicking it is the whole job. */
export function namesNavTarget(goal, label) {
  const t = navTarget(goal);
  if (!t) return false;
  const want = words(t).map(stem);
  const have = new Set(words(label).map(stem));
  return want.length > 0 && want.every((st) => have.has(st));
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
  // Doc links are never the control to use, unless the user is asking for docs.
  const usable = /\bdocs?\b|documentation|learn more/i.test(question) ? outline.items : outline.items.filter((it) => !DOC_LINK.test(it.label));
  const cands = shortlist(question, usable, 30);
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

Choose the control the user should use NEXT. Prefer one whose label matches the request. If the request says it's a row, choose the row or the link that names the item, not an icon or button inside the row. State "current" is the page the user is already on: never choose it. State "covered" means something (an open drawer or dialog) is on top of it right now: prefer an uncovered control. State "hidden" or "on hover" controls exist but need a menu opened or the row hovered; you may choose them. If the needed control isn't listed but probably sits inside a collapsed menu (state "collapsed"), choose that menu. If nothing helps, choose "none".
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
export async function planRoute({ goal, outline, done = [], failed = null, unfinished = false, vanished = false, docs = "" }) {
  // Navigation and menu toggles first: they carry the app's structure, which is what a route needs.
  const isNav = (it) => /collapsed|expanded|hidden/.test(it.state) || /navigation/.test(it.context);
  const nav = [...outline.items.filter(isNav), ...outline.items.filter((it) => !isNav(it))]
    .slice(0, 80)
    .map((it) => [it.role, `"${it.label}"`, it.context, it.state].filter(Boolean).join(" | "));
  const doneList = done.length ? done.map((d) => `"${d}"`).join(" → ") : "(none)";
  const replan = unfinished
    ? `\nSteps the user has already completed: ${doneList}
They have NOT reached the goal yet. Plan the remaining steps from the controls on this page through to the goal.\n`
    : failed && vanished
    ? `\nSteps the user has already completed: ${doneList}
The control "${failed}" was on screen on THIS page a moment ago and is hidden now: a menu, drawer or panel it sits in has closed. Plan the shortest way back to it, normally reopening that menu or drawer (look for a collapsed control above) and then "${failed}". Don't switch to a different route.\n`
    : failed
    ? `\nSteps the user has already completed: ${done.length ? done.map((d) => `"${d}"`).join(" → ") : "(none)"}
The previous plan expected a control labelled "${failed}" on this page, but it is NOT here. That plan was wrong or out of date. Re-plan the remaining route from the controls that ARE on this page.\n`
    : "";
  const prompt = `You are guiding a user through a web app's UI. Use your knowledge of this app's current layout, but trust the visible controls over your memory: apps get redesigned and renamed.

Goal: "${goal}"

The user is currently on:
${pageHeader(outline)}
Visible controls on this page (role | label | context | state; personal values are redacted):
${nav.join("\n")}
${replan}${docs ? `
From the app's official documentation (more current than your memory: follow it for where settings live and what they're called):
"""
${docs}
"""
` : ""}
Return the steps as JSON: each step has "instruction" (short imperative sentence for the user), "target" (the control's visible label exactly as it appears on screen), "kind" (navigation = an item in the app's sidebar or top menu; tab = a tab on the page; button; row = a row in a table or list; menu item = an option inside a menu that a previous step opened; field = something to type in or toggle) and "where" (where on screen it is).

Example of a complete route in a DIFFERENT app (goal "invite a teammate to my workspace", starting on the dashboard, where the left navigation has collapsed sections "Workspace" and "Billing"):
1. target "Acme Team" — open the workspace from its card
2. target "Workspace" — open the collapsed Workspace section in the left navigation
3. target "Members" — open Members
4. target "Invite" — click Invite
5. target "Email address" — type the teammate's email, then review and send it yourself

Rules:
- Plan the COMPLETE route from the current page to the goal, including steps on pages the user hasn't reached yet. You only see the current page's controls; for later pages, use your knowledge of the app's navigation, tabs and buttons.
- Start from the CURRENT page. If a control on this page already leads toward the goal (e.g. the row of the item the goal is about), start there; don't send the user to another tab or page first.
- At most 8 steps. Each step is one click or one field to fill.
- "target" must be visible text in the UI: a navigation item, a tab name, a row name or a button label. When the next control is already listed above, use its label exactly.
- Controls with state "collapsed" are menus or sections whose items are NOT listed above. Apps reorganise their navigation into such groups, so if the item you need isn't listed, open the collapsed group whose name best fits it (e.g. a "Users" page usually sits under a group like "Admin" or "People"), then continue with the item itself.
- State "current" or "selected" marks where the user already is: never make it a step.
- Actions on one specific item (an app, user, file, key) usually live in that item's own row menu, e.g. a "⋮", "More" or "Open menu for <item>" button, often shown only on hover. Include the step that opens it before the action itself.
- If this is the landing page of a product that isn't set up yet (a "Get started", "Set up" or "Enable" button, and none of the product's own tabs or settings), setting it up is the first step: target that button, and say in the instruction that it turns the product on. The product's own tabs and settings only appear after that.
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
              kind: { type: "string", enum: ["navigation", "tab", "button", "row", "menu item", "field"] },
              where: { type: "string" },
            },
            required: ["instruction", "target", "kind", "where"],
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
          generationConfig: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: schema },
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

// ---------- Explain mode ----------

/** Does the request ask to understand the page rather than do something on it? */
export function looksLikeExplain(question) {
  return /^\s*(please\s+)?(explain|describe|tour|teach me|help me understand|walk me through|give me a( quick)? tour|what\s+(does|do|is|are|'s)\b|what's\b|how does\b|tell me (about|what))/i.test(
    question
  );
}

/**
 * Explain mode, step 1: which controls to explain, in page order. Nano picks ids from an enum of real
 * controls (so it can't invent one); output is only ids, so it stays fast even for a 20-stop tour.
 */
// Words that describe the request ("what do the settings on this page do") rather than name a control.
const TOUR_GENERIC = new Set(
  "explain describe tour walk through what does mean means work works each every all settings setting options option controls control things thing buttons button fields field sections section page screen here these this stuff everything".split(" ").map((w) => w.slice(0, 5))
);
const DOC_LINK = /\b(learn more|view docs?|documentation|release notes)\b|opens? (in )?(a )?new (tab|window)|\bexternal\b/i;
const aboutWholePage = (q) => /\b(this|the|current)\s+(page|screen|view)\b|\bhere\b|\bon (this|the) page\b/i.test(q);

// The ⓘ next to a column or setting ("Learn more about verified requests") is the best anchor for
// explaining that term: tour it as the term itself, not as a docs link.
const HELP_FOR = /^(?:learn more about|more info(?:rmation)? (?:about|on)|help (?:for|with|on)|info(?:rmation)? about|about|what (?:is|are))\s+(?:the\s+)?(.{3,60}?)[.?]?$/i;
function asTermAnchor(it) {
  const m = it.label.match(HELP_FOR);
  if (!m || /new (tab|window)|external/i.test(it.label)) return null;
  const term = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return { ...it, label: term, anchorLabel: it.label, context: [it.context, "help icon for this term"].filter(Boolean).join(" · ") };
}

export async function pickTour({ question, outline, max = 20 }) {
  const stems = new Set([...queryStems(question)].filter((st) => !TOUR_GENERIC.has(st)));
  const wholePage = aboutWholePage(question);
  const visible = outline.items
    .map((it, idx) => ({ it: asTermAnchor(it) || it, idx }))
    .filter(({ it }) => !it.expander && !/hidden/.test(it.state))
    // "This page" means its content, not the app's navigation around it.
    .filter(({ it }) => !wholePage || it.main || !/navigation/.test(it.context))
    // Doc links aren't controls worth a tour stop, unless the user is asking about docs.
    .filter(({ it }) => it.anchorLabel || /\bdocs?\b|documentation|learn more/i.test(question) || !DOC_LINK.test(it.label));
  if (!visible.length) return { items: [], source: "none", ms: 0, sent: "" };

  // "Explain this page" with nothing more specific: the tour is the page's main controls in reading
  // order. No model is needed for that, so the first popup appears immediately.
  if (wholePage && stems.size === 0) {
    // Stay inside the page's main region when it has one (skips sidebars, headers and skip links).
    const main = visible.filter((x) => x.it.main);
    const pool = main.length >= 3 ? main : visible;
    return { items: pool.slice(0, max).map((x) => x.it), source: "none", ms: 0, sent: "", byOrder: true };
  }
  // The question names a term that has its own help icon ("What does Unverified requests mean?"): that's
  // the answer, no model needed. Lists ("Verified and Unverified…") go to the model, which reads them better.
  if (!/\band\b|,|&/i.test(question)) {
    const q = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
    const named = visible.filter(({ it }) => it.anchorLabel && q.includes(` ${it.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `));
    if (named.length === 1) return { items: [named[0].it], source: "none", ms: 0, sent: "", byName: true };
  }
  // Keyword matches first, then page content over navigation chrome; keep the top 40 in page order.
  const cands = visible
    .map((x) => ({ ...x, s: score(x.it, stems) * 3 + (/navigation/.test(x.it.context) ? 0 : 1) }))
    .sort((a, b) => b.s - a.s || a.idx - b.idx)
    .slice(0, 40)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.it);
  if (!cands.length) return { items: [], source: "none", ms: 0, sent: "" };

  const schema = {
    type: "object",
    properties: { ids: { type: "array", items: { type: "string", enum: cands.map((c) => c.id) }, maxItems: max } },
    required: ["ids"],
  };
  const model = getGenerativeModel(
    ai,
    {
      mode: InferenceMode.PREFER_ON_DEVICE,
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
  const prompt = `You are Waypoint, giving a guided tour of a web page.
${pageHeader(outline)}

The user wants an explanation: "${question}"

Controls on this page (id | role | label | context | state):
${compactLines(cands).join("\n")}

Choose the controls whose explanation answers the request, in a sensible tour order. If they ask about one specific thing, choose just that one. If they ask about the whole page or a section, choose its meaningful content: settings, switches, tabs, table rows, key action buttons, at most ${max}. Skip site navigation and generic chrome (account menu, help, search, notifications, feedback, "learn more" links) unless asked. A "help icon for this term" stands for that term (a column, status or setting): when the user asks what a term means, choose its help icon rather than a nearby tab or button.`;
  const t0 = performance.now();
  const r = (await model.generateContent(prompt)).response;
  const ids = [...new Set(JSON.parse(r.text()).ids || [])];
  const byId = new Map(cands.map((c) => [c.id, c]));
  const order = new Map(outline.items.map((it, n) => [it.id, n]));
  const items = ids.filter((id) => byId.has(id)).sort((a, b) => order.get(a) - order.get(b)).map((id) => byId.get(id));
  return { items, source: r.inferenceSource, ms: Math.round(performance.now() - t0), sent: prompt, candidates: cands.length };
}

/**
 * Explain mode, step 2: one control's explanation, streamed. The text around the control (form hints,
 * row cells, card text) only ever goes to on-device Nano; if Nano isn't available the cloud gets just the
 * control's label, type and state.
 */
/** Nano sometimes echoes the privacy placeholders; turn them back into natural wording for the reader. */
const unplaceholder = (t) =>
  t
    .replace(/\[(?:your )?project\]'s/gi, "your project's")
    .replace(/(?:your |the )?\[(?:your )?project\]/gi, "your project")
    .replace(/\[email\]/gi, "the email address")
    .replace(/\[name\]/gi, "the account holder")
    .replace(/\[(?:number|uuid|token|api-key|app-id)\]/gi, "the ID");

export async function explainControl({ question, outline, item, detail = {}, docs = "", onText }) {
  const base = `You are Waypoint, explaining a web app's UI to a developer.
${pageHeader(outline)}

The user asked: "${question}"

${item.anchorLabel ? "Explain this term shown on the page (a column, status or setting; the user reached it through its help icon). Say what it means and what its values tell the user, not what the icon does" : "Explain this control"}:
- label: "${item.label}"
- type: ${item.anchorLabel ? "term" : item.role}${item.state ? `\n- state: ${item.state}` : ""}${item.context ? `\n- context: ${item.context}` : ""}`;
  const local = `${base}${detail.hint ? `\n- tooltip / description: ${detail.hint}` : ""}${detail.nearby ? `\n- text next to it on the page: "${detail.nearby}"` : ""}`;
  // Public docs text: fine for either model.
  const docsBlock = docs
    ? `\n\nFrom the app's official documentation (use it for what the control does and why it matters; use the page only for its current state):\n"""\n${docs}\n"""`
    : "";
  const rules = `

Explain "${item.label}" only, even if the question mentions other things: other popups cover those. Write 1 or 2 short sentences, at most ${docs ? 55 : 40} words: what it does and when or why someone would use it${docs ? ", grounded in the documentation above (a key detail, limit or trade-off it states is worth including)" : ""}. If it's a setting, status or table row, say what its current state or values mean. Start with a verb or the point itself (e.g. "Opens…", "Shows…", "Requires…"), not with the control's name. Be direct and confident; only hedge if the page gives no clue at all. Text in [brackets] was redacted for privacy: refer to it generically ("your project", "this app"). Plain text only, no markdown.`;

  const run = async (mode, prompt) => {
    const model = getGenerativeModel(
      ai,
      {
        mode,
        inCloudParams: { model: CLOUD_MODEL, generationConfig: { temperature: 0.2 } },
        onDeviceParams: {
          createOptions: {
            expectedInputs: [{ type: "text", languages: ["en"] }],
            expectedOutputs: [{ type: "text", languages: ["en"] }],
          },
        },
      },
      { timeout: 30_000 }
    );
    const t0 = performance.now();
    const res = await model.generateContentStream(prompt);
    let text = "";
    let source = null;
    for await (const chunk of res.stream) {
      source = source || chunk.inferenceSource;
      text += chunk.text();
      onText?.(unplaceholder(text));
    }
    return { text: unplaceholder(text).trim(), source: source || (mode === InferenceMode.ONLY_ON_DEVICE ? "on_device" : "in_cloud"), ms: Math.round(performance.now() - t0), sent: prompt };
  };

  try {
    return await run(InferenceMode.ONLY_ON_DEVICE, local + docsBlock + rules);
  } catch (e) {
    console.warn("[Waypoint] on-device explanation unavailable, using cloud with less context:", e?.message);
    return await run(InferenceMode.ONLY_IN_CLOUD, base + docsBlock + rules);
  }
}

// ---------- Routing: guide or explain ----------

/**
 * Gemini decides what kind of help the request needs, via a one-field schema. It only needs the
 * request and the page title (not the page), so it's a ~0.7 s on-device call; if Nano isn't available
 * the cloud gets just those two (title redacted).
 */
export async function chooseMode({ question, title = "" }) {
  const schema = {
    type: "object",
    properties: { mode: { type: "string", enum: ["guide", "explain"] } },
    required: ["mode"],
  };
  const model = getGenerativeModel(
    ai,
    {
      mode: InferenceMode.PREFER_ON_DEVICE,
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
    { timeout: 20_000 }
  );
  // Measured on Nano against 33 labelled requests: spelling out what each mode can do, a tie-breaker
  // and a few examples took routing from 32/33 to 33/33. Keep the examples distinct from real tests.
  const prompt = `You are the router for Waypoint, a browser extension that helps people use complex web apps. Waypoint can do exactly two things:

GUIDE: takes the user to a goal, one click at a time. It can move across pages: it plans a route through menus, tabs and buttons and highlights each control to click until the task is reached. Use it when the user wants to do, change, create, set up, enable, delete, open, find, go to, manage or monitor something, including "how do I…" questions and bare names of a place or feature (for example "billing alerts").

EXPLAIN: stays on the current page and explains what its controls, settings, statuses and terms mean, in popups the user steps through. It never clicks or navigates. Use it when the user wants to understand: "what is / does / are…", "what does X mean", "why is…", "what's the difference between…", "what am I looking at", "how does X work", or a tour of this page.

If a request could be either, decide whether the user wants to end up somewhere or change something (GUIDE) or only to learn (EXPLAIN). "How do I…" is GUIDE. "How does … work" is EXPLAIN.

Examples:
"Rotate my API key" → guide
"how do I change the billing account" → guide
"Logs Explorer" → guide
"what does Unverified requests mean" → explain
"show me around this page" → explain
"why is this button greyed out" → explain

Page title: ${title}
User's request: "${question}"
Choose the mode.`;
  const t0 = performance.now();
  const r = (await model.generateContent(prompt)).response;
  const mode = JSON.parse(r.text()).mode === "explain" ? "explain" : "guide";
  return { mode, source: r.inferenceSource, ms: Math.round(performance.now() - t0), sent: prompt };
}

// ---------- Documentation ----------
// Waypoint grounds explanations and re-plans in the app's own docs. URLs come from the page's own
// "Learn more" / docs links, or (when there are none) from cloud Gemini's suggestion of the official docs
// page, which only counts if it actually loads. Cloud Gemini reads the pages with the URL context tool and
// returns the relevant facts; it gets the URLs, the page title, the user's request and control labels
// (already redacted), never the page's text or values.

/** Cloud Gemini reads docs pages (URL context tool) and pulls out what matters for this request. */
export async function readDocs({ urls, question, title = "", labels = [] }) {
  const model = getGenerativeModel(
    ai,
    {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: { model: CLOUD_MODEL, tools: [{ urlContext: {} }], generationConfig: { temperature: 0 } },
    },
    { timeout: 30_000 }
  );
  const prompt = `Read these official documentation pages:
${urls.map((u) => `- ${u}`).join("\n")}

A user of this web app is on the page "${title}" and asked: "${question}"
${labels.length ? `Controls they're looking at: ${labels.map((l) => `"${l}"`).join(", ")}\n` : ""}
Using ONLY what these pages say, return JSON:
{"uiPath": "where in the app's UI this is done, as the exact menu / tab / button names in order (empty if the docs don't say)",
 "notes": [{"label": "<one of the controls above, exactly>", "note": "<what the docs say it does or means, max 40 words>"}],
 "summary": "<the 1-3 facts from the docs most useful for this request, max 70 words>"}
Leave out anything the pages don't cover. No markdown.`;
  const t0 = performance.now();
  const r = (await model.generateContent(prompt)).response;
  const meta = r.candidates?.[0]?.urlContextMetadata?.urlMetadata || [];
  const read = meta.filter((m) => /SUCCESS/i.test(m.urlRetrievalStatus || "")).map((m) => m.retrievedUrl);
  let data = {};
  try {
    data = extractJson(r.text());
  } catch {}
  return {
    uiPath: (data.uiPath || "").trim(),
    notes: Array.isArray(data.notes) ? data.notes.filter((n) => n?.label && n?.note) : [],
    summary: (data.summary || "").trim(),
    read,
    tried: urls,
    raw: r.text().slice(0, 600),
    meta: JSON.stringify(r.candidates?.[0]?.urlContextMetadata || null).slice(0, 400),
    ms: Math.round(performance.now() - t0),
    sent: prompt,
  };
}

/** No docs link on the page: ask cloud Gemini for the official docs URLs (they're verified by reading). */
export async function suggestDocs({ question, title = "", host = "", labels = [] }) {
  const schema = {
    type: "object",
    properties: { urls: { type: "array", items: { type: "string" }, maxItems: 3 }, home: { type: "string" } },
    required: ["urls", "home"],
  };
  const model = getGenerativeModel(
    ai,
    {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: { model: CLOUD_MODEL, generationConfig: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: schema } },
    },
    { timeout: 15_000 }
  );
  const prompt = `A user of the web app at ${host} (page "${title}") asked: "${question}"
${labels.length ? `Related controls on their screen: ${labels.slice(0, 12).map((l) => `"${l}"`).join(", ")}\n` : ""}Give up to 3 URLs of the app's OFFICIAL documentation pages that explain this, most specific first, and "home": the documentation home page of the product or feature involved (e.g. the docs root for that product). Only real pages on the vendor's own docs site; no blogs, forums or videos.`;
  const t0 = performance.now();
  const r = (await model.generateContent(prompt)).response;
  const out = JSON.parse(r.text());
  const urls = (out.urls || []).filter((u) => /^https:\/\//.test(u)).slice(0, 3);
  const home = /^https:\/\//.test(out.home || "") ? out.home : "";
  return { urls, home, ms: Math.round(performance.now() - t0), sent: prompt };
}

// ---------- Ask about a picked element ----------

/**
 * Answer a question about the element the user picked. On-device first, with everything: its text, state,
 * surroundings, the docs and (for charts, images and icons) a screenshot of just that element. If Nano
 * isn't available, the cloud gets only the element's kind, name and state plus the public docs: never the
 * page's text or the image.
 */
export async function answerAboutElement({ question, el, els, history = [], docs = "", image = null, images, onText }) {
  // One element or several picked together (numbered in the order they were picked, like on the page).
  const list = els?.length ? els : [el];
  const shots = images ?? (image ? [{ n: 1, ...image }] : []);
  const multi = list.length > 1;
  const cap = multi ? 360 : 1400; // several elements share Nano's context window
  const docsBlock = docs ? `From the app's official documentation:\n"""\n${docs}\n"""\n` : "";
  const historyBlock = history.length ? `Earlier in this conversation:\n${history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n")}\n` : "";
  const label = (d, i) => `${multi ? `#${i + 1} ` : ""}${d.kind} "${d.name}"${d.state ? ` (state: ${d.state})` : ""}`;
  const detailOf = (d) =>
    `${d.context ? `Where it is: ${d.context}\n` : ""}${d.fields ? `Its columns: ${d.fields.slice(0, cap)}\n` : d.text && d.text !== d.name ? `Its text: """${d.text.slice(0, cap)}"""\n` : ""}${d.hint ? `Tooltip: ${d.hint}\n` : ""}${d.nearby ? `Text next to it: """${d.nearby}"""\n` : ""}`;
  const intro = multi
    ? `You are Waypoint, helping a developer understand a web app. They selected ${list.length} elements on the page (numbered in the order they picked them) and asked about them together.\nPage: ${list[0].pageTitle}\n`
    : `You are Waypoint, helping a developer understand a web app. They selected one element on the page and asked about it.\nPage: ${list[0].pageTitle}\n`;
  // The cloud fallback only ever sees what each element is, never its text or surroundings.
  const head = `${intro}${list.map((d, i) => `${multi ? "" : "Selected: "}${label(d, i)}`).join("\n")}\n`;
  const local = `${intro}${list.map((d, i) => `${multi ? "" : "Selected: "}${label(d, i)}\n${detailOf(d)}`).join(multi ? "\n" : "")}${
    shots.length
      ? multi
        ? `Screenshots are attached for ${shots.map((x) => `#${x.n}`).join(", ")}, in that order: read them (chart axes, lines and values; what an icon depicts).\n`
        : `A screenshot of exactly this element is attached: read it (chart axes, lines and values; what an icon depicts).\n`
      : ""
  }`;
  const tail = `${docsBlock}${historyBlock}
Question: "${question}"

${
    multi
      ? `Answer in at most 5 short sentences (90 words), about these elements together: compare or connect them when the question asks, and name each one you mention (use #numbers only if names repeat). Use their states and values${shots.length ? " and what the screenshots show" : ""}.`
      : `Answer in at most 3 short sentences (60 words), specific to this element: use its state, values${shots.length ? " and what the screenshot shows" : ""}.`
  } If it's a setting, say what changing it would do. Text in [brackets] was redacted: refer to it generically ("your project"). Plain text only. If something isn't visible or documented, say so briefly instead of guessing.`;
  const image0 = shots[0] || null;
  const run = async (mode, prompt, withImage) => {
    const model = getGenerativeModel(
      ai,
      {
        mode,
        inCloudParams: { model: CLOUD_MODEL, generationConfig: { temperature: 0.2 } },
        onDeviceParams: {
          createOptions: {
            expectedInputs: [{ type: "text", languages: ["en"] }, ...(withImage ? [{ type: "image" }] : [])],
            expectedOutputs: [{ type: "text", languages: ["en"] }],
          },
        },
      },
      { timeout: 45_000 }
    );
    const parts = withImage ? [{ text: prompt }, ...shots.map((x) => ({ inlineData: { mimeType: x.mime, data: x.base64 } }))] : prompt;
    const t0 = performance.now();
    const res = await model.generateContentStream(parts);
    let text = "";
    let source = null;
    for await (const chunk of res.stream) {
      source = source || chunk.inferenceSource;
      text += chunk.text();
      onText?.(unplaceholder(text));
    }
    return {
      text: unplaceholder(text).trim(),
      source: source || (mode === InferenceMode.ONLY_ON_DEVICE ? "on_device" : "in_cloud"),
      ms: Math.round(performance.now() - t0),
      sent: prompt + (withImage ? `\n${shots.map((x) => `[+ screenshot${multi ? ` of #${x.n}` : " of the element"}, ${x.w}×${x.h}, stayed on this device]`).join("\n")}` : ""),
      usedImage: withImage,
      imagesUsed: withImage ? shots.length : 0,
    };
  };

  try {
    return await run(InferenceMode.ONLY_ON_DEVICE, local + tail, !!image0);
  } catch (e) {
    if (image0) {
      // Nano is here but can't take images (e.g. multimodal not enabled): still answer on-device from text.
      try {
        return await run(InferenceMode.ONLY_ON_DEVICE, local + tail, false);
      } catch {}
    }
    console.warn("[Waypoint] on-device answer unavailable, using cloud with less context:", e?.message);
    return await run(InferenceMode.ONLY_IN_CLOUD, head + tail, false);
  }
}
