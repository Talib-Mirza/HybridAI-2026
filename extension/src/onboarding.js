import "./theme.css";
import "./onboarding.css";

// Onboarding: live checks for everything Waypoint needs, in the order you'd fix them. It re-checks on its
// own (every few seconds and when you come back to the tab), so after a flag change + relaunch it just
// turns green.
const $ = (s, r = document) => r.querySelector(s);
const OPTS = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
const STATE_TEXT = { ok: "Done", act: "Your move", fail: "Needs a fix", checking: "Checking…", waiting: "After the step above", busy: "Downloading…", skip: "Skipped" };

function set(id, state, msg, actions = []) {
  const cp = $(`#cp-${id}`);
  cp.dataset.state = state;
  $(".state", cp).textContent = STATE_TEXT[state] || "";
  if (msg != null) $(".msg", cp).textContent = msg;
  const act = $(".act", cp);
  act.replaceChildren(...actions);
}
function button(label, onClick, ghost = false) {
  const b = document.createElement("button");
  b.className = `btn${ghost ? " ghost" : ""}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}
const openTab = (url) => chrome.tabs.create({ url });
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-open]");
  if (t) openTab(t.dataset.open);
});

if (location.hash === "#cant-run-here") $("#cant").hidden = false;

function chromeMajor() {
  const b = navigator.userAgentData?.brands?.find((x) => /Chrom/.test(x.brand));
  return Number(b?.version || navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || 0);
}

let downloading = false;
async function download() {
  downloading = true;
  const cp = $("#cp-model");
  $(".bar", cp).hidden = false;
  set("model", "busy", "Downloading Gemini Nano. It's a one-time download of a few GB; you can keep using Chrome.");
  try {
    const s = await LanguageModel.create({
      ...OPTS,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          const p = Math.round((e.loaded ?? 0) * 100);
          $(".fill", cp).style.width = `${p}%`;
          $(".msg", cp).textContent = p < 100 ? `Downloading Gemini Nano… ${p}%` : "Unpacking the model…";
        });
      },
    });
    s.destroy();
    await chrome.runtime.sendMessage({ type: "brain:nano-recheck" }).catch(() => {});
  } catch (e) {
    set("model", "fail", `The download stopped: ${e?.message || e}. Check your free disk space, then try again.`, [button("Try again", download)]);
  }
  downloading = false;
  check();
}

let ready = false;
async function check() {
  // 1. Chrome version
  const v = chromeMajor();
  const chromeOk = v >= 138;
  set("chrome", chromeOk ? "ok" : "fail", chromeOk ? `You're on Chrome ${v}.` : `You're on Chrome ${v || "(unknown)"}. Waypoint needs the built-in AI that arrived in Chrome 138.`, chromeOk ? [] : [button("Update Chrome", () => openTab("chrome://settings/help"))]);

  // 2. The Prompt API
  const hasApi = "LanguageModel" in self;
  let a = "unavailable";
  if (hasApi) a = await LanguageModel.availability(OPTS).catch(() => "unavailable");
  const apiOk = hasApi && a !== "unavailable";
  $("#cp-api .how").hidden = apiOk;
  set(
    "api",
    apiOk ? "ok" : "fail",
    apiOk ? "Chrome's built-in Gemini Nano is on." : hasApi ? "Chrome has the API but says Gemini Nano can't run here yet. Usually a flag or a hardware limit:" : "Chrome's built-in AI isn't switched on. Three steps:",
    apiOk ? [] : [button("Check again", check, true)]
  );

  // 3. The model itself
  if (!apiOk) set("model", "waiting", "Once Gemini Nano is on, it downloads here.");
  else if (a === "available") {
    $("#cp-model .bar").hidden = true;
    set("model", "ok", "Downloaded and ready. It runs offline, on this computer.");
  } else if (!downloading) {
    set(
      "model",
      "act",
      a === "downloading" ? "Chrome already started downloading it. Click to watch the progress." : "One download, a few GB, done once. After that Waypoint answers in about a second, offline.",
      [button(a === "downloading" ? "Show progress" : "Download Gemini Nano", download)]
    );
  }

  // 4. Image input (the picker uses it for charts and icons)
  if (a !== "available") set("vision", "waiting", "Lets Nano look at charts and icon buttons you pick.");
  else {
    const img = await LanguageModel.availability({ ...OPTS, expectedInputs: [...OPTS.expectedInputs, { type: "image" }] }).catch(() => "unavailable");
    const vOk = img === "available";
    set(
      "vision",
      vOk ? "ok" : "act",
      vOk ? "Nano can look at charts and icon buttons you pick, on this computer." : "Turn this on so Nano can read charts and icon buttons you pick. Everything else works without it.",
      vOk ? [] : [button("Open the flag", () => openTab("chrome://flags/#prompt-api-for-gemini-nano-multimodal-input"), true)]
    );
  }

  // 5. Sites
  const all = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  set(
    "sites",
    all ? "ok" : "act",
    all
      ? "On for every site. You can switch individual sites off from the bar's corner."
      : "Right now Waypoint asks per site: open the bar anywhere and flip 'This site' on. Or turn it on everywhere now. Either way, your page is read on this computer.",
    all
      ? [button("Back to asking per site", async () => (await chrome.runtime.sendMessage({ to: "sw", type: "all-sites-off" }).catch(() => {}), check()), true)]
      : [
          button("Allow on every site", async () => {
            const ok = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
            if (ok) await chrome.runtime.sendMessage({ to: "sw", type: "granted" }).catch(() => {});
            check();
          }, true),
        ]
  );

  ready = chromeOk && apiOk && a === "available";
  $("#done").hidden = !ready;
  document.body.classList.toggle("is-ready", ready);
}

async function keys() {
  const NAMES = { _execute_action: "Open the bar", "toggle-bar": "Open the Waypoint bar", "start-pick": "Pick something on the page" };
  const cmds = await chrome.commands.getAll();
  const dl = $("#keys");
  dl.replaceChildren();
  for (const c of cmds) {
    if (!NAMES[c.name] || c.name === "_execute_action") continue;
    const dt = document.createElement("dt");
    dt.append(...(c.shortcut ? c.shortcut.split(/\+|(?<=[⌥⇧⌘⌃])/).filter(Boolean).map((k) => Object.assign(document.createElement("span"), { className: "kbd", textContent: k })) : [Object.assign(document.createElement("span"), { className: "unset", textContent: "Not set" })]));
    const dd = document.createElement("dd");
    dd.textContent = NAMES[c.name];
    dl.append(dt, dd);
  }
  const dt = document.createElement("dt");
  dt.innerHTML = `<span class="kbd">Right-click</span>`;
  const dd = document.createElement("dd");
  dd.textContent = "Ask Waypoint about this";
  dl.append(dt, dd);
}
$("#cp-keys .state").textContent = "";

check();
keys();
setInterval(() => !ready && !downloading && document.visibilityState === "visible" && check(), 4000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
