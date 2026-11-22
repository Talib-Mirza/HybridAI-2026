import "./theme.css";
import "./grant.css";

// A one-purpose window: the in-page bar can't ask Chrome for permissions, an extension page can.
const q = new URLSearchParams(location.search);
const origins = JSON.parse(q.get("origins") || "[]");
const tab = q.get("tab");
const $ = (id) => document.getElementById(id);

const pretty = (o) => (o === "<all_urls>" || o === "https://*/*" ? "Every site you visit" : o.replace(/^https?:\/\//, "").replace(/\/\*$/, ""));
$("why").textContent = q.get("text") || "Let Waypoint read this site so it can guide you here.";
$("title").textContent = origins.includes("<all_urls>") ? "Allow Waypoint everywhere" : "Allow Waypoint on this site";
for (const o of origins) {
  const li = document.createElement("li");
  li.textContent = pretty(o);
  $("sites").appendChild(li);
}
$("allow").addEventListener("click", () => {
  chrome.permissions.request({ origins }).then(async (ok) => {
    if (!ok) return;
    await chrome.runtime.sendMessage({ to: "sw", type: "granted", tab }).catch(() => {});
    await chrome.runtime.sendMessage({ to: "brain", type: "brain:granted", origins }).catch(() => {});
    window.close();
  });
});
$("cancel").addEventListener("click", () => window.close());
