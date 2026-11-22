import "./theme.css";
import "./sidepanel.css";

// Trace: a read-only view of what Waypoint's brain did. Every AI call, where it ran (on this device or in the
// cloud), how long it took and exactly what was sent. The brain (offscreen) broadcasts; this listens.
const $ = (id) => document.getElementById(id);
let filter = "all";
let entries = [];

const KIND = { on_device: "device", in_cloud: "cloud", escalate: "signal", info: "info" };
function tally() {
  $("n-device").textContent = entries.filter((e) => e.kind === "on_device").length;
  $("n-cloud").textContent = entries.filter((e) => e.kind === "in_cloud").length;
  $("n-free").textContent = entries.filter((e) => e.kind === "info" && /no AI|Exact match|Already|Status check|Skipped|Back/.test(`${e.title} ${e.detail}`)).length;
}
function time(t) {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function item(e) {
  const li = document.createElement("li");
  li.className = `r ${KIND[e.kind] || "info"}`;
  li.dataset.kind = e.kind;
  li.innerHTML = `<div class="r-top"><span class="badge"></span><span class="r-title"></span><span class="r-ms"></span></div><div class="r-detail"></div><div class="r-time"></div>`;
  li.querySelector(".badge").textContent = e.badge;
  li.querySelector(".r-title").textContent = e.title;
  li.querySelector(".r-ms").textContent = e.ms != null ? `${e.ms} ms` : "";
  li.querySelector(".r-detail").textContent = e.detail || "";
  li.querySelector(".r-time").textContent = time(e.at);
  if (e.sent) {
    const d = document.createElement("details");
    d.innerHTML = `<summary></summary><pre></pre>`;
    d.querySelector("summary").textContent = e.kind === "in_cloud" ? "What left your device" : "Prompt (stayed on this device)";
    d.querySelector("pre").textContent = e.sent;
    li.appendChild(d);
  }
  li.hidden = filter !== "all" && e.kind !== filter;
  return li;
}
function renderLog() {
  const ul = $("log");
  ul.innerHTML = "";
  for (const e of entries) ul.appendChild(item(e));
  tally();
}
function addLog(e) {
  entries.unshift(e);
  $("log").prepend(item(e));
  tally();
}
function renderRoute(route) {
  $("now").hidden = !route;
  if (!route) return;
  $("now-kind").textContent = route.kind === "tour" ? "Tour" : "Route";
  $("now-goal").textContent = route.goal;
  const ol = $("steps");
  ol.innerHTML = "";
  route.steps.forEach((s) => {
    const li = document.createElement("li");
    li.className = `${s.state}${s.missing ? " missing" : ""}`;
    li.textContent = s.text;
    ol.appendChild(li);
  });
}
function renderNano(n) {
  const ready = n?.state === "ready";
  $("nano").className = `nano ${ready ? "ready" : "warn"}`;
  $("nano").querySelector(".dot").className = `dot ${ready ? "device" : n?.state === "checking" || n?.state === "warming" ? "off" : "signal"}`;
  $("nano-text").textContent = ready ? `Nano ready${n.vision ? " · vision" : ""}` : n?.text || "Checking Nano…";
  $("nano").title = ready && n.warmupMs ? `Warmed up in ${n.warmupMs} ms, kept loaded on this device` : "";
}

document.querySelectorAll(".filters button").forEach((b) =>
  b.addEventListener("click", () => {
    filter = b.dataset.f;
    document.querySelectorAll(".filters button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    document.querySelectorAll("#log .r").forEach((li) => (li.hidden = filter !== "all" && li.dataset.kind !== filter));
  })
);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.to !== "ui") return false;
  if (msg.type === "log") addLog(msg.entry);
  else if (msg.type === "status") $("status").textContent = msg.text;
  else if (msg.type === "route") renderRoute(msg.route);
  else if (msg.type === "nano") renderNano(msg.nano);
  return false;
});

// Tell the service worker this window's Trace panel is open, so the bar's Trace button can close it.
// (The port drops if the worker restarts: reconnect.)
async function announce() {
  const { id: windowId } = await chrome.windows.getCurrent();
  const port = chrome.runtime.connect({ name: "trace" });
  port.postMessage({ windowId });
  port.onMessage.addListener((m) => m?.type === "close" && window.close());
  port.onDisconnect.addListener(() => setTimeout(announce, 200));
}
announce();

(async () => {
  await chrome.runtime.sendMessage({ to: "sw", type: "ensure-brain" }).catch(() => {});
  const s = await chrome.runtime.sendMessage({ type: "brain:snapshot" }).catch(() => null);
  if (!s) return;
  entries = s.logs || [];
  renderLog();
  renderRoute(s.route);
  renderNano(s.nano);
  if (s.status) $("status").textContent = s.status;
})();
