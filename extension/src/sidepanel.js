import "./sidepanel.css";
import { pickElement, planRoute, hasKeywordHit, exactMatch } from "./pipeline.js";

const $ = (id) => document.getElementById(id);
const CONFIDENCE_MIN = 0.5; // below this, Nano's pick counts as "not found" and Waypoint escalates

const state = {
  tabId: null,
  mode: "idle", // idle | single | route
  goal: "",
  steps: [],
  i: 0,
  gen: 0, // bumps on every new question so stale work stops
  run: 0, // bumps on every step search so only the newest one may show a bubble
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

async function locate(question, gen, run = state.run) {
  const stale = () => gen !== state.gen || run !== state.run;
  const outline = await send(state.tabId, { type: "outline" });
  if (stale()) return null;
  const pick = await pickElement({ question, outline, forceCloud: $("force-cloud").checked });
  if (stale()) return null;
  log({
    kind: pick.source === "in_cloud" ? "in_cloud" : pick.source === "on_device" ? "on_device" : "info",
    title: `Find "${question.slice(0, 60)}"`,
    detail: `${pick.elementId} · confidence ${Number(pick.confidence).toFixed(2)} · ${pick.candidates}/${pick.total} controls shortlisted · ${SOURCE_LABEL[pick.source] || pick.source}`,
    sent: pick.sent,
    ms: pick.ms,
  });
  const found =
    pick.elementId !== "none" &&
    pick.confidence >= CONFIDENCE_MIN &&
    (await send(state.tabId, { type: "check", id: pick.elementId }))?.ok;
  return { outline, pick, found };
}

async function ask(question, tabId) {
  const gen = ++state.gen;
  Object.assign(state, { tabId, mode: "idle", goal: question, steps: [], i: 0 });
  renderSteps();
  $("replan").hidden = true;
  await ensureFresh(tabId);
  await send(tabId, { type: "hide" });

  try {
    status("Reading this page…");
    const res = await locate(question, gen);
    if (!res) return;
    if (res.found && (res.pick.completesGoal || res.pick.alreadyDone)) {
      state.mode = "single";
      await send(tabId, {
        type: "show",
        id: res.pick.elementId,
        step: res.pick.alreadyDone ? "Already done" : "Here",
        text: res.pick.explanation,
        src: SOURCE_LABEL[res.pick.source],
      });
      status("Found it on this page.");
      return;
    }
    if (res.found) {
      // Nano knows the first move: show it instantly while the cloud plans the rest of the route.
      await send(tabId, {
        type: "show",
        id: res.pick.elementId,
        step: "Step 1",
        text: res.pick.explanation,
        why: "Planning the rest of the route…",
        src: SOURCE_LABEL[res.pick.source],
      });
    }
    await escalate(question, res.outline, res.pick, gen);
  } catch (e) {
    console.error(e);
    status(`Error: ${e?.message || e}`);
  }
}

async function escalate(goal, outline, pick, gen) {
  log({
    kind: "escalate",
    title: "Escalating to cloud Gemini",
    detail:
      pick.elementId === "none"
        ? "Gemini Nano found no matching control on this page, so a route is needed."
        : pick.confidence < CONFIDENCE_MIN
          ? `Gemini Nano's best match was only ${Number(pick.confidence).toFixed(2)} confident.`
          : "Gemini Nano found the first step; the goal is on another page, so the cloud plans the route.",
  });
  status("Planning the route with cloud Gemini…");
  const plan = await planRoute({ goal, outline });
  if (gen !== state.gen) return;
  log({
    kind: "in_cloud",
    title: `Route planned (${plan.steps.length} steps)`,
    detail: `${plan.model}${plan.grounded ? " · grounded with Google Search" : ""} · ${plan.steps.map((s) => s.target).join(" → ")}`,
    sent: plan.sent,
    ms: plan.ms,
  });
  Object.assign(state, { mode: "route", steps: plan.steps, i: 0 });
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
  try {
    await ensureFresh(state.tabId);
    const outline = await send(state.tabId, { type: "outline" });
    if (stale()) return;

    // Rung 1, no AI: an exact label match for this step or up to two steps ahead. Take the furthest,
    // so a stale planner step (or one the user already did) is skipped for free.
    for (let j = Math.min(state.i + 2, state.steps.length - 1); j >= state.i; j--) {
      const hit = exactMatch(state.steps[j].target, outline.items);
      if (!hit || !(await send(state.tabId, { type: "check", id: hit.id }))?.ok) continue;
      if (stale()) return;
      if (j > state.i) log({ kind: "info", title: `Skipped to step ${j + 1}`, detail: `"${state.steps[j].target}" is already on screen.` });
      log({ kind: "info", title: `Exact match: "${hit.label}"`, detail: "Found by label, no AI call needed." });
      state.i = j;
      renderSteps();
      await send(state.tabId, {
        type: "show",
        id: hit.id,
        step: `Step ${j + 1} of ${state.steps.length}`,
        text: state.steps[j].instruction,
        src: "Exact label match · no AI call",
      });
      status(`Step ${j + 1} of ${state.steps.length}: ${state.steps[j].instruction}`);
      return;
    }

    // Rung 2, Gemini Nano: the current step, then the next one (the user may have skipped ahead).
    for (const j of [state.i, state.i + 1]) {
      const step = state.steps[j];
      if (!step) continue;
      // Pages load late: don't spend a model call until the target's words are on screen.
      if (attempt < 3 && !hasKeywordHit(step.target, outline.items)) continue;
      status(`Step ${j + 1}: looking for "${step.target}"…`);
      const res = await locate(`"${step.target}" (${step.instruction}; ${step.where})`, gen, run);
      if (!res || stale()) return;
      if (res.found) {
        state.i = j;
        renderSteps();
        await send(state.tabId, {
          type: "show",
          id: res.pick.elementId,
          step: `Step ${j + 1} of ${state.steps.length}`,
          text: step.instruction,
          why: res.pick.explanation,
          src: SOURCE_LABEL[res.pick.source],
        });
        status(`Step ${j + 1} of ${state.steps.length}: ${step.instruction}`);
        return;
      }
    }
    if (stale()) return;
    if (attempt < 5) {
      status("Waiting for the page to load…");
      stepTimer = setTimeout(() => runStep(gen, attempt + 1, run), 900);
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
  const gen = ++state.gen;
  $("replan").hidden = true;
  const outline = await send(state.tabId, { type: "outline" });
  escalate(state.goal, outline, { elementId: "none", confidence: 0 }, gen).catch((e) => status(`Error: ${e?.message}`));
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
    if (state.mode === "route") {
      state.i += 1;
      send(state.tabId, { type: "hide" });
      scheduleStep(800);
    } else if (state.mode === "single") {
      state.mode = "idle";
      send(state.tabId, { type: "hide" });
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
