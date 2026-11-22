// Waypoint service worker: the router.
// - The toolbar icon / Alt+Shift+W opens the in-page command bar; Alt+Shift+P (or right-click "Ask Waypoint
//   about this") goes straight to picking.
// - The brain (offscreen.html) does all the AI work but can only use chrome.runtime, so its tabs / scripting /
//   permissions calls come here ("rpc") and the answers go back.
// - Permission prompts need a click inside an extension page, so the bar asks for them through a small
//   grant window (grant.html).
// - Keeps the content script registered on every site the user allowed.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

const BUILT_IN = "https://console.firebase.google.com/*";
const DYNAMIC_ID = "waypoint-granted-sites";

// ---------- The brain (offscreen document) ----------
let creating = null;
async function ensureBrain() {
  if (await chrome.offscreen.hasDocument?.()) return;
  creating ||= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "Runs Waypoint's on-device (Gemini Nano) and cloud AI calls and parses documentation pages.",
    })
    .catch((e) => {
      if (!/single offscreen/i.test(String(e?.message))) throw e;
    })
    .finally(() => (creating = null));
  await creating;
}

// ---------- Content script on granted sites ----------
async function syncContentScripts() {
  const { origins = [] } = await chrome.permissions.getAll();
  const granted = origins.filter((o) => o !== BUILT_IN);
  await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_ID] }).catch(() => {});
  if (!granted.length) return;
  await chrome.scripting.registerContentScripts([
    { id: DYNAMIC_ID, matches: granted, excludeMatches: [BUILT_IN], js: ["content.js"], runAt: "document_idle", persistAcrossSessions: true },
  ]);
}
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://*/*", "http://*/*"] });
  for (const tab of tabs) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
}
async function refresh() {
  await syncContentScripts().catch((e) => console.warn("[Waypoint] content script sync failed", e?.message));
  await injectIntoOpenTabs();
}

// ---------- The command bar ----------
async function toBar(tab, msg) {
  if (!tab?.id) return false;
  await ensureBrain();
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
    return true;
  } catch {
    // Not injected yet. The toolbar click / shortcut gives activeTab, so this works even on a site the user
    // hasn't allowed permanently; the bar then offers to keep Waypoint on for this site.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["flag.js", "content.js"] });
      await chrome.tabs.sendMessage(tab.id, msg);
      return true;
    } catch {
      return false; // chrome://, the Web Store, PDFs: pages extensions can't touch
    }
  }
}
chrome.action.onClicked.addListener(async (tab) => {
  if (!(await toBar(tab, { type: "w2:bar-toggle" }))) chrome.tabs.create({ url: "onboarding.html#cant-run-here" });
});
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-bar") toBar(tab, { type: "w2:bar-toggle" });
  if (command === "start-pick") toBar(tab, { type: "w2:bar-pick" });
});

// ---------- Right-click "Ask Waypoint about this" ----------
function addMenu() {
  chrome.contextMenus.create({ id: "waypoint-ask", title: "Ask Waypoint about this", contexts: ["all"] }, () => void chrome.runtime.lastError);
}
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "waypoint-ask" || !tab?.id) return;
  await ensureBrain();
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "w2:pick-from-context" });
  } catch {
    // Waypoint isn't on this page yet: open the bar there, which offers to turn it on.
    toBar(tab, { type: "w2:bar-toggle" });
  }
});

// ---------- Install / startup ----------
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  addMenu();
  await ensureBrain();
  refresh();
  if (reason !== "install") return;
  // Onboarding only if Gemini Nano isn't ready yet (the brain checks while it warms up).
  let nano = null;
  for (let i = 0; i < 20 && !["ready", "missing", "unavailable", "downloadable", "downloading", "error"].includes(nano?.state); i++) {
    await new Promise((r) => setTimeout(r, 500));
    nano = await chrome.runtime.sendMessage({ type: "brain:nano" }).catch(() => null);
  }
  if (nano?.state !== "ready") chrome.tabs.create({ url: "onboarding.html" });
});
chrome.runtime.onStartup.addListener(async () => {
  addMenu();
  await ensureBrain();
  refresh();
});
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(() => syncContentScripts().catch(() => {}));

// ---------- Trace panel: is it open in this window? ----------
// The panel connects a port while it's open; the bar's Trace button toggles it (closing asks the panel to
// close itself) and shows it as pressed while it's open.
const traceOpen = new Map(); // windowId -> port
async function traceChanged(windowId, open) {
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "w2:trace-state", open }).catch(() => {});
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "trace") return;
  let win = null;
  port.onMessage.addListener((m) => {
    if (m?.windowId == null) return;
    win = m.windowId;
    traceOpen.set(win, port);
    traceChanged(win, true);
  });
  port.onDisconnect.addListener(() => {
    if (win == null || traceOpen.get(win) !== port) return;
    traceOpen.delete(win);
    traceChanged(win, false);
  });
});

// ---------- Router ----------
const RPC = {
  "tabs.sendMessage": (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
  "tabs.get": (tabId) => chrome.tabs.get(tabId),
  "tabs.query": (q) => chrome.tabs.query(q),
  "tabs.captureVisibleTab": (windowId, opts) => chrome.tabs.captureVisibleTab(windowId, opts),
  "scripting.executeScript": (opts) => chrome.scripting.executeScript(opts).then(() => true),
  "permissions.contains": (p) => chrome.permissions.contains(p),
  "permissions.getAll": () => chrome.permissions.getAll(),
  "storage.session.get": (k) => chrome.storage.session.get(k),
  "storage.session.remove": (k) => chrome.storage.session.remove(k),
};
const ALL_SITES = ["<all_urls>"];
async function siteInfo(url) {
  let u;
  try { u = new URL(url); } catch { return { web: false }; }
  if (!/^https?:$/.test(u.protocol)) return { web: false };
  const pattern = `${u.protocol}//${u.host}/*`;
  const [allowed, all] = await Promise.all([
    chrome.permissions.contains({ origins: [pattern] }),
    chrome.permissions.contains({ origins: ALL_SITES }),
  ]);
  return { web: true, host: u.host, pattern, allowed, all, builtIn: `${pattern}` === BUILT_IN };
}
function openGrant({ origins, text, tabId }) {
  const q = new URLSearchParams({ origins: JSON.stringify(origins), text: text || "", tab: tabId ?? "" });
  return chrome.windows.create({ url: `grant.html?${q}`, type: "popup", width: 440, height: 360, focused: true });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.to !== "sw") return false;
  // The brain's chrome.* calls.
  if (msg.rpc) {
    const fn = RPC[msg.rpc];
    if (!fn) return reply({ error: `Unknown call ${msg.rpc}` }), false;
    Promise.resolve()
      .then(() => fn(...(msg.args || [])))
      .then((result) => reply({ result }), (e) => reply({ error: e?.message || String(e) }));
    return true;
  }
  const tab = sender.tab;
  switch (msg.type) {
    case "ensure-brain":
      ensureBrain().then(() => reply({ ok: true }), (e) => reply({ ok: false, error: e?.message }));
      return true;
    case "site-info":
      siteInfo(msg.url || tab?.url).then(reply);
      return true;
    case "grant": // from the bar: open the small window that asks Chrome for the permission
      openGrant({ origins: msg.origins, text: msg.text, tabId: tab?.id }).then(() => reply({ ok: true }));
      return true;
    case "site-off":
      chrome.permissions.remove({ origins: [msg.pattern] }).then((ok) => reply({ ok }), (e) => reply({ ok: false, error: e?.message }));
      return true;
    case "all-sites-off":
      chrome.permissions.remove({ origins: [...ALL_SITES, "https://*/*", "http://*/*"] }).then((ok) => reply({ ok }));
      return true;
    case "trace": {
      // Toggle. Opening needs the click's user gesture to still count, so it's the first call made.
      const port = traceOpen.get(tab?.windowId);
      if (port) {
        port.postMessage({ type: "close" });
        reply({ ok: true, open: false });
        return false;
      }
      chrome.sidePanel.open({ tabId: tab?.id }).then(() => reply({ ok: true, open: true }), (e) => reply({ ok: false, error: e?.message }));
      return true;
    }
    case "trace-state":
      reply({ open: traceOpen.has(tab?.windowId) });
      return false;
    case "onboarding":
      chrome.tabs.create({ url: `onboarding.html${msg.hash ? `#${msg.hash}` : ""}` }).then(() => reply({ ok: true }));
      return true;
    case "dev-reload": // watch builds only (the brain checks)
      chrome.runtime.reload();
      return false;
    case "granted": // the grant window got the permission: make Waypoint live on that tab now
      (async () => {
        await refresh();
        if (msg.tab) await chrome.scripting.executeScript({ target: { tabId: Number(msg.tab) }, files: ["content.js"] }).catch(() => {});
        reply({ ok: true });
      })();
      return true;
  }
  return false;
});

// The brain may have been closed (extension update, Chrome restart): any wake-up makes sure it exists.
ensureBrain();
