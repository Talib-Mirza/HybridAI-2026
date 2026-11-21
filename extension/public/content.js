// Waypoint content script: runs on the Firebase console (built in) and on any site the user allows.
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

  // The current project/workspace id, from the common URL shapes: /project/<id> (Firebase) and
  // ?project=<id> (Google Cloud and many others). It and its display variants are redacted everywhere.
  function projectId() {
    const m =
      location.pathname.match(/\/projects?\/([^/]+)/) ||
      location.search.match(/[?&](?:project|projectId|org|organization|workspace)=([^&#]+)/i);
    return m ? decodeURIComponent(m[1]) : null;
  }
  // Same form as outline.path, so the panel can tell whether the user is still on the same page.
  const pagePath = () => redact(location.pathname + location.hash);
  const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Redaction: everything that leaves the device passes through this. Values are never read at all.
  function redact(s) {
    if (!s) return s;
    const pid = projectId();
    if (pid && pid.length > 2) s = s.replace(new RegExp(escapeRe(pid), "gi"), "[project]");
    return s
      // A person's name shown next to their email ("Jane Doe (jane@x.com)", account menus).
      .replace(/[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){0,3}\s*\(\s*[\w.+-]+@[\w-]+\.[\w.-]+\s*\)/gu, "[name] ([email])")
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

  // Keyboard-shortcut hints in labels ("Navigation menu (.)", "Chat (Option G)") aren't part of the name.
  const stripShortcut = (t) =>
    t.replace(/\s*\((?:[^\w\s()]{1,3}|(?:ctrl|cmd|command|option|alt|shift|⌘|⌥)[^()]{0,20}|[a-z]\s*then\s*[a-z])\)\s*$/i, "").trim() || t;

  function labelOf(el) {
    return stripShortcut(rawLabelOf(el));
  }

  function rawLabelOf(el) {
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

  /** Inside the page's main region (<main> / role=main), across shadow-DOM boundaries? */
  function inMain(el) {
    for (let n = el; n; n = parentOf(n)) if (n.matches?.("main,[role=main]")) return true;
    return false;
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
      let expander = visible || hiddenCount >= 80 ? null : expanderFor(el);
      if (expander && !labelOf(expander)) expander = null; // an unnamed toggle can't be pointed out to the user
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
        main: inMain(el),
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

  /**
   * What the page says around a control, for explaining it: its tooltip/description, and the nearest
   * surrounding text (form hint, row cells, card copy). Redacted; only ever sent to on-device Nano.
   */
  function describeEl(el) {
    const label = labelOf(el);
    const ids = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    const described = ids.map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(" ");
    const hint = [described, el.getAttribute("aria-description"), el.getAttribute("title"), el.getAttribute("mattooltip"), el.getAttribute("data-tooltip")]
      .filter((t) => t && t !== label)
      .join(" · ");
    let nearby = "";
    let n = el;
    for (let k = 0; k < 5 && n; k++) {
      n = parentOf(n);
      if (!n || n === document.body) break;
      const t = textOf(n);
      if (t.length > label.length + 25) {
        nearby = t.length > 2000 ? "" : t; // a whole page section says nothing specific
        break;
      }
    }
    if (nearby && label) nearby = nearby.split(label).join(" ").replace(/\s+/g, " ").trim();
    return { hint: redact(hint).slice(0, 200), nearby: redact(nearby).slice(0, 320) };
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
      :host{all:initial}
      .ring{position:fixed;border:2px solid #4f7cff;border-radius:8px;box-shadow:0 0 0 9999px rgba(10,16,34,.28),0 0 0 4px rgba(79,124,255,.35);transition:left .18s ease,top .18s ease,width .18s ease,height .18s ease,opacity .15s;display:none}
      .bubble{position:fixed;max-width:320px;background:#111a33;color:#f4f6ff;font:13px/1.45 system-ui,-apple-system,sans-serif;padding:12px 14px 10px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:auto;display:none;animation:in .16s ease-out}
      .bubble .step{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#9fb3ff;margin-bottom:4px;padding-right:18px}
      .bubble .why{color:#c9d2f0;font-size:12px;margin-top:6px}
      .bubble .why:empty,.bubble .text:empty{display:none}
      .bubble .src{color:#7f8bb0;font-size:10.5px;margin-top:8px}
      .bubble .src:empty{display:none}
      .bubble.explain{max-width:340px}
      .bubble .title{font-weight:650;font-size:14px;margin-bottom:4px;padding-right:18px}
      .bubble .title:empty{display:none}
      .bubble.streaming .text::after{content:"";display:inline-block;width:7px;height:14px;margin-left:2px;vertical-align:-2px;background:#9fb3ff;border-radius:1px;animation:blink 1s steps(1) infinite}
      .bubble .loading{display:none;align-items:center;gap:8px;color:#c9d2f0;font-size:12.5px}
      .bubble.loading .loading{display:flex}
      .bubble.loading .text{display:none}
      .spinner{width:14px;height:14px;border-radius:50%;border:2px solid rgba(159,179,255,.3);border-top-color:#9fb3ff;animation:spin .8s linear infinite;flex:none}
      .bubble .nav{display:none;align-items:center;gap:6px;margin-top:12px}
      .bubble.explain .nav{display:flex}
      .bubble .nav .back[hidden]{visibility:hidden;display:inline-block}
      .bubble .nav .next{margin-left:auto}
      @keyframes blink{50%{opacity:0}}
      @keyframes spin{to{transform:rotate(360deg)}}
      .bubble .scroll{display:none;margin-top:10px;padding:8px 10px;align-items:center;gap:10px;color:#ffd78a;font-size:14px;font-weight:600;background:rgba(255,215,138,.1);border-radius:8px}
      .bubble.away .scroll{display:flex}
      .scroll-icon{flex:none;width:22px;height:22px;animation:nudge 1.1s ease-in-out infinite}
      .bubble.up .scroll-icon{transform:rotate(180deg);animation-name:nudge-up}
      .scroll .btn{margin-left:auto}
      @keyframes nudge{0%,100%{translate:0 -2px}50%{translate:0 3px}}
      @keyframes nudge-up{0%,100%{translate:0 2px}50%{translate:0 -3px}}
      .x{position:absolute;top:6px;right:8px;cursor:pointer;color:#9fb3ff;font-size:14px;background:none;border:0;padding:2px 4px;border-radius:4px}
      .x:hover,.x:focus-visible{background:rgba(159,179,255,.15);outline:none}
      .btn{font:600 12px system-ui,-apple-system,sans-serif;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;background:#4f7cff;color:#fff}
      .btn.ghost{background:transparent;color:#9fb3ff;padding:4px 6px}
      .btn:focus-visible{outline:2px solid #9fb3ff;outline-offset:2px}
      .arrow{position:absolute;width:12px;height:12px;background:#111a33;transform:rotate(45deg)}
      .pill{position:fixed;bottom:16px;right:16px;display:none;align-items:center;gap:8px;background:#111a33;color:#f4f6ff;font:12.5px/1.3 system-ui,-apple-system,sans-serif;padding:8px 10px 8px 12px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.3);pointer-events:auto}
      .pill.busy{animation:in .18s ease-out .3s both}
      .pill .dot{width:8px;height:8px;border-radius:50%;background:#4f7cff;animation:pulse 1s ease-in-out infinite}
      .pill:not(.busy) .dot{display:none}
      .pill .acts{display:none;gap:2px}
      .pill.paused .acts{display:flex}
      .pill.done .dot{display:block;background:#3ccf8e;animation:none}
      @keyframes in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
      @keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
      @media (prefers-reduced-motion:reduce){.ring,.bubble,.pill,.pill .dot,.scroll-icon,.spinner,.bubble.streaming .text::after{transition:none;animation:none}}
    </style>
    <div class="ring"></div>
    <div class="bubble" role="dialog" aria-label="Waypoint guide">
      <button class="x" title="Pause the guide" aria-label="Pause the guide">×</button>
      <div class="step"></div><div class="title"></div><div class="text"></div>
      <div class="loading"><span class="spinner"></span><span class="loading-text"></span></div>
      <div class="why"></div>
      <div class="scroll">
        <svg class="scroll-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="7" y="1.5" width="10" height="14" rx="5"/><path d="M12 5v3"/><path d="m8.5 18.5 3.5 3 3.5-3"/>
        </svg>
        <span class="scroll-text"></span><button class="btn show-me">Show me</button></div>
      <div class="nav"><button class="btn ghost back">← Back</button><button class="btn next">Next →</button></div>
      <div class="src"></div><div class="arrow"></div>
    </div>
    <div class="pill" role="status" aria-live="polite"><span class="dot"></span><span class="pill-text"></span>
      <span class="acts"><button class="btn resume">Resume</button><button class="btn ghost end">End</button></span></div>`;
  document.documentElement.appendChild(host);
  const $s = (sel) => shadow.querySelector(sel);

  // Clicks on the bubble or chip are ours: keep them from reaching the page, or the page treats them
  // as a click outside its open drawer or menu and closes it (pausing used to close Google Cloud's
  // navigation drawer). Pressing our buttons also mustn't move focus away from the page.
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "touchstart", "touchend"]) {
    host.addEventListener(type, (e) => {
      if (type === "pointerdown" || type === "mousedown") e.preventDefault();
      e.stopPropagation();
    });
  }
  const ring = $s(".ring");
  const bubble = $s(".bubble");
  const arrow = $s(".arrow");
  const pillEl = $s(".pill");

  let target = null;
  let bubbleMode = "guide"; // "guide": clicking the target is the step; "explain": Back/Next drive the tour
  let raf = 0;
  let scrollers = []; // the target's scrollable ancestors (they clip it)
  let lostSince = 0;

  // (Re)enter the top layer last, i.e. above any popover or dialog the page has opened.
  function raise() {
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {}
  }
  const anyVisible = () => ring.style.display === "block" || pillEl.style.display === "flex";
  function lower() {
    if (anyVisible()) return;
    try { host.hidePopover(); } catch {}
  }
  // The page opened a popover or dialog after us: go back on top while anything of ours is showing.
  document.addEventListener(
    "toggle",
    (e) => {
      if (anyVisible() && e.target !== host && e.newState === "open") raise();
    },
    true
  );

  // ---- status chip: "Finding the way…", "Guide paused [Resume] [End]", "You're there" ----
  let pillTimer = 0;
  function pill(mode, text = "") {
    clearTimeout(pillTimer);
    if (!mode) {
      pillEl.style.display = "none";
      lower();
      return;
    }
    pillEl.className = `pill ${mode}`;
    $s(".pill-text").textContent = text;
    pillEl.style.display = "flex";
    raise();
    if (mode === "done") pillTimer = setTimeout(() => pill(null), 2600);
  }
  $s(".resume").addEventListener("click", () => {
    pill(null);
    safeSend({ type: "resume" });
  });
  $s(".end").addEventListener("click", () => {
    pill(null);
    safeSend({ type: "end" });
  });

  $s(".next").addEventListener("click", () => safeSend({ type: "explain-next" }));
  $s(".back").addEventListener("click", () => safeSend({ type: "explain-back" }));

  // × pauses rather than ends: the guide can be resumed from the chip or the side panel.
  $s(".x").addEventListener("click", () => {
    const wasExplain = bubbleMode === "explain";
    hide();
    pill("paused", wasExplain ? "Tour paused" : "Guide paused");
    safeSend({ type: "overlay-paused" });
  });
  $s(".show-me").addEventListener("click", () => target && target.scrollIntoView({ block: "center", behavior: "smooth" }));

  // Elements that escape their ancestors' clipping: top-layer popovers/dialogs and position:fixed boxes
  // (e.g. a flyout menu that lives inside a scrolling sidebar in the DOM but is drawn over the page).
  const escapesClip = (n) =>
    n.matches?.(":popover-open, dialog:modal") || getComputedStyle(n).position === "fixed";

  function scrollParents(el) {
    const out = [];
    if (escapesClip(el)) return out;
    for (let n = parentOf(el); n && n !== document.body && n !== document.documentElement; n = parentOf(n)) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowY + cs.overflowX)) out.push(n);
      if (escapesClip(n)) break; // its own scroll area still clips; its ancestors don't
    }
    return out;
  }
  /** The part of the viewport where the target can actually be seen (its scroll containers clip it). */
  function clipRect() {
    let c = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (const n of scrollers) {
      const r = n.getBoundingClientRect();
      c = { left: Math.max(c.left, r.left), top: Math.max(c.top, r.top), right: Math.min(c.right, r.right), bottom: Math.min(c.bottom, r.bottom) };
    }
    return c;
  }
  /** Does `outer` contain `inner`, across shadow-DOM boundaries? */
  function composedContains(outer, inner) {
    for (let n = inner; n; n = parentOf(n)) if (n === outer) return true;
    return false;
  }
  /**
   * Is the target drawn on top at this point, or covered (sticky footer, overlay, other panel)? Hit-test
   * in the target's own (shadow) root: at document level a shadow-DOM control only reports its outer host.
   */
  function onTop(el, x, y) {
    const root = el.getRootNode();
    const hit = (root.elementFromPoint ? root : document).elementFromPoint(x, y);
    if (!hit) return false;
    if (hit === host) return true; // our own bubble, not the page covering it
    const h = hoverOf.get(el);
    return composedContains(el, hit) || composedContains(hit, el) || (!!h && composedContains(h, hit));
  }
  function inView(el) {
    const r = el.getBoundingClientRect();
    const c = clipRect();
    const fully = r.top >= c.top - 1 && r.bottom <= c.bottom + 1 && r.left >= c.left - 1 && r.right <= c.right + 1;
    return fully && onTop(el, r.left + r.width / 2, r.top + r.height / 2);
  }

  function anchorBubble(box, prefer) {
    const r = { ...box, width: box.right - box.left }; // box is {left, top, right, bottom}
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    const below = prefer === "below" || (prefer !== "above" && r.bottom + 14 + bh < innerHeight);
    const topPx = below ? Math.min(r.bottom + 12, innerHeight - bh - 8) : Math.max(8, r.top - bh - 12);
    const leftPx = Math.min(Math.max(8, r.left + r.width / 2 - bw / 2), innerWidth - bw - 8);
    bubble.style.left = `${leftPx}px`;
    bubble.style.top = `${topPx}px`;
    const ax = Math.min(Math.max(12, r.left + r.width / 2 - leftPx - 6), bw - 24);
    Object.assign(arrow.style, below ? { top: "-6px", bottom: "", left: `${ax}px` } : { bottom: "-6px", top: "", left: `${ax}px` });
  }

  let frame = 0;
  let covered = false;
  function place() {
    raf = requestAnimationFrame(place);
    if (!target) return;
    let el = target;
    let r = el.getBoundingClientRect();
    const hh = hoverOf.get(target);
    if (hh && (r.width < 4 || r.height < 4 || !isVisible(target))) {
      el = hh;
      r = hh.getBoundingClientRect();
    }
    // The control went away (the page re-rendered, a drawer or menu closed): tell the panel so it can
    // find the step again, instead of leaving a ring on nothing.
    const gone = !target.isConnected || r.width < 2 || r.height < 2 || (!isVisible(el) && el === target);
    if (gone) {
      ring.style.opacity = "0";
      bubble.style.visibility = "hidden";
      if (!lostSince) lostSince = performance.now();
      if (performance.now() - lostSince > 350) {
        hide();
        safeSend({ type: "target-lost" });
      }
      return;
    }
    lostSince = 0;
    bubble.style.visibility = "";
    const c = clipRect();
    const vis = { left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) };
    if (++frame % 6 === 0) {
      const cx = (vis.left + vis.right) / 2, cy = (vis.top + vis.bottom) / 2;
      covered = vis.right > vis.left && vis.bottom > vis.top && !onTop(el, cx, cy);
    }
    const away = vis.right - vis.left < 4 || vis.bottom - vis.top < Math.min(8, r.height / 2) || covered;
    bubble.classList.toggle("away", away);
    if (away) {
      // Scrolled out of its container (or covered): no ring on the wrong thing; point at the
      // container's edge in the direction of the target instead.
      ring.style.opacity = "0";
      const down = r.top > (c.top + c.bottom) / 2;
      $s(".scroll-text").textContent = down ? "Scroll down to find it" : "Scroll up to find it";
      bubble.classList.toggle("up", !down);
      const edge = { left: Math.max(c.left, Math.min(r.left, c.right - r.width)), right: 0, top: down ? c.bottom : c.top, bottom: down ? c.bottom : c.top };
      edge.right = edge.left + Math.min(r.width, c.right - c.left);
      anchorBubble(edge, down ? "above" : "below");
      return;
    }
    const pad = 4;
    ring.style.opacity = "1";
    Object.assign(ring.style, {
      left: `${vis.left - pad}px`, top: `${vis.top - pad}px`,
      width: `${vis.right - vis.left + pad * 2}px`, height: `${vis.bottom - vis.top + pad * 2}px`,
    });
    anchorBubble(vis);
  }

  function show(el, { step, text, why, src, mode, title, loading, loadingText, streaming, back, next, nextLabel }) {
    target = el;
    lostSince = 0;
    covered = false;
    bubbleMode = mode === "explain" ? "explain" : "guide";
    pill(null);
    raise();
    bubble.classList.toggle("explain", bubbleMode === "explain");
    $s(".step").textContent = step || "";
    $s(".title").textContent = title || "";
    $s(".why").textContent = why || "";
    $s(".loading-text").textContent = loadingText || "Writing…";
    $s(".back").hidden = !back;
    $s(".next").textContent = nextLabel || (next ? "Next →" : "Done");
    update({ text, src, loading, streaming });
    ring.style.display = "block";
    bubble.style.display = "block";
    const vis = isVisible(el) ? el : hoverOf.get(el) || el;
    scrollers = scrollParents(vis);
    // Bring it into view inside its own scroll area too (e.g. far down a sidebar), not just the window.
    if (!inView(vis)) vis.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    cancelAnimationFrame(raf);
    place();
  }

  /** Streamed text for the bubble that's showing (explain mode). */
  function update({ text, src, loading, streaming }) {
    $s(".text").textContent = text || "";
    $s(".src").textContent = src || "";
    bubble.classList.toggle("loading", !!loading);
    bubble.classList.toggle("streaming", !!streaming);
  }

  function hide() {
    target = null;
    cancelAnimationFrame(raf);
    ring.style.display = "none";
    bubble.style.display = "none";
    lower();
  }

  // When the user clicks the highlighted control, tell the side panel so it can advance.
  document.addEventListener(
    "click",
    (e) => {
      if (target && bubbleMode === "guide" && e.composedPath().includes(target)) {
        hide(); // clicked: the step is done, so its control disappearing next is expected, not "lost"
        safeSend({ type: "target-clicked", path: pagePath() });
      }
    },
    true
  );

  // A full page load (not a re-injection from the panel): tell the panel, so a route in progress
  // continues on the new page. (Single-page apps navigate without loads; see the URL watcher below.)
  if (!window.__waypointInjected) safeSend({ type: "page-ready", path: pagePath() });

  // SPA navigation: single-page apps change views without page loads.
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
      case "describe":
        reply((msg.ids || []).map((id) => {
          const el = idToEl.get(id);
          return el ? describeEl(el) : {};
        }));
        break;
      case "update":
        update(msg);
        reply({ ok: true });
        break;
      case "pill":
        pill(msg.mode || null, msg.text || "");
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
