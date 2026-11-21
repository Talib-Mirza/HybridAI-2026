// Waypoint service worker: opens the side panel from the toolbar icon, and keeps the content script
// running on every site the user has allowed. The Firebase console is built in (manifest); any other
// site is an optional permission the user grants from the side panel, per site or for all sites, so
// Chrome shows no "read all your data on all websites" warning at install.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const BUILT_IN = "https://console.firebase.google.com/*";
const DYNAMIC_ID = "waypoint-granted-sites";

/** Register the content script for every granted origin (the built-in one has its own manifest entry). */
async function syncContentScripts() {
  const { origins = [] } = await chrome.permissions.getAll();
  const granted = origins.filter((o) => o !== BUILT_IN);
  await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_ID] }).catch(() => {});
  if (!granted.length) return;
  await chrome.scripting.registerContentScripts([
    {
      id: DYNAMIC_ID,
      matches: granted,
      excludeMatches: [BUILT_IN],
      js: ["content.js"],
      runAt: "document_idle",
      persistAcrossSessions: true,
    },
  ]);
}

/** Inject into already-open tabs we're allowed on (pages loaded before install or before the grant). */
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["https://*/*", "http://*/*"] });
  for (const tab of tabs) {
    // Without permission for the tab's origin executeScript simply fails; that's fine.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
  }
}

async function refresh() {
  await syncContentScripts().catch((e) => console.warn("[Waypoint] content script sync failed", e?.message));
  await injectIntoOpenTabs();
}

chrome.runtime.onInstalled.addListener(refresh);
chrome.runtime.onStartup.addListener(refresh);
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(() => syncContentScripts().catch(() => {}));
