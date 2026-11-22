// Waypoint's brain: an offscreen document that outlives any page, popup or panel. It runs every AI call
// (Gemini Nano on this device, Firebase AI Logic in the cloud), keeps the guide / tour / picker state, and
// tells the UIs what to show: the in-page command bar and overlay (via the content script) and the Trace
// side panel. Offscreen documents can only use chrome.runtime, so tabs / scripting / permissions calls go
// through the service worker (see background.js, "router").
import { docLookup, clearDocsCache } from "./docs.js";
import { pickElement, planRoute, hasKeywordHit, exactMatch, closeMatch, kindFits, alreadyHere, looksDone, specificToGoal, namesNavTarget, navTarget, looksLikeExplain, pickTour, explainControl, chooseMode, readDocs, suggestDocs, answerAboutElement } from "./pipeline.js";

// ---------- chrome.* through the service worker ----------
const rpc = (method, ...args) =>
  chrome.runtime.sendMessage({ to: "sw", rpc: method, args }).then((r) => {
    if (!r) throw new Error(`No answer for ${method}`);
    if (r.error) throw new Error(r.error);
    return r.result;
  });
const C = {
  tabs: {
    sendMessage: (tabId, msg) => rpc("tabs.sendMessage", tabId, msg),
    get: (tabId) => rpc("tabs.get", tabId),
    query: (q) => rpc("tabs.query", q),
    captureVisibleTab: (windowId, opts) => rpc("tabs.captureVisibleTab", windowId, opts),
  },
  scripting: { executeScript: (opts) => rpc("scripting.executeScript", opts) },
  permissions: { contains: (p) => rpc("permissions.contains", p), getAll: () => rpc("permissions.getAll") },
  storage: { session: { get: (k) => rpc("storage.session.get", k), remove: (k) => rpc("storage.session.remove", k) } },
};
globalThis.__wpPermContains = C.permissions.contains; // docs.js checks fetch permissions through this

// ---------- What the UIs show ----------
// One broadcast to the Trace panel (runtime message) and to the page's command bar (content script).
const settings = { cloudOnly: false };
try { Object.assign(settings, JSON.parse(localStorage.getItem("waypoint-settings") || "{}")); } catch {}
const saveSettings = () => { try { localStorage.setItem("waypoint-settings", JSON.stringify(settings)); } catch {} };
const logs = []; // receipts, newest first (the Trace panel shows them)
const view = { status: "", nano: { state: "checking" }, route: null, paused: false, replan: false, picking: false, grant: null };
function ui(type, data = {}) {
  chrome.runtime.sendMessage({ to: "ui", type, ...data }).catch(() => {});
  const tab = state.tabId ?? pick.tabId;
  if (tab != null) C.tabs.sendMessage(tab, { type: "w2:ui", ui: type, ...data }).catch(() => {});
}
function snapshot() {
  return {
    ...view,
    settings,
    pick: pick.desc ? { desc: pick.desc, suggestions: suggestionsFor(pick.desc) } : null,
    mode: state.mode,
    logs: logs.slice(0, 120),
  };
}

const state = {
  tabId: null,
  mode: "idle", // idle | single | route | explain
  goal: "",
  steps: [],
  i: 0,
  gen: 0, // bumps on every new question so stale work stops
  run: 0, // bumps on every step search so only the newest one may show a bubble
  replans: 0, // automatic cloud re-plans used for the current goal
  revealing: false, // the bubble is on a menu toggle; clicking it re-searches instead of advancing
  paused: false, // the user paused the guide (×); nothing shows until they resume
  single: null, // single-page answer: { label, bubble } so it can be found again / resumed
  recover: null, // label of a step's control that vanished (drawer closed); jump to it once it's back
  tour: null, // explain mode: { outline, items: [{ id, label, role, detail, text, started, done, source }], idx }
};
let nanoReady = false;

let stepTimer = 0;
/** Single-flight step search: a click and a page change often arrive together; only the last one runs. */
function scheduleStep(delay) {
  clearTimeout(stepTimer);
  const run = ++state.run;
  stepTimer = setTimeout(() => runStep(state.gen, 0, run), delay);
}

// ---------- Messaging with the content script ----------

// Protocol prefix: copies of content.js from older builds ignore messages they don't understand.
const PROTO = "w2:";

async function send(tabId, msg) {
  const m = { ...msg, type: PROTO + msg.type };
  try {
    return await C.tabs.sendMessage(tabId, m);
  } catch {
    // Content script missing (tab opened before install/reload): inject and retry once.
    await C.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return await C.tabs.sendMessage(tabId, m);
  }
}

// Chrome caches manifest content scripts until the extension is reloaded, so after a rebuild a full page
// load can run a stale copy. Copies injected from here mark the page; anything else gets replaced.
async function ensureFresh(tabId) {
  const r = await C.tabs.sendMessage(tabId, { type: PROTO + "ping" }).catch(() => null);
  if (r?.fresh) return;
  await C.scripting.executeScript({ target: { tabId }, files: ["flag.js", "content.js"] });
}

// Labels are redacted before any AI sees them ("Open menu for [project]"); people read "your project".
const humane = (t) => (typeof t === "string" ? t.replace(/\[([a-z][a-z ]{1,24})\]/gi, "your $1").replace(/\bSelected tab:\s*/gi, "") : t);
function status(text) {
  text = humane(text);
  view.status = text;
  chrome.runtime.sendMessage({ to: "ui", type: "status", text }).catch(() => {});
  if (state.tabId) send(state.tabId, { type: "status", text }).catch(() => {});
}

/**
 * The in-page chip. "busy" appears only if work takes over ~0.3 s, so fast steps never flash it; it
 * replaces showing a guess on screen while Waypoint is still deciding.
 */
function chip(mode, text = "") {
  if (state.tabId) send(state.tabId, { type: "pill", mode, text }).catch(() => {});
}
const busy = (text) => chip("busy", text);

function setPaused(on) {
  state.paused = on;
  view.paused = on;
  ui("paused", { on });
}
function setReplan(visible) {
  view.replan = visible;
  ui("replan", { visible });
}

// ---------- Escalation receipt ----------

const SOURCE_LABEL = { on_device: "On-device · Gemini Nano", in_cloud: "Cloud · Gemini", none: "No AI call" };

function log({ kind, title, detail, sent, ms }) {
  const badge = { on_device: "On-device", in_cloud: "Cloud", escalate: "Escalation", info: "Info" }[kind] || kind;
  const entry = { kind, badge, title, detail: detail || "", sent: sent || "", ms: ms ?? null, at: Date.now(), goal: state.goal };
  logs.unshift(entry);
  if (logs.length > 300) logs.length = 300;
  chrome.runtime.sendMessage({ to: "ui", type: "log", entry }).catch(() => {});
  // Mirror the receipt into the page console (handy when testing without the panel in view).
  if (state.tabId) {
    const line = `${badge}: ${title}${detail ? ` — ${detail}` : ""}${ms != null ? ` (${ms} ms)` : ""}`;
    send(state.tabId, { type: "debug", text: line }).catch(() => {});
    if (__WAYPOINT_DEV__ && sent) send(state.tabId, { type: "debug", text: `prompt ↓\n${sent}` }).catch(() => {});
  }
}

// ---------- Route UI ----------

function renderSteps() {
  const tour = state.mode === "explain";
  view.route =
    state.mode === "route" || tour
      ? {
          kind: tour ? "tour" : "route",
          goal: state.goal,
          i: state.i,
          steps: state.steps.map((s, idx) => ({
            text: s.instruction || s.target,
            target: s.target,
            state: idx < state.i ? "done" : idx === state.i ? "current" : "todo",
            missing: !!(tour && state.tour?.items[idx]?.missing),
          })),
        }
      : null;
  ui("route", { route: view.route });
}

// ---------- Documentation ----------
// Docs are looked up alongside the AI work (not after it): the page's own docs links, else Gemini's
// suggestion of the official pages, read by Waypoint itself (fetch) or by cloud Gemini (URL context).

const withTimeout = (p, ms) => (p ? Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]) : Promise.resolve(null));
const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`;
  } catch {
    return u;
  }
};

function lookupDocs({ question, tabId, outline, labels = [], nearLinks = [] }) {
  return (async () => {
    const pageLinks = (await send(tabId, { type: "doclinks" }).catch(() => [])) || [];
    let host = "";
    try {
      host = new URL((await C.tabs.get(tabId)).url).host;
    } catch {}
    const d = await docLookup({
      urls: [...nearLinks, ...pageLinks.map((l) => l.href)],
      question,
      labels,
      title: outline?.title || "",
      host,
      suggest: true,
    });
    log({
      kind: d.how === "cloud" ? "in_cloud" : "info",
      title:
        d.how === "fetched"
          ? `Docs: read ${d.sources.length} page${d.sources.length === 1 ? "" : "s"}`
          : d.how === "cloud"
            ? "Docs: read by cloud Gemini (URL context)"
            : "Docs: none could be read",
      detail: [
        d.sources?.length ? d.sources.map(shortUrl).join(" · ") : "",
        d.suggested?.length ? `Gemini suggested ${d.suggested.map(shortUrl).join(", ")}` : "",
        d.how === "fetched" ? "Fetched by Waypoint; relevant sections go to the AI." : "",
        d.failed?.length ? `Couldn't load: ${d.failed.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      sent: d.sent,
      ms: d.ms,
    });
    offerDocsPermission(d);
    return d;
  })().catch((e) => {
    console.warn("[Waypoint] docs lookup failed", e);
    return { how: "none" };
  });
}

/** Docs Waypoint wasn't allowed to fetch: offer a one-click grant for those docs sites (in the bar). */
function offerDocsPermission(d) {
  const hosts = d && d.how !== "fetched" ? d.needs || [] : [];
  if (!hosts.length) return;
  view.grant = { kind: "docs", origins: hosts.map((h) => `https://${h}/*`), text: `Read the official docs on ${hosts.join(", ")} for better answers?` };
  ui("grant", { grant: view.grant });
}

const docsTextFor = (d, query, max = 1800, phrase = "", opts = {}) => (!d || d.how === "none" ? "" : d.text(query, max, phrase, opts) || "");

// ---------- Core flow ----------

const MAX_AUTO_REPLANS = 2;

/**
 * Where to put the bubble for an outline item. A control hidden inside a collapsed menu is shown on the
 * menu toggle instead ("reveal"); after the user opens it, the same step is searched again.
 */
/** "Open this menu" for icon menus ("Open menu for [project]", "More actions"), else "Open "Settings"". */
function menuName(label) {
  if (!label || /\[[a-z ]+\]/i.test(label) || /^(open menu|more|actions|options|overflow|menu)\b/i.test(label)) return "Open this menu";
  return `Open "${label}"`;
}
function placement(outline, id, opensMenu = false) {
  const item = outline.items.find((it) => it.id === id);
  if (item?.expander) {
    const exp = outline.items.find((it) => it.id === item.expander);
    return { showId: item.expander, reveal: true, revealText: `${menuName(exp?.label)} to reveal "${item.label}".` };
  }
  // Nano sometimes flags an ordinary item as a menu; only a control that is actually collapsed counts.
  if (opensMenu && item?.state.includes("collapsed")) return { showId: id, reveal: true, revealText: `${menuName(item?.label)}: what you need should be inside.` };
  // Row actions that only appear on hover: the ring sits on the row and jumps to the control on hover.
  const hoverHint = item?.hover ? (/\[[a-z ]+\]/i.test(item.hover) ? "Hover over its row to reveal it." : `Hover over "${item.hover}" to reveal it.`) : "";
  return { showId: id, reveal: false, revealText: "", hoverHint };
}

async function show(where, bubble) {
  if (state.paused) return;
  state.revealing = where.reveal;
  await send(state.tabId, {
    type: "show",
    id: where.showId,
    docUrl: state.mode === "route" ? state.docUrl : undefined,
    ...bubble,
    text: humane(where.reveal ? where.revealText : bubble.text),
    why: humane(where.reveal ? bubble.text : where.hoverHint || bubble.why),
  });
}

const labelFor = (outline, id) => {
  const it = outline.items.find((x) => x.id === id);
  return it ? ` "${it.label}"` : "";
};

async function locate(question, gen, run = state.run) {
  const stale = () => gen !== state.gen || run !== state.run;
  const outline = await send(state.tabId, { type: "outline" });
  if (stale()) return null;
  const pick = await pickElement({ question, outline, forceCloud: settings.cloudOnly });
  if (stale()) return null;
  log({
    kind: pick.source === "in_cloud" ? "in_cloud" : pick.source === "on_device" ? "on_device" : "info",
    title: `Find "${question.slice(0, 60)}"`,
    detail: `${pick.elementId}${labelFor(outline, pick.elementId)}${pick.opensMenu ? " (opens a menu)" : ""}${pick.completesGoal ? " (completes the goal)" : ""} · ${pick.candidates}/${pick.total} controls shortlisted · ${SOURCE_LABEL[pick.source] || pick.source}`,
    sent: pick.sent,
    ms: pick.ms,
  });
  if (pick.elementId === "none") return { outline, pick, found: false };
  const where = placement(outline, pick.elementId, pick.opensMenu);
  const found = !!(await send(state.tabId, { type: "check", id: where.showId }))?.ok;
  return { outline, pick, found, where };
}

/**
 * No-AI sweep: a control that names the goal's subject (beyond the page's own topic) and whose status
 * shows the goal's done-state, e.g. the "Firebase AI Logic" row reading "Enforced".
 */
async function sweepDone(outline) {
  const item = outline.items.find(
    (it) => !it.hover && !it.expander && specificToGoal(state.goal, it.label, outline) && looksDone(state.goal, it)
  );
  return item ? reportDone(item, placement(outline, item.id)) : false;
}

/** The control's own status says the goal is already in place: say so and stop (no AI call). */
async function reportDone(item, where) {
  const evidence = looksDone(state.goal, item);
  if (!evidence) return false;
  log({ kind: "info", title: "Already done", detail: `"${item.label}" shows "${evidence}".` });
  state.mode = "idle";
  await show(where, { step: "Already done", text: `"${item.label}" already shows "${evidence}".`, why: "Nothing to change." });
  status("Already done: nothing to change.");
  return true;
}

async function ask(question, tabId) {
  const gen = ++state.gen;
  Object.assign(state, { tabId, mode: "idle", goal: question, steps: [], i: 0, replans: 0, revealing: false, single: null, recover: null, docsP: null, docUrl: null });
  setPaused(false);
  renderSteps();
  setReplan(false);
  await ensureFresh(tabId);
  await send(tabId, { type: "hide" });

  try {
    status("Reading this page…");
    busy("Reading this page…");
    const first = await send(tabId, { type: "outline" });
    if (await sweepDone(first)) return;
    // "Open X" with a control labelled exactly X on screen: that's the answer, no AI needed.
    const nav = navTarget(question);
    const navHit = nav && exactMatch(nav, first.items);
    if (navHit) {
      const where = placement(first, navHit.id);
      if ((await send(tabId, { type: "check", id: where.showId }))?.ok && gen === state.gen) {
        log({ kind: "info", title: `Exact match: "${navHit.label}"`, detail: "Found by label, no AI call needed." });
        state.mode = "single";
        const bubble = { step: "Here", text: where.reveal ? "" : `Use "${navHit.label}".` };
        state.single = { label: navHit.label, bubble, path: first.path };
        await show(where, bubble);
        status(where.reveal ? "It's inside a collapsed menu on this page." : "Found it on this page.");
        return;
      }
    }
    // Docs lookup runs while Nano reads the page; the planner uses it if a route is needed.
    state.docsP = lookupDocs({ question, tabId, outline: first });
    const res = await locate(question, gen);
    if (!res) return;
    const { pick } = res;
    const picked = res.found && res.outline.items.find((it) => it.id === pick.elementId);
    if (picked && !res.where.reveal && (await reportDone(picked, res.where))) return;
    const label = picked?.label || "this control";
    // Nano's "this completes it" only counts if the control names something specific to the goal.
    // ...and "open / go to X" is completed by a control named X, whatever Nano thought.
    const completes =
      !!picked &&
      ((pick.completesGoal && specificToGoal(question, picked.label, res.outline)) || namesNavTarget(question, picked.label));
    if (pick.completesGoal && !completes) {
      log({ kind: "info", title: "Not convinced", detail: `"${label}" doesn't name anything specific to the goal, so the cloud plans instead.` });
    }
    if (res.found && (completes || res.where.reveal)) {
      // The goal is on this page (possibly inside a collapsed menu): no route needed.
      state.mode = "single";
      const bubble = { step: "Here", text: res.where.reveal ? "" : `Use "${label}".`, src: SOURCE_LABEL[pick.source] };
      state.single = { label, bubble, path: res.outline.path };
      await show(res.where, bubble);
      status(res.where.reveal ? "It's inside a collapsed menu on this page." : "Found it on this page.");
      return;
    }
    // Nothing is highlighted until the route is known: showing Nano's guess first and then the plan's
    // first step looked like Waypoint changing its mind. The chip says it's working instead.
    await escalate(question, res.outline, gen, { pick });
  } catch (e) {
    console.error(e);
    chip(null);
    status(`Error: ${e?.message || e}`);
  }
}

async function escalate(goal, outline, gen, { pick = null, failed = null, unfinished = false, vanished = false } = {}) {
  const done = state.steps.slice(0, state.i).map((s) => s.target);
  log({
    kind: "escalate",
    title: failed || unfinished ? "Re-planning with cloud Gemini" : "Escalating to cloud Gemini",
    detail: unfinished
      ? `The route ended at "${state.steps[state.steps.length - 1]?.target}" short of the goal, so the rest is planned from here.`
      : failed && vanished
      ? `"${failed}" was on screen a moment ago but is hidden now (a menu or drawer closed), so the route is re-planned to reopen it.`
      : failed
      ? `The planned step "${failed}" isn't on this page, so the route is re-planned from what is.`
      : pick.elementId === "none" || pick.completesGoal
        ? "Gemini Nano found no control on this page that clearly does this, so a route is needed."
        : "Gemini Nano found the first step; the goal is on another page, so the cloud plans the route.",
  });
  status(failed ? "Re-planning from this page with cloud Gemini…" : "Planning the route with cloud Gemini…");
  busy(failed || unfinished ? "Re-planning from here…" : "Planning your route…");
  // Initial plans wait briefly for the docs (usually ready by now); re-plans wait longer, since a re-plan
  // means the model's memory of this app was wrong.
  const docs = await withTimeout(state.docsP, failed || unfinished ? 6000 : 2500);
  if (gen !== state.gen) return;
  const docsText = docsTextFor(docs, goal, 2000, "", { ui: true });
  if (docsText) state.docUrl = docs.urlFor(goal);
  const plan = await planRoute({ goal, outline, done, failed, unfinished, vanished, docs: docsText });
  state.recover = vanished ? failed : null;
  if (gen !== state.gen) return;
  log({
    kind: "in_cloud",
    title: `Route ${failed || unfinished ? "re-planned" : "planned"} (${plan.steps.length} steps)`,
    detail: `${plan.model}${docsText ? " · grounded in the docs" : ""} · ${plan.steps.map((s) => `${s.target}${s.kind ? ` (${s.kind})` : ""}`).join(" → ")}`,
    sent: plan.sent,
    ms: plan.ms,
  });
  // A re-plan replaces the remaining steps; completed ones stay visible.
  const kept = failed || unfinished ? state.steps.slice(0, state.i) : [];
  Object.assign(state, { mode: "route", steps: [...kept, ...plan.steps], i: kept.length });
  renderSteps();
  scheduleStep(0);
}

async function runStep(gen, attempt, run) {
  const stale = () => gen !== state.gen || run !== state.run || state.mode !== "route" || state.paused;
  if (stale()) return;
  if (state.i >= state.steps.length) {
    // A short plan can end before the goal: if the last step didn't name anything specific to the goal
    // (e.g. it was just a tab), plan the rest from here instead of declaring the route complete.
    const last = state.steps[state.steps.length - 1]?.target || "";
    const outline = await send(state.tabId, { type: "outline" });
    if (stale()) return;
    if (await sweepDone(outline)) return;
    if (!specificToGoal(state.goal, last, outline) && state.replans < MAX_AUTO_REPLANS) {
      state.replans += 1;
      await escalate(state.goal, outline, gen, { unfinished: true });
      return;
    }
    status("Route complete. Review the final screen before confirming anything.");
    await send(state.tabId, { type: "hide" });
    chip("done", "You're there");
    state.mode = "idle";
    renderSteps();
    return;
  }
  renderSteps();
  // Routes can grow when Waypoint re-plans, so the popup never shows "Step x of y": just "Next step".
  // (The side panel's step list shows the whole route.)
  const of = () => "Next step";
  try {
    await ensureFresh(state.tabId);
    const outline = await send(state.tabId, { type: "outline" });
    if (stale()) return;

    if (await sweepDone(outline)) return;

    // Steps for where the user already is (the current page's nav link, the selected tab) are done.
    while (state.i < state.steps.length - 1 && alreadyHere(state.steps[state.i].target, outline.items)) {
      log({ kind: "info", title: `Already on "${state.steps[state.i].target}"`, detail: "Skipped: nothing to click." });
      state.i += 1;
    }

    // Recovering a control that vanished: as soon as it's back on screen (e.g. the drawer reopened),
    // go straight to it, even if the re-plan put a detour before it.
    if (state.recover) {
      const j = state.steps.findIndex((st, k) => k >= state.i && exactMatch(state.recover, [{ label: st.target, state: "" }]));
      const hit = j >= 0 && exactMatch(state.recover, outline.items);
      if (hit) {
        const where = placement(outline, hit.id);
        if ((await send(state.tabId, { type: "check", id: where.showId }))?.ok && !stale()) {
          if (j > state.i) log({ kind: "info", title: `Back on track: "${hit.label}"`, detail: "It's on screen again, so the detour is skipped." });
          state.recover = null;
          state.i = j;
          renderSteps();
          state.steps[j].shown = hit.label;
          state.steps[j].shownPath = outline.path;
          await show(where, { step: of(), text: state.steps[j].instruction });
          status(state.steps[j].instruction);
          return;
        }
      }
    }

    // Rung 1, no AI: an exact label match for this step or up to two steps ahead. Take the NEAREST step
    // that is on screen: a stale planner step that isn't here (or a menu that's already open) is skipped
    // for free, but a step that is here is never jumped over.
    // Skipping is for stale navigation only: a settings/field step is never jumped over (that would
    // point at "Save" before anything was set).
    const skippable = (st) => !st.kind || /^(navigation|tab|menu item)$/.test(st.kind);
    for (let j = state.i; j <= Math.min(state.i + 2, state.steps.length - 1); j++) {
      if (j > state.i && !skippable(state.steps[j - 1])) break;
      const hit = exactMatch(state.steps[j].target, outline.items, state.steps[j].kind) || closeMatch(state.steps[j].target, outline.items, state.steps[j].kind);
      if (!hit) continue;
      if (hit.state.includes("expanded") && j < state.steps.length - 1) continue; // already open
      const where = placement(outline, hit.id);
      if (!(await send(state.tabId, { type: "check", id: where.showId }))?.ok) continue;
      if (stale()) return;
      if (j > state.i) log({ kind: "info", title: `Skipped to step ${j + 1}`, detail: `"${state.steps[j].target}" is already on screen.` });
      log({ kind: "info", title: `Exact match: "${hit.label}"${where.reveal ? " (inside a collapsed menu)" : ""}`, detail: "Found by label, no AI call needed." });
      state.i = j;
      renderSteps();
      if (await reportDone(hit, where)) return;
      state.steps[j].shown = hit.label;
      state.steps[j].shownPath = outline.path;
      await show(where, { step: of(), text: state.steps[j].instruction });
      status(where.reveal ? where.revealText : state.steps[j].instruction);
      return;
    }

    // Backtrack, no AI: a menu or drawer an earlier step opened has closed again (the user clicked away),
    // so the current step's control is gone. Point back at that toggle instead of re-planning.
    // Only while the user is still on the page where those steps were done: after a step navigates
    // (e.g. "Cloud Run" opened the Cloud Run page) the header's menu being collapsed again is normal,
    // not a reason to go back.
    for (let j = state.i - 1; j >= Math.max(0, state.i - 3); j--) {
      const prev = state.steps[j];
      const samePage = state.steps.slice(j, state.i).every((s) => s.donePath === outline.path);
      if (!samePage) break;
      const hit = exactMatch(prev.shown || prev.target, outline.items);
      if (!hit || !hit.state.includes("collapsed")) continue;
      const where = placement(outline, hit.id);
      if (!(await send(state.tabId, { type: "check", id: where.showId }))?.ok || stale()) continue;
      log({ kind: "info", title: `Back to step ${j + 1}`, detail: `"${hit.label}" closed again; reopen it to continue.` });
      state.i = j;
      renderSteps();
      await show(where, { step: of(), text: `Reopen "${hit.label}" to continue.`, why: state.steps[state.i + 1]?.instruction || "" });
      status(`Reopen "${hit.label}" to continue.`);
      return;
    }

    // The current step's control was showing on this very page a moment ago and is gone now (a drawer
    // or menu closed). Nano would only guess at a lookalike; plan the way back to it instead.
    const cur = state.steps[state.i];
    if (cur.shown && cur.shownPath === outline.path && state.replans < MAX_AUTO_REPLANS) {
      state.replans += 1;
      await escalate(state.goal, outline, gen, { failed: cur.target, vanished: true });
      return;
    }

    // Rung 2, Gemini Nano: the current step, then the next one (the user may have skipped ahead).
    // Only when the target's words are actually on screen; otherwise there is nothing for Nano to find
    // and guessing (e.g. "some menu") does more harm than re-planning.
    let tried = false;
    let rejected = false; // Nano found something, but it was the wrong kind / already open / covered
    for (const j of [state.i, state.i + 1]) {
      const step = state.steps[j];
      if (!step || !hasKeywordHit(step.target, outline.items)) continue;
      tried = true;
      status(`Step ${j + 1}: looking for "${step.target}"…`);
      busy(`Looking for "${step.target}"…`);
      const res = await locate(`"${step.target}"${step.kind ? `, a ${step.kind}` : ""} (${step.instruction}; ${step.where})`, gen, run);
      if (!res || stale()) return;
      const pickedItem = res.outline.items.find((it) => it.id === res.pick.elementId);
      if (res.found && /expanded|covered/.test(pickedItem?.state || "")) {
        // A menu that's already open, or a control under something: not the next thing to click.
        log({ kind: "info", title: `Not "${pickedItem.label}"`, detail: /expanded/.test(pickedItem.state) ? "That menu is already open." : "Something is on top of it right now." });
        rejected = true;
        continue;
      }
      if (res.found && !kindFits(step.kind, pickedItem) && !res.where.reveal) {
        log({ kind: "info", title: `Not "${pickedItem.label}"`, detail: `The plan wants a ${step.kind}; that's a different kind of control with the same name.` });
        rejected = true;
        continue;
      }
      if (res.found && /current|selected/.test(pickedItem?.state || "")) {
        // Nano pointed at where the user already is: that step is done.
        log({ kind: "info", title: `Already on "${pickedItem.label}"`, detail: "Skipped: nothing to click." });
        state.i = j + 1;
        scheduleStep(0);
        return;
      }
      if (res.found) {
        state.i = j;
        renderSteps();
        step.shown = pickedItem?.label;
        step.shownPath = res.outline.path;
        await show(res.where, { step: of(), text: step.instruction, src: SOURCE_LABEL[res.pick.source] });
        status(res.where.reveal ? res.where.revealText : step.instruction);
        return;
      }
    }
    if (stale()) return;
    // Nano looked and only found wrong candidates: asking it again won't help, the plan is wrong for
    // this page. Re-plan now instead of after four slow tries.
    if (rejected && state.replans < MAX_AUTO_REPLANS) {
      state.replans += 1;
      await escalate(state.goal, outline, gen, { failed: state.steps[state.i].target });
      return;
    }
    // Give a loading page ~2 s; give Nano up to 4 tries when the target's words are on screen.
    if (attempt < 2 || (tried && attempt < 4)) {
      status("Waiting for the page to load…");
      busy("Waiting for the page…");
      stepTimer = setTimeout(() => runStep(gen, attempt + 1, run), 900);
    } else if (state.replans < MAX_AUTO_REPLANS) {
      // Rung 3, cloud: re-plan from what's actually on screen. If this step's control was showing on this
      // very page a moment ago, it didn't move: a menu or drawer closed, and the plan should reopen it.
      state.replans += 1;
      await escalate(state.goal, outline, gen, { failed: cur.target });
    } else {
      chip(null);
      status(`Couldn't find "${state.steps[state.i].target}" here. Navigate there, or re-plan from this page.`);
      setReplan(true);
    }
  } catch (e) {
    console.error(e);
    chip(null);
    status(`Error: ${e?.message || e}`);
  }
}

// ---------- Explain mode: a streamed tour ----------
// Nano picks the controls to explain (ids only, so it's quick), the first popup appears right away, and
// explanations are written one at a time in the background, starting from the one on screen. The popup
// streams its text in as Nano writes it; if the user clicks Next before the next one is ready, the ring
// moves there at once and the bubble shows a loading state until the text arrives.

async function explain(question, tabId) {
  const gen = ++state.gen;
  clearTimeout(stepTimer);
  Object.assign(state, { tabId, mode: "explain", goal: question, steps: [], i: 0, replans: 0, revealing: false, single: null, recover: null, tour: null });
  setPaused(false);
  renderSteps();
  setReplan(false);
  await ensureFresh(tabId);
  await send(tabId, { type: "hide" });
  try {
    status("Choosing what to explain…");
    busy("Choosing what to explain…");
    const outline = await send(tabId, { type: "outline" });
    const pick = await pickTour({ question, outline });
    if (gen !== state.gen) return;
    log({
      kind: pick.source === "in_cloud" ? "in_cloud" : pick.source === "on_device" ? "on_device" : "info",
      title: `Tour: ${pick.items.length} control${pick.items.length === 1 ? "" : "s"} to explain`,
      detail: `${pick.items.map((it) => it.label).join(" · ")} · ${pick.byOrder ? "the page's main controls in reading order, no AI call" : SOURCE_LABEL[pick.source] || pick.source}`,
      sent: pick.sent,
      ms: pick.ms,
    });
    if (!pick.items.length) {
      chip(null);
      state.mode = "idle";
      status("I couldn't find anything on this page that matches. Try naming the setting or section.");
      return;
    }
    const details = (await send(tabId, { type: "describe", ids: pick.items.map((it) => it.id) })) || [];
    state.tour = {
      outline,
      idx: 0,
      items: pick.items.map((it, k) => ({ ...it, detail: details[k] || {}, text: "", started: false, done: false, source: null })),
    };
    state.steps = state.tour.items.map((it) => ({ target: it.label, instruction: it.label }));
    const t = state.tour;
    t.docsP = lookupDocs({
      question,
      tabId,
      outline,
      labels: t.items.map((it) => it.label),
      nearLinks: t.items.map((it) => it.detail?.docHref).filter(Boolean),
    });
    t.docsP.then((d) => (t.docs = d));
    await showTourItem(0, 1);
    runExplainer(gen);
  } catch (e) {
    console.error(e);
    chip(null);
    status(`Error: ${e?.message || e}`);
  }
}

/** Writes explanations one at a time: the one on screen first, then the ones after it, then the rest. */
async function runExplainer(gen) {
  const t = state.tour;
  // The first explanation waits (up to 6 s) for the docs, so every stop can be grounded in them.
  await withTimeout(t.docsP, 6000);
  if (gen !== state.gen) return;
  if (t.docs === undefined) t.docs = null;
  while (gen === state.gen && state.tour === t) {
    let k = t.items.findIndex((it, n) => n >= t.idx && !it.started && !it.missing);
    if (k < 0) k = t.items.findIndex((it) => !it.started && !it.missing);
    if (k < 0) return;
    const it = t.items[k];
    it.started = true;
    const docs = t.docs?.how === "cloud" ? docsTextFor(t.docs, it.label) : docsTextFor(t.docs, `${it.label} ${state.goal}`, 1100, it.label);
    it.docUrl = docs ? t.docs.urlFor(it.label) : null;
    let last = 0;
    const push = (final) => {
      if (gen !== state.gen || t.idx !== k || state.paused) return;
      send(state.tabId, {
        type: "update",
        text: it.text,
        loading: !it.text,
        streaming: !final,
        src: final ? SOURCE_LABEL[it.source] : "",
        docUrl: final ? it.docUrl : null,
      }).catch(() => {});
    };
    try {
      const r = await explainControl({
        question: state.goal,
        outline: t.outline,
        item: it,
        detail: it.detail,
        docs,
        onText: (txt) => {
          it.text = txt;
          if (performance.now() - last > 60) {
            last = performance.now();
            push(false);
          }
        },
      });
      if (gen !== state.gen) return;
      Object.assign(it, { text: r.text || "No explanation came back for this one.", done: true, source: r.source });
      log({ kind: r.source === "in_cloud" ? "in_cloud" : "on_device", title: `Explain "${it.label}"`, detail: SOURCE_LABEL[r.source] || r.source, sent: r.sent, ms: r.ms });
    } catch (e) {
      if (gen !== state.gen) return;
      Object.assign(it, { text: "Couldn't write an explanation for this one.", done: true, source: "none" });
      console.warn("[Waypoint] explain failed", e);
    }
    push(true);
  }
}

/** Show tour stop k (dir: +1 / -1 is the way to skip if that control is gone). */
async function showTourItem(k, dir = 1) {
  const t = state.tour;
  if (!t || state.paused) return;
  while (t.items[k]?.missing) k += dir;
  if (k < 0 || k >= t.items.length) return dir > 0 ? finishTour() : showTourItem(t.idx, 1);
  t.idx = state.i = k;
  renderSteps();
  const it = t.items[k];
  const n = t.items.length;
  const hasNext = t.items.slice(k + 1).some((x) => !x.missing);
  const hasBack = t.items.slice(0, k).some((x) => !x.missing);
  const r = await send(state.tabId, {
    type: "show",
    id: it.id,
    mode: "explain",
    step: n > 1 ? `${k + 1} of ${n}` : "Explainer",
    title: it.label.replace(/^(?:selected|current|active)\s+(?:tab|item|page)\s*[:,-]\s*/i, ""),
    text: it.text,
    loading: !it.text,
    loadingText:
      t.docs === undefined && t.docsP
        ? "Reading the official docs…"
        : nanoReady
          ? "Gemini Nano is writing this on your device…"
          : "Writing an explanation…",
    docUrl: it.done ? it.docUrl : null,
    streaming: !it.done && !!it.text,
    src: it.done ? SOURCE_LABEL[it.source] || "" : "",
    back: hasBack,
    next: hasNext,
  });
  if (!r?.ok) {
    // The page re-rendered: find the tour's controls again by label.
    if (await remapTour()) return showTourItem(k, dir);
    it.missing = true;
    return showTourItem(k + dir, dir);
  }
  status(`Explaining ${k + 1} of ${n}: ${it.label}`);
}

/** After a re-render, ids change: match each tour stop to the new outline by label and role. */
async function remapTour() {
  const t = state.tour;
  if (!t) return false;
  const outline = await send(state.tabId, { type: "outline" });
  const used = new Set();
  let changed = false;
  for (const it of t.items) {
    const hit = outline.items.find((x) => !used.has(x.id) && x.label === it.label && x.role === it.role);
    if (hit) {
      used.add(hit.id);
      if (hit.id !== it.id) changed = true;
      it.id = hit.id;
      it.missing = false;
    } else if (!it.missing) {
      it.missing = true;
      changed = true;
    }
  }
  t.outline = outline;
  return changed && !t.items[t.idx]?.missing;
}

function finishTour() {
  state.gen++;
  state.mode = "idle";
  state.tour = null;
  send(state.tabId, { type: "hide" }).catch(() => {});
  chip("done", "Tour complete");
  renderSteps();
  status("Tour complete.");
}

// ---------- Element picker ----------
// Pick button (or Alt+Shift+P, or right-click "Ask Waypoint about this") → the page highlights what's under
// the cursor → click pins it → the card here shows it with suggested questions → answers stream onto it.
// Charts, images and icon-only controls also get a screenshot of just that element, read by Nano on-device.

const pick = { desc: null, tabId: null, thread: [] };

const SUGGEST = {
  Chart: ["What does this chart show?", "Anything unusual here?", "How do I read this?"],
  Image: ["What is this?", "Why is it here?"],
  Icon: ["What does this icon mean?", "What happens if I click it?"],
  "Icon button": ["What does this button do?", "Is it safe to click?"],
  Switch: ["What does this setting do?", "Is it safe to change?", "What should it be set to?"],
  Checkbox: ["What does this option do?", "Is it safe to change?"],
  Setting: ["What does this setting do?", "What should I set it to?", "Is it safe to change?"],
  Field: ["What goes in here?", "What's a good value?"],
  Dropdown: ["What do these options mean?", "Which should I pick?"],
  Row: ["What do these values mean?", "Is anything wrong here?", "How do I change this?"],
  Table: ["Summarize this table", "Anything I should look at?"],
  Button: ["What does this do?", "Is it reversible?"],
  Link: ["Where does this go?", "What's it for?"],
  Tab: ["What's on this tab?"],
  Menu: ["What's in this menu?"],
  Section: ["Summarize this section", "What should I pay attention to?"],
  Card: ["Summarize this", "What should I do here?"],
  Heading: ["What is this section about?"],
};
function suggestionsFor(d) {
  const base = SUGGEST[d.kind] || ["What is this?", "What does it do?"];
  return /disabled/.test(d.state) ? ["Why is this disabled?", ...base].slice(0, 3) : base;
}

// Screenshots need the "all URLs" grant (or activeTab, which only right-click / the shortcut give).
const SCREENSHOT_ORIGINS = ["<all_urls>"];
const canScreenshot = () => C.permissions.contains({ origins: SCREENSHOT_ORIGINS }).catch(() => false);
let pendingRetry = null;

async function renderPickCard() {
  const d = pick.desc;
  ui("pick", { pick: d ? { desc: d, suggestions: suggestionsFor(d) } : null });
  if (d?.vision && !pick.activeTab && !(await canScreenshot()) && pick.desc === d) {
    view.grant = { kind: "screenshot", origins: SCREENSHOT_ORIGINS, text: "To read it, Nano needs a screenshot of just this element. It stays on your device." };
    ui("grant", { grant: view.grant });
  }
}
function setPicking(on) {
  view.picking = on;
  ui("picking", { on });
}
function setPicked(desc, tabId) {
  Object.assign(pick, { desc, tabId, thread: [] });
  state.tabId = tabId;
  setPicking(false);
  renderPickCard();
  if (desc) {
    log({ kind: "info", title: `Picked: ${desc.kind} "${desc.name}"`, detail: desc.vision ? `Looks like ${desc.vision === "icon" ? "an icon" : `a ${desc.vision}`}: Nano will also look at a screenshot of it.` : "Its text, state and surroundings are the context." });
    status("Ask anything about it.");
  }
}
function clearPicked(tellPage = true) {
  if (tellPage && pick.tabId != null) send(pick.tabId, { type: "pick-clear" }).catch(() => {});
  Object.assign(pick, { desc: null, tabId: null, thread: [] });
  renderPickCard();
}

async function startPick(tabId) {
  if (tabId == null) return;
  // Whatever was running stops; picking takes over the page.
  state.gen++;
  clearTimeout(stepTimer);
  Object.assign(state, { tabId, mode: "idle", tour: null, single: null });
  setPaused(false);
  renderSteps();
  await ensureFresh(tabId);
  await send(tabId, { type: "pick-start" });
  pick.tabId = tabId;
  setPicking(true);
  status("Hover over the page and click what you want to ask about. ↑ ↓ widen or narrow, Esc cancels.");
}
/** The user allowed screenshots (grant window): re-ask what was asked without one. */
function screenshotsAllowed() {
  if (pendingRetry && pick.desc) {
    const q = pendingRetry;
    pendingRetry = null;
    answerPick(q);
  }
}

/** Screenshot of just the picked element (Waypoint's overlay hidden), downscaled; stays on this device. */
async function captureCrop(tabId) {
  const r = await send(tabId, { type: "pick-rect" });
  if (!r) throw new Error("The element is gone");
  try {
    const tab = await C.tabs.get(tabId);
    const dataUrl = await C.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const k = bmp.width / r.vw; // device pixels per CSS pixel
    const pad = 8;
    const x = Math.max(0, (r.left - pad) * k), y = Math.max(0, (r.top - pad) * k);
    const w = Math.min(bmp.width - x, (r.width + pad * 2) * k), h = Math.min(bmp.height - y, (r.height + pad * 2) * k);
    if (w < 8 || h < 8) throw new Error("The element isn't on screen");
    const scale = Math.min(1, 768 / Math.max(w, h));
    const c = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
    c.getContext("2d").drawImage(bmp, x, y, w, h, 0, 0, c.width, c.height);
    const blob = await c.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(bin), mime: "image/png", w: c.width, h: c.height };
  } finally {
    await send(tabId, { type: "pick-restore" }).catch(() => {});
  }
}

/** A question about the picked element: route it (explain here, or guide from it), then answer. */
async function handlePick(question) {
  const d = pick.desc;
  const tabId = pick.tabId;
  let mode = "explain";
  try {
    mode = (await chooseMode({ question, title: d.pageTitle })).mode;
  } catch {}
  if (mode === "guide") {
    // "Turn this on", "where else is this set": a guide that starts from the picked element.
    return ask(`${question} (they mean the ${d.kind.toLowerCase()} "${d.name}" on this page)`, tabId);
  }
  return answerPick(question);
}

async function answerPick(question) {
  const gen = ++state.gen;
  clearTimeout(stepTimer);
  Object.assign(state, { mode: "pick", tour: null, single: null });
  setPaused(false);
  renderSteps();
  const d = pick.desc;
  const tabId = pick.tabId;
  state.tabId = tabId;
  const loadingText = d.vision ? "Gemini Nano is looking at it, on your device…" : nanoReady ? "Gemini Nano is thinking, on your device…" : "Thinking…";
  const shown = await send(tabId, { type: "pick-show", step: d.kind, title: d.name, text: "", loading: true, loadingText });
  if (!shown?.ok) {
    clearPicked(false);
    status("That element isn't on the page any more. Pick it again.");
    return;
  }
  status(`Answering about "${d.name}"…`);
  try {
    const docsP = lookupDocs({ question: `${question} ${d.name}`, tabId, outline: { title: d.pageTitle }, labels: [d.name], nearLinks: d.docHref ? [d.docHref] : [] });
    let image = null;
    if (d.vision) {
      try {
        image = await captureCrop(tabId);
      } catch (e) {
        const perm = /permission/i.test(String(e?.message));
        log({ kind: "info", title: "Couldn't take a screenshot of it", detail: perm ? "Screenshots aren't allowed yet; answering from its text. Allow them in the card to let Nano look." : `${e?.message || e}. Answering from its text instead.` });
        if (perm) {
          view.grant = { kind: "screenshot", origins: SCREENSHOT_ORIGINS, text: "To read it, Nano needs a screenshot of just this element. It stays on your device." };
          ui("grant", { grant: view.grant });
          pendingRetry = question;
        }
      }
    }
    const docs = await withTimeout(docsP, 4000);
    if (gen !== state.gen) return;
    const docsText = docsTextFor(docs, `${d.name} ${question}`, 1000, d.name);
    const docUrl = docsText ? docs.urlFor(d.name) : null;
    let last = 0;
    const r = await answerAboutElement({
      question,
      el: d,
      history: pick.thread,
      docs: docsText,
      image,
      onText: (t) => {
        if (gen !== state.gen || performance.now() - last < 60) return;
        last = performance.now();
        send(tabId, { type: "update", text: t, loading: false, streaming: true }).catch(() => {});
      },
    });
    if (gen !== state.gen) return;
    await send(tabId, { type: "update", text: r.text, loading: false, streaming: false, src: SOURCE_LABEL[r.source], docUrl });
    pick.thread = [...pick.thread, { q: question, a: r.text }].slice(-3);
    log({
      kind: r.source === "in_cloud" ? "in_cloud" : "on_device",
      title: `About "${d.name}"${r.usedImage ? " (looked at it)" : ""}`,
      detail: `${SOURCE_LABEL[r.source] || r.source}${docsText ? " · grounded in the docs" : ""}${r.usedImage ? " · screenshot stayed on this device" : ""}`,
      sent: r.sent,
      ms: r.ms,
    });
    status("Ask a follow-up, or pick something else.");
    ui("query", { text: "" });
  } catch (e) {
    console.error(e);
    send(tabId, { type: "update", text: `Couldn't answer: ${e?.message || e}`, loading: false, streaming: false }).catch(() => {});
    status(`Error: ${e?.message || e}`);
  }
}

// Right-click "Ask Waypoint about this" opened the panel before it could listen: pick up what was chosen.
(async () => {
  try {
    const { pendingPick } = await C.storage.session.get("pendingPick");
    if (pendingPick && Date.now() - pendingPick.at < 15000) setPicked(pendingPick.desc, pendingPick.tabId);
    await C.storage.session.remove("pendingPick");
  } catch {}
})();

// ---------- Pause / resume ----------
// × on the bubble pauses instead of ending: the route and progress are kept, and Resume (in the page
// chip or here) picks up from whatever page the user is on now.

function pause() {
  if (state.mode === "idle") return;
  clearTimeout(stepTimer);
  state.run++;
  setPaused(true);
  status("Guide paused. Resume when you're ready.");
}

async function resume() {
  if (!state.paused) return;
  setPaused(false);
  chip(null);
  status("Resuming…");
  if (state.mode === "route") {
    busy("Picking up where you left off…");
    scheduleStep(0);
  } else if (state.mode === "single") relocateSingle();
  else if (state.mode === "explain") showTourItem(state.tour?.idx ?? 0, 1);
}

function endGuide() {
  state.gen++;
  clearTimeout(stepTimer);
  Object.assign(state, { mode: "idle", single: null, tour: null });
  setPaused(false);
  send(state.tabId, { type: "hide" }).catch(() => {});
  chip(null);
  renderSteps();
  status("Guide ended.");
}

/** Single-page answer: find the same control again by its label (no AI), or ask again if it's gone. */
async function relocateSingle() {
  const gen = state.gen;
  const outline = await send(state.tabId, { type: "outline" });
  if (gen !== state.gen || state.paused || !state.single) return;
  const hit = exactMatch(state.single.label, outline.items);
  if (hit) {
    const where = placement(outline, hit.id);
    if ((await send(state.tabId, { type: "check", id: where.showId }))?.ok) {
      status("Found it on this page.");
      return show(where, state.single.bubble);
    }
  }
  // It was right here a moment ago: plan how to get it back on screen (usually reopen a menu or drawer),
  // rather than asking from scratch, which can pick a different, longer route.
  const label = state.single.label;
  Object.assign(state, {
    mode: "route",
    steps: [{ instruction: `Open "${label}".`, target: label, where: "", shown: label, shownPath: state.single.path }],
    i: 0,
  });
  renderSteps();
  busy("Finding it again…");
  await escalate(state.goal, outline, gen, { failed: label, vanished: state.single.path === outline.path });
}


// ---------- Events ----------

// ---------- Routing ----------
// Gemini decides whether the request is "guide" (do / go somewhere) or "explain" (understand the page),
// through a one-field schema. The wording check is only a fallback if no model is reachable.

let routeToken = 0;
let lastAsk = { key: "", at: 0 };
async function handle(question, tabId) {
  // A double-clicked Ask (same question, same tab, within 1.5 s) is one request.
  const key = `${tabId}|${question.trim()}`;
  if (key === lastAsk.key && Date.now() - lastAsk.at < 1500) return;
  lastAsk = { key, at: Date.now() };
  const token = ++routeToken;
  // Stop whatever was running; the new request takes over the page.
  state.gen++;
  clearTimeout(stepTimer);
  Object.assign(state, { tabId, mode: "idle", tour: null, single: null });
  setPaused(false);
  renderSteps();
  status("Thinking…");
  try {
    await ensureFresh(tabId);
    await send(tabId, { type: "hide" });
    busy("Thinking…");
    const title = (await send(tabId, { type: "outline" }))?.title || "";
    let mode;
    try {
      const r = await chooseMode({ question, title });
      mode = r.mode;
      log({
        kind: r.source === "in_cloud" ? "in_cloud" : "on_device",
        title: mode === "explain" ? "Decided: explain the page" : "Decided: guide you there",
        detail: `${SOURCE_LABEL[r.source] || r.source} chose "${mode}" for this request.`,
        sent: r.sent,
        ms: r.ms,
      });
    } catch (e) {
      mode = looksLikeExplain(question) ? "explain" : "guide";
      log({ kind: "info", title: `Decided: ${mode} (fallback)`, detail: `No model reachable (${e?.message || e}); chose from the wording.` });
    }
    if (token !== routeToken) return;
    if (mode === "explain") explain(question, tabId);
    else ask(question, tabId);
  } catch (e) {
    if (token !== routeToken) return;
    chip(null);
    status(`Error: ${e?.message || e}`);
  }
}

async function replanNow() {
  const gen = state.gen;
  setReplan(false);
  const outline = await send(state.tabId, { type: "outline" });
  escalate(state.goal, outline, gen, { failed: state.steps[state.i]?.target || "(unknown)" }).catch((e) => status(`Error: ${e?.message}`));
}

/** A question from the command bar: about the picked element, or a new request. */
function askFromBar(q, tabId) {
  if (pick.desc && pick.tabId === tabId) handlePick(q);
  else handle(q, tabId);
}

let lastCommand = { key: "", at: 0 };
// Requests that need an answer (snapshot, nano status).
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "brain:snapshot") {
    reply(snapshot());
    return false;
  }
  if (msg?.type === "brain:nano") {
    reply(view.nano);
    return false;
  }
  if (msg?.type === "brain:nano-recheck") {
    startNano().then(() => reply(view.nano));
    return true;
  }
  return false;
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || (msg.to && msg.to !== "brain")) return; // router calls and UI broadcasts aren't for the brain
  const fromTab = sender.tab?.id ?? msg.tabId;
  // From the command bar (content script) or the Trace panel.
  if (msg.type === "bar:ask" && msg.q && fromTab != null) return void askFromBar(msg.q.trim(), fromTab);
  if (msg.type === "bar:pick" && fromTab != null) return void startPick(fromTab);
  if (msg.type === "bar:pick-stop") return void (pick.tabId != null && send(pick.tabId, { type: "pick-stop" }).then(() => setPicking(false)));
  if (msg.type === "bar:pick-clear") return void clearPicked(true);
  if (msg.type === "bar:resume") return void resume();
  if (msg.type === "bar:end") return void endGuide();
  if (msg.type === "bar:pause") return void (send(state.tabId, { type: "hide" }).catch(() => {}), pause());
  if (msg.type === "bar:replan") return void replanNow();
  if (msg.type === "bar:settings") {
    Object.assign(settings, msg.settings || {});
    saveSettings();
    ui("settings", { settings });
    return;
  }
  if (msg.type === "brain:granted") {
    view.grant = null;
    ui("grant", { grant: null });
    clearDocsCache();
    if ((msg.origins || []).includes("<all_urls>")) screenshotsAllowed();
    return;
  }
  // Dev-only test hook for the docs layer: window.postMessage({ __waypoint: "debug-docs", q: JSON.stringify({...}) }).
  // Page test hooks (window.postMessage) only work in watch builds: a real page must never be able to
  // start AI calls on the user's behalf.
  if (msg.type === "page-command" && !__WAYPOINT_DEV__) return;
  if (__WAYPOINT_DEV__ && msg.type === "page-command" && msg.command === "debug-docs") {
    const { urls = [], question = "", title = "", labels = [], suggest = true } = JSON.parse(msg.q || "{}");
    (async () => {
      try {
        const host = new URL(sender.tab.url).host;
        const d = await docLookup({ urls, question, title, labels, host, suggest });
        send(fromTab, {
          type: "debug",
          text: `docs ↓ ${JSON.stringify({ how: d.how, list: d.list, failed: d.failed, needs: d.needs, sources: d.sources, ms: d.ms, text: d.text ? d.text(question, 900) : "" })}`,
        });
      } catch (e) {
        send(fromTab, { type: "debug", text: `docs error: ${e?.message || e}` });
      }
    })();
    return;
  }
  // Test hooks for the picker: window.postMessage({ __waypoint: "pick" }) / ({ __waypoint: "pick-ask", q }).
  if (msg.type === "page-command" && msg.command === "pick") return void startPick(fromTab);
  if (msg.type === "page-command" && msg.command === "pick-ask" && msg.q && pick.desc) {
    ui("query", { text: msg.q });
    return void handlePick(msg.q);
  }
  if (msg.type === "page-command" && msg.command === "ask" && msg.q) {
    // Stale content-script copies forward the same command too; take the first.
    const key = `${fromTab}|${msg.q}`;
    if (key === lastCommand.key && Date.now() - lastCommand.at < 2000) return;
    lastCommand = { key, at: Date.now() };
    devStale().then((stale) => {
      if (stale) {
        try { sessionStorage.setItem("waypoint-pending", JSON.stringify({ q: msg.q, tab: fromTab })); } catch {}
        devReload();
        return;
      }
      ui("query", { text: msg.q });
      handle(msg.q, fromTab);
    });
    return;
  }
  if (msg.type === "picked" && fromTab != null) return setPicked(msg.desc, fromTab);
  if (msg.type === "pick-cleared" && fromTab === pick.tabId) return clearPicked(false);
  if (msg.type === "pick-cancelled") {
    setPicking(false);
    status("Picking cancelled.");
    return;
  }
  if (fromTab !== state.tabId) return;
  if (msg.type === "target-clicked") {
    send(state.tabId, { type: "hide" });
    if (state.revealing) {
      // They opened a menu: search the same step again now that its items are showing.
      state.revealing = false;
      if (state.mode === "route") scheduleStep(600);
      else if (state.mode === "single") setTimeout(() => ask(state.goal, state.tabId), 600);
    } else if (state.mode === "route") {
      if (state.steps[state.i]) state.steps[state.i].donePath = msg.path;
      state.i += 1;
      busy("Finding the next step…");
      scheduleStep(800);
    } else if (state.mode === "single") {
      state.mode = "idle";
      chip("done", "Done");
      status("Done.");
    }
  } else if ((msg.type === "url-changed" || msg.type === "page-ready") && state.mode === "explain") {
    // The tour explains one page; if the user leaves it, end it rather than pointing at stale controls.
    send(state.tabId, { type: "hide" }).catch(() => {});
    state.gen++;
    Object.assign(state, { mode: "idle", tour: null });
    chip(null);
    renderSteps();
    status("You left the page, so the tour ended. Ask again to explain this one.");
  } else if ((msg.type === "url-changed" || msg.type === "page-ready") && state.mode === "route" && !state.paused) {
    scheduleStep(msg.type === "page-ready" ? 300 : 900);
  } else if (msg.type === "target-lost" && !state.paused) {
    // The highlighted control vanished (re-render, closed drawer, navigation): find it again.
    if (state.mode === "explain") {
      remapTour().then(() => showTourItem(state.tour?.idx ?? 0, 1));
    } else if (state.mode === "route") {
      busy("Finding the step again…");
      scheduleStep(400);
    } else if (state.mode === "single") relocateSingle();
  } else if (msg.type === "explain-next" && state.mode === "explain") {
    showTourItem(state.tour.idx + 1, 1);
  } else if (msg.type === "explain-back" && state.mode === "explain") {
    showTourItem(state.tour.idx - 1, -1);
  } else if (msg.type === "overlay-paused") {
    pause();
  } else if (msg.type === "resume") {
    resume();
  } else if (msg.type === "end") {
    endGuide();
  }
});

// ---------- Startup ----------

function setNano(next) {
  view.nano = next;
  ui("nano", { nano: next });
}
// Runs at startup, and again when onboarding finishes downloading the model.
let nanoStarting = null;
const startNano = () => (nanoStarting ||= warmNano().finally(() => (nanoStarting = null)));
async function warmNano() {
  if (view.nano?.state === "ready") return;
  if (!("LanguageModel" in self)) return setNano({ state: "missing", text: "Gemini Nano isn't available in this browser" });
  const opts = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
  const a = await LanguageModel.availability(opts).catch(() => "unavailable");
  if (a !== "available") return setNano({ state: a, text: a === "downloadable" || a === "downloading" ? "Gemini Nano needs to download" : "Gemini Nano is turned off" });
  setNano({ state: "warming", text: "Waking Gemini Nano…" });
  // Warm-up: load Nano into memory now so the first real question doesn't pay the cold start, and keep this
  // session open for the brain's lifetime: Chrome unloads the model once no session holds it.
  const t0 = performance.now();
  try {
    const sess = (self.__waypointKeepAlive = await LanguageModel.create(opts));
    await sess.prompt("Reply with OK.");
    nanoReady = true;
    const img = await LanguageModel.availability({ ...opts, expectedInputs: [...opts.expectedInputs, { type: "image" }] }).catch(() => "unavailable");
    setNano({ state: "ready", text: "On-device ready", warmupMs: Math.round(performance.now() - t0), vision: img === "available" });
  } catch (e) {
    console.warn("[Waypoint] warm-up failed", e);
    setNano({ state: "error", text: `Gemini Nano failed to start: ${e?.message || e}` });
  }
}
startNano();

// Dev hot-reload: unpacked extensions read files from disk, so a new build-id means a rebuild happened.
// Chrome throttles timers in background pages, so a test request also checks for a newer build first;
// if there is one, the extension reloads and the request is replayed (dev builds only).
const readBuild = () => fetch(chrome.runtime.getURL("build-id.txt"), { cache: "no-store" }).then((r) => r.text()).catch(() => "");
let devBuild = "";
async function devReload() {
  // A full extension reload: Chrome caches manifest content scripts until then. The service worker
  // re-injects the page script into open tabs on the way back up.
  chrome.runtime.sendMessage({ to: "sw", type: "dev-reload" }).catch(() => location.reload());
}
async function devStale() {
  if (!devBuild) return false;
  const now = await readBuild();
  return !!now && now !== devBuild;
}
(async () => {
  devBuild = await readBuild();
  if (!devBuild) return;
  setInterval(async () => {
    if (await devStale()) devReload();
  }, 1500);
  // A test request that arrived just before a reload.
  try {
    const pending = JSON.parse(sessionStorage.getItem("waypoint-pending") || "null");
    sessionStorage.removeItem("waypoint-pending");
    if (pending?.q && pending.tab != null) setTimeout(() => handle(pending.q, pending.tab), 800);
  } catch {}
})();
