// Waypoint service worker: opens the side panel from the toolbar icon and makes sure
// every open Firebase console tab has the (current) content script after install/reload.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: "https://console.firebase.google.com/*" });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (e) {
      console.warn("[Waypoint] inject failed", tab.id, e?.message);
    }
  }
}

chrome.runtime.onInstalled.addListener(injectIntoOpenTabs);
chrome.runtime.onStartup.addListener(injectIntoOpenTabs);
