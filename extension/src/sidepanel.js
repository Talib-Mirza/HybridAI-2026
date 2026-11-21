import "./sidepanel.css";
import { pickElement, planRoute, hasKeywordHit, exactMatch, alreadyHere, looksDone, specificToGoal } from "./pipeline.js";

const $ = (id) => document.getElementById(id);

const state = {
  tabId: null,
  mode: "idle", // idle | single | route
  goal: "",
  steps: [],
  i: 0,
  gen: 0, // bumps on every new question so stale work stops
  run: 0, // bumps on every step search so only the newest one may show a bubble
  replans: 0, // automatic cloud re-plans used for the current goal
  revealing: false, // the bubble is on a menu toggle; clicking it re-searches instead of advancing
};

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
    return await chrome.tabs.sendMessage(tabId, m);
  } catch {
    // Content script missing (tab opened before install/reload): inject and retry once.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tabId, m);
  }
}

// Chrome caches manifest content scripts until the extension is reloaded, so after a rebuild a full page
// load can run a stale copy. Copies injected from here mark the page; anything else gets replaced.
async function ensureFresh(tabId) {
  const r = await chrome.tabs.sendMessage(tabId, { type: PROTO + "ping" }).catch(() => null);
  if (r?.fresh) return;
  await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__waypointInjected = true; } });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function consoleTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url?.startsWith("https://console.firebase.google.com/")) return null;
  return tab.id;
}

function status(text) {
  $("status").textContent = text;
  if (state.tabId) send(state.tabId, { type: "status", text }).catch(() => {});
}

// ---------- Escalation receipt ----------

const SOURCE_LABEL = { on_device: "On-device · Gemini Nano", in_cloud: "Cloud · Gemini", none: "No AI call" };

function log({ kind, title, detail, sent, ms }) {
  const li = document.createElement("li");
  li.className = `log ${kind}`;
  const badge = { on_device: "On-device", in_cloud: "Cloud", escalate: "Escalation", info: "Info" }[kind] || kind;
  li.innerHTML = `<div class="log-head"><span class="pill">${badge}</span><strong></strong><span class="ms"></span></div><div class="detail"></div>`;
  li.querySelector("strong").textContent = title;
  li.querySelector(".ms").textContent = ms != null ? `${ms} ms` : "";
  li.querySelector(".detail").textContent = detail || "";
  if (sent) {
    const d = document.createElement("details");
    d.innerHTML = `<summary>${kind === "in_cloud" ? "What left your device" : "Prompt (stayed on this device)"}</summary><pre></pre>`;
    d.querySelector("pre").textContent = sent;
    li.appendChild(d);
  }
  $("log").prepend(li);
  // Mirror the receipt into the page console (handy when testing without the panel in view).
  if (state.tabId) {
    const line = `${badge}: ${title}${detail ? ` — ${detail}` : ""}${ms != null ? ` (${ms} ms)` : ""}`;
    send(state.tabId, { type: "debug", text: line }).catch(() => {});
    if (__WAYPOINT_DEV__ && sent) send(state.tabId, { type: "debug", text: `prompt ↓\n${sent}` }).catch(() => {});
  }
}

// ---------- Route UI ----------

function renderSteps() {
  $("route").hidden = state.mode !== "route";
  const ol = $("steps");
  ol.innerHTML = "";
  state.steps.forEach((s, idx) => {
    const li = document.createElement("li");
    li.className = idx < state.i ? "done" : idx === state.i ? "current" : "";
    li.textContent = s.instruction;
    ol.appendChild(li);
  });
}

// ---------- Core flow ----------

const MAX_AUTO_REPLANS = 2;

/**
 * Where to put the bubble for an outline item. A control hidden inside a collapsed menu is shown on the
 * menu toggle instead ("reveal"); after the user opens it, the same step is searched again.
 */
function placement(outline, id, opensMenu = false) {
  const item = outline.items.find((it) => it.id === id);
  if (item?.expander) {
    const exp = outline.items.find((it) => it.id === item.expander);
    return { showId: item.expander, reveal: true, revealText: `Open "${exp?.label || "this menu"}" to reveal "${item.label}".` };
  }
  // Nano sometimes flags an ordinary item as a menu; only a control that is actually collapsed counts.
  if (opensMenu && item?.state.includes("collapsed")) return { showId: id, reveal: true, revealText: `Open "${item?.label || "this menu"}"; what you need should be inside.` };
  // Row actions that only appear on hover: the ring sits on the row and jumps to the control on hover.
  const hoverHint = item?.hover ? `Hover over "${item.hover}" to reveal it.` : "";
  return { showId: id, reveal: false, revealText: "", hoverHint };
}

async function show(where, bubble) {
  state.revealing = where.reveal;
  await send(state.tabId, {
    type: "show",
    id: where.showId,
    ...bubble,
    text: where.reveal ? where.revealText : bubble.text,
    why: where.reveal ? bubble.text : where.hoverHint || bubble.why,
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
  const pick = await pickElement({ question, outline, forceCloud: $("force-cloud").checked });
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

/** The control's own status says the goal is already in place: say so and stop (no AI call). */
async function reportDone(item, where) {
  const evidence = looksDone(state.goal, item);
  if (!evidence) return false;
  log({ kind: "info", title: "Already done", detail: `"${item.label}" shows "${evidence}".` });
  state.mode = "idle";
  await show(where, { step: "Already done", text: `"${item.label}" already shows "${evidence}".`, why: "Nothing to change.", src: "Status check · no AI call" });
  status("Already done: nothing to change.");
  return true;
}

async function ask(question, tabId) {
  const gen = ++state.gen;
  Object.assign(state, { tabId, mode: "idle", goal: question, steps: [], i: 0, replans: 0, revealing: false });
  renderSteps();
  $("replan").hidden = true;
  await ensureFresh(tabId);
  await send(tabId, { type: "hide" });

  try {
    status("Reading this page…");
    const res = await locate(question, gen);
    if (!res) return;
    const { pick } = res;
    const picked = res.found && res.outline.items.find((it) => it.id === pick.elementId);
    if (picked && !res.where.reveal && (await reportDone(picked, res.where))) return;
    const label = picked?.label || "this control";
    // Nano's "this completes it" only counts if the control names something specific to the goal.
    const completes = pick.completesGoal && picked && specificToGoal(question, picked.label, res.outline);
    if (pick.completesGoal && !completes) {
      log({ kind: "info", title: "Not convinced", detail: `"${label}" doesn't name anything specific to the goal, so the cloud plans instead.` });
    }
    if (res.found && (completes || res.where.reveal)) {
      // The goal is on this page (possibly inside a collapsed menu): no route needed.
      state.mode = "single";
      await show(res.where, {
        step: "Here",
        text: `Use "${label}".`,
        src: SOURCE_LABEL[pick.source],
      });
      status(res.where.reveal ? "It's inside a collapsed menu on this page." : "Found it on this page.");
      return;
    }
    if (res.found && !pick.completesGoal) {
      // Nano knows the first move: show it instantly while the cloud plans the rest of the route.
      await show(res.where, {
        step: "Step 1",
        text: `Start with "${label}".`,
        why: "Planning the rest of the route…",
        src: SOURCE_LABEL[pick.source],
      });
    }
    await escalate(question, res.outline, gen, { pick });
  } catch (e) {
    console.error(e);
    status(`Error: ${e?.message || e}`);
  }
}

async function escalate(goal, outline, gen, { pick = null, failed = null } = {}) {
  const done = state.steps.slice(0, state.i).map((s) => s.target);
  log({
    kind: "escalate",
    title: failed ? "Re-planning with cloud Gemini" : "Escalating to cloud Gemini",
    detail: failed
      ? `The planned step "${failed}" isn't on this page, so the route is re-planned from what is.`
      : pick.elementId === "none" || pick.completesGoal
        ? "Gemini Nano found no control on this page that clearly does this, so a route is needed."
        : "Gemini Nano found the first step; the goal is on another page, so the cloud plans the route.",
  });
  status(failed ? "Re-planning from this page with cloud Gemini…" : "Planning the route with cloud Gemini…");
  const plan = await planRoute({ goal, outline, done, failed });
  if (gen !== state.gen) return;
  log({
    kind: "in_cloud",
    title: `Route ${failed ? "re-planned" : "planned"} (${plan.steps.length} steps)`,
    detail: `${plan.model}${plan.grounded ? " · grounded with Google Search" : ""} · ${plan.steps.map((s) => s.target).join(" → ")}`,
    sent: plan.sent,
    ms: plan.ms,
  });
  // A re-plan replaces the remaining steps; completed ones stay visible.
  const kept = failed ? state.steps.slice(0, state.i) : [];
  Object.assign(state, { mode: "route", steps: [...kept, ...plan.steps], i: kept.length });
  renderSteps();
  scheduleStep(0);
}

async function runStep(gen, attempt, run) {
  const stale = () => gen !== state.gen || run !== state.run || state.mode !== "route";
  if (stale()) return;
  if (state.i >= state.steps.length) {
    status("Route complete. Review the final screen before confirming anything.");
    await send(state.tabId, { type: "hide" });
    state.mode = "idle";
    renderSteps();
    $("route").hidden = false;
    return;
  }
  renderSteps();
  const of = () => `Step ${state.i + 1} of ${state.steps.length}`;
  try {
    await ensureFresh(state.tabId);
    const outline = await send(state.tabId, { type: "outline" });
    if (stale()) return;

    // Steps for where the user already is (the current page's nav link, the selected tab) are done.
    while (state.i < state.steps.length - 1 && alreadyHere(state.steps[state.i].target, outline.items)) {
      log({ kind: "info", title: `Already on "${state.steps[state.i].target}"`, detail: "Skipped: nothing to click." });
      state.i += 1;
    }

    // Rung 1, no AI: an exact label match for this step or up to two steps ahead. Take the NEAREST step
    // that is on screen: a stale planner step that isn't here (or a menu that's already open) is skipped
    // for free, but a step that is here is never jumped over.
    for (let j = state.i; j <= Math.min(state.i + 2, state.steps.length - 1); j++) {
      const hit = exactMatch(state.steps[j].target, outline.items);
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
      await show(where, { step: of(), text: state.steps[j].instruction, src: "Exact label match · no AI call" });
      status(`${of()}: ${where.reveal ? where.revealText : state.steps[j].instruction}`);
      return;
    }

    // Rung 2, Gemini Nano: the current step, then the next one (the user may have skipped ahead).
    // Only when the target's words are actually on screen; otherwise there is nothing for Nano to find
    // and guessing (e.g. "some menu") does more harm than re-planning.
    let tried = false;
    for (const j of [state.i, state.i + 1]) {
      const step = state.steps[j];
      if (!step || !hasKeywordHit(step.target, outline.items)) continue;
      tried = true;
      status(`Step ${j + 1}: looking for "${step.target}"…`);
      const res = await locate(`"${step.target}" (${step.instruction}; ${step.where})`, gen, run);
      if (!res || stale()) return;
      if (res.found) {
        state.i = j;
        renderSteps();
        await show(res.where, { step: of(), text: step.instruction, src: SOURCE_LABEL[res.pick.source] });
        status(`${of()}: ${res.where.reveal ? res.where.revealText : step.instruction}`);
        return;
      }
    }
    if (stale()) return;
    // Give a loading page ~2 s; give Nano up to 4 tries when the target's words are on screen.
    if (attempt < 2 || (tried && attempt < 4)) {
      status("Waiting for the page to load…");
      stepTimer = setTimeout(() => runStep(gen, attempt + 1, run), 900);
    } else if (state.replans < MAX_AUTO_REPLANS) {
      // Rung 3, cloud: the plan was wrong for this page; re-plan from what's actually on screen.
      state.replans += 1;
      await escalate(state.goal, outline, gen, { failed: state.steps[state.i].target });
    } else {
      status(`Couldn't find "${state.steps[state.i].target}" here. Navigate there, or re-plan from this page.`);
      $("replan").hidden = false;
    }
  } catch (e) {
    console.error(e);
    status(`Error: ${e?.message || e}`);
  }
}

// ---------- Events ----------

$("ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  const tabId = await consoleTab();
  if (!tabId) {
    $("status").textContent = "Switch to a Firebase console tab first.";
    return;
  }
  ask(q, tabId);
});

$("replan").addEventListener("click", async () => {
  const gen = state.gen;
  $("replan").hidden = true;
  const outline = await send(state.tabId, { type: "outline" });
  escalate(state.goal, outline, gen, { failed: state.steps[state.i]?.target || "(unknown)" }).catch((e) =>
    status(`Error: ${e?.message}`)
  );
});

let lastCommand = { key: "", at: 0 };
chrome.runtime.onMessage.addListener((msg, sender) => {
  const fromTab = sender.tab?.id;
  if (msg.type === "page-command" && msg.command === "ask" && msg.q) {
    // Stale content-script copies forward the same command too; take the first.
    const key = `${fromTab}|${msg.q}`;
    if (key === lastCommand.key && Date.now() - lastCommand.at < 2000) return;
    lastCommand = { key, at: Date.now() };
    $("q").value = msg.q;
    ask(msg.q, fromTab);
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
      state.i += 1;
      scheduleStep(800);
    } else if (state.mode === "single") {
      state.mode = "idle";
      status("Done.");
    }
  } else if (msg.type === "url-changed" && state.mode === "route") {
    scheduleStep(900);
  } else if (msg.type === "overlay-closed") {
    state.gen++;
    state.mode = "idle";
    status("Guidance closed.");
  }
});

// ---------- Startup ----------

(async () => {
  const el = $("nano");
  if (!("LanguageModel" in self)) {
    el.textContent = "Nano: not in this browser (cloud only)";
    el.className = "badge warn";
    return;
  }
  const a = await LanguageModel.availability({
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  });
  el.textContent = `Gemini Nano: ${a}`;
  el.className = `badge ${a === "available" ? "ok" : "warn"}`;
  if (a === "available") {
    // Warm-up: load Nano into memory now so the first real question doesn't pay the cold start.
    const t0 = performance.now();
    try {
      const s = await LanguageModel.create({
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
      });
      await s.prompt("Reply with OK.");
      s.destroy();
      el.textContent = `Gemini Nano: ready (${Math.round(performance.now() - t0)} ms warm-up)`;
    } catch (e) {
      console.warn("[Waypoint] warm-up failed", e);
    }
  }
})();

// Dev hot-reload: unpacked extensions read files from disk, so a new build-id means a rebuild happened.
// Reload only this panel and re-inject the content script; a full chrome.runtime.reload() would close
// the side panel, and Chrome only reopens it on a user click. (manifest/background changes still need
// a manual reload from chrome://extensions.)
(async () => {
  const read = () => fetch(chrome.runtime.getURL("build-id.txt"), { cache: "no-store" }).then((r) => r.text()).catch(() => "");
  const first = await read();
  if (!first) return;
  setInterval(async () => {
    const now = await read();
    if (!now || now === first) return;
    const tabs = await chrome.tabs.query({ url: "https://console.firebase.google.com/*" });
    for (const t of tabs) {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] }).catch(() => {});
    }
    location.reload();
  }, 1500);
})();
