// Waypoint content script (runs on console.firebase.google.com).
// 1. Builds a compact, redacted outline of the page's visible controls (no raw HTML, no values).
// 2. Draws the guidance overlay: a highlight ring + bubble anchored to one element.
// 3. Reports navigation and target clicks back to the side panel.
(() => {
  // Dev hot-reload re-injects this script into the same isolated world. Only the newest copy acts;
  // older copies' listeners see they are stale and do nothing.
  const MY_GEN = (window.__waypointGen = (window.__waypointGen || 0) + 1);
  const live = () => window.__waypointGen === MY_GEN;
  document.querySelectorAll("#waypoint-host").forEach((n) => n.remove());

  const safeSend = (msg) => {
    if (!live()) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      /* extension was reloaded; this copy is orphaned */
    }
  };

  // ---------- Outline ----------

  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=menuitemcheckbox]",
    "[role=menuitemradio]", "[role=switch]", "[role=checkbox]", "[role=radio]", "[role=option]",
    "[role=treeitem]", "[role=combobox]", "mat-slide-toggle", "mat-checkbox",
    // Whole table rows are often the click target in consoles (e.g. App Check > APIs).
    "tbody tr", "[role=row]", "mat-row",
    // Menu/section toggles, including custom elements (e.g. Firebase's <navbar-category>).
    "[aria-expanded]", "[aria-haspopup]:not([aria-haspopup=false])",
  ].join(",");
  const ROW = "tbody tr,[role=row],mat-row";
  const CELL = "td,[role=cell],[role=gridcell],[role=rowheader],mat-cell";

  let idToEl = new Map();
  const elToId = new WeakMap();
  let nextId = 1;

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  // Icon fonts render ligature words ("check_circle", "help"); they're noise to a model, so skip them.
  // Icon-font ligatures ("check_circle", "plat_web") and anything marked decorative (aria-hidden) aren't label text.
  const ICON = "mat-icon,.material-icons,.material-symbols-outlined,.google-symbols,[class*=material-icon],[class*=-icons],[data-mat-icon-name],[aria-hidden=true]";
  function textOf(el) {
    if (!el.querySelector(ICON)) return clean(el.innerText || el.textContent);
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.parentElement?.closest(ICON)) parts.push(n.nodeValue);
    }
    return clean(parts.join(" "));
  }

  function projectId() {
    const m = location.pathname.match(/\/project\/([^/]+)/);
    return m ? m[1] : null;
  }

  // Redaction: everything that leaves the device passes through this. Values are never read at all.
  function redact(s) {
    if (!s) return s;
    const pid = projectId();
    if (pid) s = s.split(pid).join("[project]");
    return s
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[api-key]")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]")
      .replace(/\b\d+:\d{6,}:[a-z]+:[0-9a-f]{6,}\b/gi, "[app-id]")
      .replace(/\b\d{6,}\b/g, "[number]")
      .replace(/\b[A-Za-z0-9_-]{28,}\b/g, "[token]");
  }

  function deepQueryAll(root, sel, out = []) {
    root.querySelectorAll(sel).forEach((e) => out.push(e));
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) deepQueryAll(el.shadowRoot, sel, out);
      if (el.tagName === "IFRAME") {
        try {
          if (el.contentDocument) deepQueryAll(el.contentDocument, sel, out);
        } catch {
          /* cross-origin frame */
        }
      }
    });
    return out;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.closest("#waypoint-host")) return false;
    if (el.closest("[aria-hidden=true],[inert]")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    return true;
  }

  // Row actions (⋮, edit, delete) are often collapsed to ~0 px or transparent until the row is hovered.
  // Such a control still counts when its row is visible; the ring sits on the row until it appears.
  const HOVER_HOST = "tbody tr,[role=row],mat-row,li,[role=listitem],[role=treeitem],mat-list-item";
  const hoverOf = new WeakMap();
  function hoverHostFor(el) {
    // No layout boxes means it (or an ancestor) is display:none, i.e. not a hover reveal.
    if (el.closest("[aria-hidden=true],[inert]") || el.getClientRects().length === 0) return null;
    const host = parentOf(el)?.closest?.(HOVER_HOST);
    return host && isVisible(host) ? host : null;
  }

  function roleOf(el) {
    const r = el.getAttribute("role");
    if (r) return r;
    if (el.matches(ROW)) return "row";
    const tag = el.tagName.toLowerCase();
    if (el.hasAttribute("aria-expanded") && !isField(el) && !["button", "a"].includes(tag)) return "menu-toggle";
    if (tag === "a") return "link";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return ["checkbox", "radio"].includes(t) ? t : t === "submit" || t === "button" ? "button" : "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "select";
    if (tag === "mat-slide-toggle") return "switch";
    if (tag === "mat-checkbox") return "checkbox";
    return tag;
  }

  function labelOf(el) {
    if (el.matches(ROW)) {
      const first = el.querySelector(CELL);
      return first ? textOf(first).slice(0, 60) : "";
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const root = el.getRootNode();
      const t = lb
        .split(/\s+/)
        .map((id) => (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id))
        .filter(Boolean)
        .map(textOf)
        .join(" ");
      if (t) return t;
    }
    if (el.labels && el.labels.length) return textOf(el.labels[0]);
    const t = textOf(el);
    if (t) return t.slice(0, 90);
    return clean(
      el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("mattooltip") ||
        el.getAttribute("data-tooltip") || el.getAttribute("name") || ""
    );
  }

  // Text fields use aria-expanded for their suggestion popups; that isn't a collapsed menu.
  const isField = (el) =>
    ["input", "textarea", "select"].includes(el.tagName.toLowerCase()) ||
    ["combobox", "searchbox", "textbox"].includes(el.getAttribute("role"));

  function stateOf(el) {
    const s = [];
    const menu = !isField(el);
    const checked = el.getAttribute("aria-checked") ?? (el.type === "checkbox" || el.type === "radio" ? String(el.checked) : null);
    if (checked != null) s.push(checked === "true" ? "on" : "off");
    if (el.getAttribute("aria-selected") === "true") s.push("selected");
    if (menu && el.getAttribute("aria-expanded") === "true") s.push("expanded");
    if (menu && el.getAttribute("aria-expanded") === "false") s.push("collapsed");
    if (el.getAttribute("aria-current")) s.push("current");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled");
    return s.join(",");
  }

  const parentOf = (n) => n.parentElement || (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);

  function contextOf(el) {
    const parts = [];
    if (el.matches(ROW)) {
      // A row's other cells carry its status, e.g. "Basic - Enforced".
      const rest = [...el.querySelectorAll(CELL)].slice(1).map(textOf).filter(Boolean).join(" · ");
      if (rest) parts.push(`row cells: ${rest.slice(0, 120)}`);
    }
    const row = el.matches(ROW) ? null : el.closest("tr,[role=row],mat-row,.mat-mdc-row");
    if (row) {
      const first = row.querySelector("td,th,[role=cell],[role=gridcell],[role=rowheader],mat-cell");
      if (first && !first.contains(el)) {
        const t = textOf(first).slice(0, 60);
        if (t) parts.push(`row "${t}"`);
      }
    }
    let n = el;
    for (let i = 0; i < 10 && n; i++) {
      n = parentOf(n);
      if (!n || n === document.body) break;
      const h = n.querySelector(
        ":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > header, :scope > [role=heading], :scope > mat-card-title, :scope > mat-toolbar"
      );
      if (h && !h.contains(el)) {
        const t = textOf(h).slice(0, 60);
        if (t) {
          parts.push(`under "${t}"`);
          break;
        }
      }
    }
    if (el.closest("[role=dialog],mat-dialog-container,.cdk-overlay-pane")) parts.push("in dialog/menu");
    if (el.closest("nav,[role=navigation]")) parts.push("navigation");
    return parts.join("; ");
  }

  // Sites that pre-render collapsed menus keep hidden items in the DOM. Find the visible collapsed
  // control (aria-expanded="false") that reveals a hidden element, if there is one.
  function expanderFor(el) {
    let n = el;
    for (let i = 0; i < 12 && n; i++) {
      n = parentOf(n);
      if (!n || n === document.body || n === document.documentElement) break;
      if (n.id) {
        const ctl = document.querySelector(`[aria-controls="${CSS.escape(n.id)}"][aria-expanded="false"]`);
        if (ctl && isVisible(ctl)) return ctl;
      }
      const prev = n.previousElementSibling;
      if (prev && prev.matches('[aria-expanded="false"]') && isVisible(prev)) return prev;
      const own = n.querySelector(':scope > [aria-expanded="false"]');
      if (own && !own.contains(el) && isVisible(own)) return own;
    }
    return null;
  }

  // "You are here": the link whose address is the longest prefix of the current path is the current
  // section (e.g. "App Check" while on .../appcheck/apps), even when the app doesn't set aria-current.
  function markCurrentSection(items) {
    const here = location.pathname.replace(/\/+$/, "");
    let best = 0;
    const scored = [];
    for (const it of items) {
      const el = idToEl.get(it.id);
      if (!el || el.tagName !== "A" || !el.href) continue;
      let u;
      try { u = new URL(el.href, location.href); } catch { continue; }
      const p = u.pathname.replace(/\/+$/, "");
      if (u.origin !== location.origin || p.length < 2 || !(here === p || here.startsWith(p + "/"))) continue;
      scored.push([it, p.length]);
      best = Math.max(best, p.length);
    }
    for (const [it, len] of scored)
      if (len === best && !it.state.includes("current")) it.state = [it.state, "current"].filter(Boolean).join(",");
  }

  function buildOutline() {
    idToEl = new Map();
    const ids = new Map();
    nextId = 1;
    const idFor = (el) => {
      let id = ids.get(el);
      if (!id) {
        id = `e${nextId++}`;
        ids.set(el, id);
        idToEl.set(id, el);
        elToId.set(el, id);
      }
      return id;
    };
    const seen = new Set();
    const items = [];
    let hiddenCount = 0;
    for (const el of deepQueryAll(document, INTERACTIVE)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const visible = isVisible(el);
      // Hidden controls count only when a visible collapsed menu reveals them, or hovering their row does.
      const expander = visible || hiddenCount >= 80 ? null : expanderFor(el);
      const hoverHost = visible || expander || hiddenCount >= 80 ? null : hoverHostFor(el);
      if (!visible && !expander && !hoverHost) continue;
      const label = labelOf(el);
      if (!label) continue;
      // Drop a control nested inside another candidate with the same label (e.g. span inside button).
      const outer = parentOf(el)?.closest?.(INTERACTIVE);
      if (outer && seen.has(outer) && labelOf(outer) === label) continue;
      const id = idFor(el);
      if (expander) {
        hiddenCount++;
        items.push({
          id,
          role: roleOf(el),
          label: redact(label),
          context: redact(`hidden inside collapsed "${labelOf(expander)}"`),
          state: "hidden",
          expander: idFor(expander),
        });
        continue;
      }
      if (hoverHost) {
        hiddenCount++;
        hoverOf.set(el, hoverHost);
        items.push({
          id,
          role: roleOf(el),
          label: redact(label),
          context: redact(contextOf(el)),
          state: [stateOf(el), "on hover"].filter(Boolean).join(","),
          hover: redact(labelOf(hoverHost)).slice(0, 60),
        });
        continue;
      }
      const r = el.getBoundingClientRect();
      items.push({
        id,
        role: roleOf(el),
        label: redact(label),
        context: redact(contextOf(el)),
        state: stateOf(el),
        offscreen: r.bottom < 0 || r.top > innerHeight,
      });
    }
    markCurrentSection(items);
    const headings = deepQueryAll(document, "h1,h2,[role=heading]")
      .filter(isVisible)
      .map(textOf)
      .filter(Boolean)
      .slice(0, 6)
      .map(redact);
    return {
      title: redact(document.title),
      path: redact(location.pathname + location.hash),
      headings,
      items,
    };
  }

  // ---------- Overlay ----------

  const host = document.createElement("div");
  host.id = "waypoint-host";
  // A manual popover, so the overlay can sit in the browser's top layer: apps that open menus and
  // dialogs as popovers / modal dialogs render them above any z-index, which hid the bubble.
  host.setAttribute("popover", "manual");
  host.style.cssText =
    "position:fixed;inset:0;width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:0;border:0;" +
    "background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      .ring{position:fixed;border:2px solid #4f7cff;border-radius:8px;box-shadow:0 0 0 9999px rgba(10,16,34,.28),0 0 0 4px rgba(79,124,255,.35);transition:all .18s ease;display:none}
      .bubble{position:fixed;max-width:320px;background:#111a33;color:#f4f6ff;font:13px/1.45 system-ui,-apple-system,sans-serif;padding:12px 14px 10px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:auto;display:none}
      .bubble .step{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#9fb3ff;margin-bottom:4px}
      .bubble .why{color:#c9d2f0;font-size:12px;margin-top:6px}
      .bubble .src{color:#7f8bb0;font-size:10.5px;margin-top:8px}
      .bubble .x{position:absolute;top:6px;right:8px;cursor:pointer;color:#9fb3ff;font-size:14px;background:none;border:0}
      .arrow{position:absolute;width:12px;height:12px;background:#111a33;transform:rotate(45deg)}
    </style>
    <div class="ring"></div>
    <div class="bubble"><button class="x" title="Close">×</button><div class="step"></div><div class="text"></div><div class="why"></div><div class="src"></div><div class="arrow"></div></div>`;
  document.documentElement.appendChild(host);
  const ring = shadow.querySelector(".ring");
  const bubble = shadow.querySelector(".bubble");
  const arrow = shadow.querySelector(".arrow");
  shadow.querySelector(".x").addEventListener("click", () => {
    hide();
    safeSend({ type: "overlay-closed" });
  });

  let target = null;
  let raf = 0;

  // (Re)enter the top layer last, i.e. above any popover or dialog the page has opened.
  function raise() {
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {}
  }
  // The page opened a popover or dialog after us: go back on top while guidance is showing.
  document.addEventListener(
    "toggle",
    (e) => {
      if (target && e.target !== host && e.newState === "open") raise();
    },
    true
  );

  function place() {
    if (!target || !target.isConnected) {
      hide();
      return;
    }
    let r = target.getBoundingClientRect();
    const host = hoverOf.get(target);
    if (host && (r.width < 4 || r.height < 4 || !isVisible(target))) r = host.getBoundingClientRect();
    const pad = 4;
    Object.assign(ring.style, {
      left: `${r.left - pad}px`, top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    const below = r.bottom + 14 + bh < innerHeight;
    const topPx = below ? r.bottom + 12 : Math.max(8, r.top - bh - 12);
    const leftPx = Math.min(Math.max(8, r.left + r.width / 2 - bw / 2), innerWidth - bw - 8);
    bubble.style.left = `${leftPx}px`;
    bubble.style.top = `${topPx}px`;
    const ax = Math.min(Math.max(12, r.left + r.width / 2 - leftPx - 6), bw - 24);
    Object.assign(arrow.style, below ? { top: "-6px", bottom: "", left: `${ax}px` } : { bottom: "-6px", top: "", left: `${ax}px` });
    raf = requestAnimationFrame(place);
  }

  function show(el, { step, text, why, src }) {
    target = el;
    raise();
    shadow.querySelector(".step").textContent = step || "";
    shadow.querySelector(".text").textContent = text || "";
    shadow.querySelector(".why").textContent = why || "";
    shadow.querySelector(".src").textContent = src || "";
    ring.style.display = "block";
    bubble.style.display = "block";
    const r = (isVisible(el) ? el : hoverOf.get(el) || el).getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) el.scrollIntoView({ block: "center", behavior: "smooth" });
    cancelAnimationFrame(raf);
    place();
  }

  function hide() {
    target = null;
    cancelAnimationFrame(raf);
    ring.style.display = "none";
    bubble.style.display = "none";
    try { host.hidePopover(); } catch {}
  }

  // When the user clicks the highlighted control, tell the side panel so it can advance.
  document.addEventListener(
    "click",
    (e) => {
      if (target && e.composedPath().includes(target)) safeSend({ type: "target-clicked" });
    },
    true
  );

  // SPA navigation: the Firebase console changes views without page loads.
  let lastHref = location.href;
  const urlTimer = setInterval(() => {
    if (!live()) return clearInterval(urlTimer);
    if (location.href !== lastHref) {
      lastHref = location.href;
      safeSend({ type: "url-changed", path: redact(location.pathname) });
    }
  }, 500);

  // Test hook: page scripts can drive Waypoint with window.postMessage({ __waypoint: "ask", q }).
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || !e.data.__waypoint) return;
    safeSend({ type: "page-command", command: e.data.__waypoint, q: e.data.q });
  });

  // ---------- Messages from the side panel ----------

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    // Message types carry a protocol prefix so copies from older builds ignore them.
    if (!live() || typeof msg?.type !== "string" || !msg.type.startsWith("w2:")) return false;
    switch (msg.type.slice(3)) {
      case "ping":
        reply({ ok: true, fresh: !!window.__waypointInjected });
        break;
      case "outline":
        reply(buildOutline());
        break;
      case "check": {
        const el = idToEl.get(msg.id);
        const host = el && hoverOf.get(el);
        reply({ ok: !!el && (isVisible(el) || (!!host && isVisible(host))) });
        break;
      }
      case "show": {
        const el = idToEl.get(msg.id);
        if (el && el.isConnected) {
          show(el, msg);
          reply({ ok: true });
        } else reply({ ok: false });
        break;
      }
      case "hide":
        hide();
        reply({ ok: true });
        break;
      case "status":
        host.dataset.status = msg.text;
        console.log(`[Waypoint] ${msg.text}`);
        reply({ ok: true });
        break;
      case "debug":
        console.log(`[Waypoint receipt] ${msg.text}`);
        reply({ ok: true });
        break;
      default:
        return false;
    }
    return false;
  });

  host.dataset.status = "ready";
})();
