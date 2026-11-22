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
  const COLHEAD = "th,[role=columnheader],mat-header-cell,.mat-mdc-header-cell";
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
      if (el.shadowRoot && el.id !== "waypoint-host") deepQueryAll(el.shadowRoot, sel, out);
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
    if (el.closest("#waypoint-host") || el.getRootNode()?.host?.id === "waypoint-host") return false; // Waypoint's own bar and pill
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

  // Screen-reader position info ("Log router, 3 of 8") isn't part of the name either.
  const stripPosition = (t) => t.replace(/,\s*\d+\s+of\s+\d+\s*$/i, "").trim() || t;

  function labelOf(el) {
    return stripPosition(stripShortcut(rawLabelOf(el)));
  }

  function rawLabelOf(el) {
    if (el.matches(ROW)) {
      const first = el.querySelector(CELL);
      return first ? textOf(first).slice(0, 60) : "";
    }
    const aria = el.getAttribute("aria-label");
    if (aria) {
      // Some sites build aria-labels from textContent, so an icon's ligature leaks in ("settingsHow do I…").
      let a = clean(aria);
      for (const ic of el.querySelectorAll(ICON)) {
        const t = (ic.textContent || "").trim();
        if (t && a.startsWith(t) && a.length > t.length) a = a.slice(t.length).trim();
      }
      return a;
    }
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
      // Something else drawn on top of it right now (e.g. page content behind an open drawer or dialog).
      const inView = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      // Centre plus four inner points (as the live check does): half under a drawer counts as covered.
      const at = (fx, fy) => onTop(el, Math.min(Math.max(r.left + r.width * fx, 1), innerWidth - 1), Math.min(Math.max(r.top + r.height * fy, 1), innerHeight - 1));
      const covered = inView && (!at(0.5, 0.5) || [[0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7]].filter(([fx, fy]) => !at(fx, fy)).length >= 2);
      items.push({
        id,
        role: roleOf(el),
        label: redact(label),
        context: redact(contextOf(el)),
        state: [stateOf(el), covered ? "covered" : ""].filter(Boolean).join(","),
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

  // ---------- Docs links ----------
  // The page's own pointers to documentation ("Learn more", "View docs", links into /docs/…): the most
  // reliable way to find the right docs for what's on screen, on any site.
  const DOC_TEXT = /\b(learn more|read more|docs?|documentation|guide|reference|help (center|article))\b/i;
  const DOC_HREF = /\/(docs?|documentation|guides?|reference|help|support|kb)\/|^https?:\/\/(docs|developers?|support|help|learn)\./i;
  function docHref(a) {
    const raw = a.getAttribute("href");
    if (!raw || /^(javascript:|mailto:|#)/i.test(raw)) return null;
    let u;
    try { u = new URL(raw, location.href); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const text = `${a.textContent || ""} ${a.getAttribute("aria-label") || ""}`;
    if (!DOC_TEXT.test(text) && !DOC_HREF.test(u.href)) return null;
    if (u.origin === location.origin && !DOC_HREF.test(u.href)) return null; // an in-app link, not docs
    return `${u.origin}${u.pathname}`;
  }
  /** Docs links on the page: main content first, then the rest; deduplicated. */
  function pageDocLinks() {
    const out = new Map();
    const anchors = deepQueryAll(document, "a[href]");
    for (const pass of [true, false])
      for (const a of anchors) {
        if (inMain(a) !== pass) continue;
        const h = docHref(a);
        if (h && !out.has(h)) out.set(h, clean(a.textContent || a.getAttribute("aria-label") || "").slice(0, 80));
      }
    return [...out].slice(0, 8).map(([href, text]) => ({ href, text }));
  }
  /** The docs link closest to a control (in its row, card or section), if any. */
  function nearDocLink(el) {
    let n = el;
    for (let k = 0; k < 6 && n; k++) {
      n = parentOf(n);
      if (!n || n === document.body) break;
      for (const a of n.querySelectorAll?.("a[href]") || []) {
        const h = docHref(a);
        if (h) return h;
      }
    }
    return null;
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
    return { hint: redact(hint).slice(0, 200), nearby: redact(nearby).slice(0, 320), docHref: nearDocLink(el) };
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
      /* Waypoint theme: wayfinding signage. Ink surfaces, amber = "here / go", green = on this device,
         blue = cloud. Condensed signage face for the wordmark, IBM Plex for reading. */
      :host{--ink0:#0c110f;--ink1:#121916;--ink2:#1a2420;--ink3:#22302a;--line:#2b3833;--text:#edf2ec;--muted:#8fa39a;--signal:#ffb224;--signal-ink:#1f1500;--device:#3ddc97;--cloud:#74b7ff;--danger:#ff6f59;--sans:"WP Sans",system-ui,-apple-system,sans-serif;--mono:"WP Mono",ui-monospace,monospace;--display:"WP Display","Arial Narrow",sans-serif}
      *{box-sizing:border-box}
      button{font:inherit;color:inherit}
      /* ---- guide ring + bubble ---- */
      .ring{position:fixed;border:2px solid var(--signal);border-radius:9px;box-shadow:0 0 0 9999px rgba(8,12,10,.32),0 0 0 5px rgba(255,178,36,.28);transition:left .18s ease,top .18s ease,width .18s ease,height .18s ease,opacity .15s;display:none}
      .ring::after{content:"";position:absolute;inset:-7px;border:1px dashed rgba(255,178,36,.55);border-radius:12px}
      .bubble{position:fixed;max-width:330px;background:var(--ink1);color:var(--text);font:13.5px/1.5 var(--sans);padding:13px 15px 11px;border:1px solid var(--line);border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.45);pointer-events:auto;display:none;animation:in .16s ease-out}
      .bubble .step{font:500 10.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--signal);margin-bottom:7px;padding-right:20px;display:flex;align-items:center;gap:6px}
      .bubble .step::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--signal);box-shadow:0 0 0 3px rgba(255,178,36,.22)}
      .bubble .why{color:#b9c6bf;font-size:12.5px;margin-top:6px}
      .bubble .why:empty,.bubble .text:empty{display:none}
      .bubble .src{color:var(--muted);font:10.5px/1.3 var(--mono)}
      .bubble .src:empty{display:none}
      .bubble .doc{color:var(--signal);font:500 11px var(--mono);margin-left:auto;text-decoration:none;border-bottom:1px dotted var(--signal)}
      .bubble .doc:hover{filter:brightness(1.15)}
      .bubble .doc[hidden]{display:none}
      .bubble .foot{display:flex;align-items:baseline;gap:10px;margin-top:10px}
      .bubble .foot:has(.src:empty):has(.doc[hidden]){display:none}
      .bubble.explain{max-width:350px}
      .bubble .title{font:600 15px/1.3 var(--sans);margin-bottom:5px;padding-right:20px}
      .bubble .title:empty{display:none}
      .bubble.streaming .text::after{content:"";display:inline-block;width:7px;height:14px;margin-left:2px;vertical-align:-2px;background:var(--device);border-radius:1px;animation:blink 1s steps(1) infinite}
      .bubble .loading{display:none;align-items:center;gap:9px;color:#b9c6bf;font-size:12.5px}
      .bubble.loading .loading{display:flex}
      .bubble.loading .text{display:none}
      .spinner{width:14px;height:14px;border-radius:50%;border:2px solid rgba(61,220,151,.25);border-top-color:var(--device);animation:spin .8s linear infinite;flex:none}
      .bubble .nav{display:none;align-items:center;gap:6px;margin-top:12px}
      .bubble.explain .nav{display:flex}
      .bubble .nav .back[hidden]{visibility:hidden;display:inline-block}
      .bubble .nav .next{margin-left:auto}
      .bubble.nonav .nav{display:none}
      .bubble .scroll{display:none;margin-top:10px;padding:8px 10px;align-items:center;gap:10px;color:var(--signal);font:600 14px var(--sans);background:rgba(255,178,36,.1);border-radius:8px}
      .bubble.away .scroll,.bubble.covered .scroll{display:flex}
      .bubble.covered .scroll-icon,.bubble.covered .show-me{display:none}
      .ring.covered{border-style:dashed;opacity:.75}
      .scroll-icon{flex:none;width:22px;height:22px;animation:nudge 1.1s ease-in-out infinite}
      .bubble.up .scroll-icon{transform:rotate(180deg);animation-name:nudge-up}
      .scroll .btn{margin-left:auto}
      .x{position:absolute;top:7px;right:8px;cursor:pointer;color:var(--muted);font-size:15px;line-height:1;background:none;border:0;padding:3px 5px;border-radius:5px}
      .x:hover,.x:focus-visible{background:var(--ink3);color:var(--text);outline:none}
      .btn{font:600 12.5px var(--sans);border:0;border-radius:7px;padding:5px 11px;cursor:pointer;background:var(--signal);color:var(--signal-ink)}
      .btn:hover{filter:brightness(1.07)}
      .btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
      .btn:focus-visible,.tool:focus-visible,.icon:focus-visible,.site:focus-visible,.nano:focus-visible,.go:focus-visible{outline:2px solid var(--signal);outline-offset:2px}
      .arrow{position:absolute;width:12px;height:12px;background:var(--ink1);border-left:1px solid var(--line);border-top:1px solid var(--line);transform:rotate(45deg)}
      .arrow[style*="bottom"]{border:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
      .arrow[style*="left: -6px"]{border:0;border-left:1px solid var(--line);border-bottom:1px solid var(--line)}
      .arrow[style*="right: -6px"]{border:0;border-right:1px solid var(--line);border-top:1px solid var(--line)}
      /* ---- status chip (bottom right) ---- */
      .pill{position:fixed;bottom:16px;right:16px;display:none;align-items:center;gap:9px;background:var(--ink1);color:var(--text);font:12.5px/1.3 var(--sans);padding:8px 10px 8px 12px;border:1px solid var(--line);border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:auto}
      .pill.busy{animation:in .18s ease-out .3s both}
      .pill .dot{width:8px;height:8px;border-radius:50%;background:var(--signal);animation:pulse 1s ease-in-out infinite}
      .pill:not(.busy) .dot{display:none}
      .pill .acts{display:none;gap:4px}
      .pill.paused .acts{display:flex}
      .pill.done .dot{display:block;background:var(--device);animation:none}
      .pill.pick .dot{display:block;background:var(--device);animation:none}
      @keyframes in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
      @keyframes drop{from{opacity:0;transform:translate(-50%,-10px) scale(.985)}to{opacity:1;transform:translate(-50%,0)}}
      @keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
      @keyframes blink{50%{opacity:0}}
      @keyframes spin{to{transform:rotate(360deg)}}
      @keyframes nudge{0%,100%{translate:0 -2px}50%{translate:0 3px}}
      @keyframes nudge-up{0%,100%{translate:0 2px}50%{translate:0 -3px}}
      /* ---- picker: green, because what you pick stays on this device ---- */
      .ring.pick{border-color:var(--device);box-shadow:0 0 0 9999px rgba(8,12,10,.2),0 0 0 5px rgba(61,220,151,.25)}
      .ring.pick::after{border-color:rgba(61,220,151,.5)}
      .pick{position:fixed;display:none;border:2px solid var(--device);background:rgba(61,220,151,.1);border-radius:7px;box-shadow:0 0 0 1px rgba(0,0,0,.25);transition:left .1s ease,top .1s ease,width .1s ease,height .1s ease;pointer-events:none}
      .pick.pinned{background:rgba(61,220,151,.04);box-shadow:0 0 0 5px rgba(61,220,151,.22)}
      .pick-tag{position:fixed;display:none;align-items:center;gap:7px;max-width:380px;background:var(--ink0);color:var(--text);font:500 12px/1.25 var(--sans);padding:5px 6px 5px 8px;border:1px solid rgba(61,220,151,.45);border-radius:7px;box-shadow:0 6px 18px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap}
      .pick-tag .kind{color:var(--device);text-transform:uppercase;font:500 10px var(--mono);letter-spacing:.08em;flex:none}
      .pick-tag .name{overflow:hidden;text-overflow:ellipsis}
      .pick-tag .eye{flex:none;color:var(--signal);font-size:11px}
      .pick-tag .unpin{display:none;flex:none;background:none;border:0;color:var(--muted);cursor:pointer;font:15px/1 var(--sans);padding:0 3px;border-radius:4px}
      .bubble .text,.bubble .title,.bubble .why{user-select:text;-webkit-user-select:text;cursor:text}
      .bubble ::selection{background:rgba(255,178,36,.35);color:var(--text)}
      .pick-tag .pstate{flex:none;font:500 10.5px var(--mono);color:var(--muted)}
      .pick-tag.is-pinned{border-color:var(--signal)} .pick-tag.is-pinned .pstate{color:var(--signal)}
      .pin{position:fixed;border:2px solid var(--device);background:rgba(61,220,151,.06);border-radius:7px;box-shadow:0 0 0 4px rgba(61,220,151,.16);pointer-events:none}
      .pin-tag{position:fixed;display:flex;align-items:center;gap:6px;max-width:300px;background:var(--ink0);color:var(--text);font:500 12px/1.25 var(--sans);padding:3px 3px 3px 3px;border:1px solid rgba(61,220,151,.45);border-radius:7px;box-shadow:0 6px 18px rgba(0,0,0,.35);pointer-events:auto;white-space:nowrap}
      .pin-n{min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:5px;background:var(--device);color:#04140c;font:700 11px/18px var(--mono);text-align:center;flex:none}
      .pin-tag .kind{color:var(--device);text-transform:uppercase;font:500 10px var(--mono);letter-spacing:.08em;flex:none}
      .pin-tag .name{overflow:hidden;text-overflow:ellipsis;min-width:0}
      .pin-tag .unpin{flex:none;background:none;border:0;color:var(--muted);cursor:pointer;font:15px/1 var(--sans);padding:0 4px;border-radius:4px}
      .pin-tag .unpin:hover,.pin-tag .unpin:focus-visible{background:var(--ink3);color:var(--text);outline:none}
      .pin-tag.compact{padding:2px;gap:5px;border-radius:7px}
      .pin-tag.compact .kind,.pin-tag.compact .name,.pin-tag.compact .unpin{display:none}
      .pin-tag.compact:hover,.pin-tag.compact:focus-within{padding:2px 2px 2px 2px;z-index:2}
      .pin-tag.compact:hover .kind,.pin-tag.compact:hover .name,.pin-tag.compact:focus-within .kind,.pin-tag.compact:focus-within .name{display:inline}
      .pin-tag.compact:hover .unpin,.pin-tag.compact:focus-within .unpin{display:inline-block}
      .mark{position:fixed;border:1.5px dashed rgba(255,178,36,.42);border-radius:7px;pointer-events:none;transition:opacity .2s}
      .mark-n{position:fixed;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:var(--ink0);border:1px solid rgba(255,178,36,.7);color:var(--signal);font:700 10.5px/16px var(--mono);text-align:center;pointer-events:none}
      .mini.idle .mini-o{border-color:var(--device)} .mini.idle .mini-o::after{background:var(--device)}
      .mini.idle .pause,.mini.idle .end{display:none}
      .mini .dismiss{display:none;min-width:24px;padding:0 6px;color:var(--muted)}
      .mini.idle .dismiss{display:inline-block}
      .pin.hot{border-color:var(--signal);box-shadow:0 0 0 4px rgba(255,178,36,.22)}
      .pickbar{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:none;align-items:center;gap:8px;max-width:calc(100vw - 24px);background:var(--ink1);color:var(--text);border:1px solid rgba(61,220,151,.55);border-radius:999px;padding:5px 6px 5px 12px;font:13px/1.3 var(--sans);box-shadow:0 10px 30px rgba(0,0,0,.4);pointer-events:auto;animation:drop .16s ease-out}
      .pickbar.open{display:flex}
      .pickbar .pb-dot{width:9px;height:9px;border-radius:50%;background:var(--device);flex:none;animation:pulse 1.2s ease-in-out infinite}
      .pickbar .pb-count{font:600 12px var(--mono);color:var(--device);flex:none}
      .pickbar .pb-hint{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
      .pickbar button{height:28px;padding:0 11px;border-radius:999px;border:1px solid var(--line);background:none;color:var(--text);cursor:pointer;font:500 12px var(--sans);flex:none}
      .pickbar button:hover{background:var(--ink3)}
      .pickbar .pb-done{background:var(--device);border-color:var(--device);color:#04140c;font-weight:600}
      .pickbar .pb-done:hover{background:var(--device);filter:brightness(1.08)}
      .pickbar.full{border-color:var(--signal)} .pickbar.full .pb-count{color:var(--signal)}
      .ring.multi{box-shadow:0 0 0 5px rgba(61,220,151,.25)}
      .pick-tag.pinned .unpin{display:inline}
      .pick-tag .unpin:hover,.pick-tag .unpin:focus-visible{background:var(--ink3);color:var(--text);outline:none}
      /* ---- the command bar ---- */
      .bar{position:fixed;top:16px;left:50%;transform:translateX(-50%);width:min(680px,calc(100vw - 32px));display:none;flex-direction:column;gap:12px;background:var(--ink1);color:var(--text);font:14px/1.45 var(--sans);border:1px solid var(--line);border-radius:16px;padding:14px 16px 14px;box-shadow:0 24px 70px rgba(0,0,0,.5),0 0 0 1px rgba(0,0,0,.4);pointer-events:auto;animation:drop .18s cubic-bezier(.2,.8,.2,1)}
      .bar.open{display:flex}
      .bar::before{content:"";position:absolute;left:18px;right:18px;top:0;height:2px;background:repeating-linear-gradient(90deg,var(--signal) 0 10px,transparent 10px 18px);border-radius:2px;opacity:.9}
      .bar-head{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px}
      .wordmark{font:800 24px/1 var(--display);letter-spacing:.2em;display:inline-flex;align-items:center;justify-self:center;color:var(--text);user-select:none;padding-left:.2em}
      .wordmark .o{width:.74em;height:.74em;position:relative;margin:0 .07em 0 .03em;display:inline-block}
      .wordmark .o::before{content:"";position:absolute;inset:0;border:.13em solid var(--signal);border-radius:50%}
      .wordmark .o::after{content:"";position:absolute;inset:33%;background:var(--signal);border-radius:50%}
      .nano{justify-self:start;display:inline-flex;align-items:center;gap:7px;background:none;border:1px solid transparent;border-radius:999px;padding:4px 9px 4px 7px;font:500 11.5px var(--mono);color:var(--muted);cursor:pointer;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
      .nano:hover{border-color:var(--line);color:var(--text)}
      .nano .dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--muted)}
      .nano.ready .dot{background:var(--device);box-shadow:0 0 0 3px rgba(61,220,151,.18)}
      .nano.warn{color:var(--signal)} .nano.warn .dot{background:var(--signal)}
      .head-right{justify-self:end;display:flex;align-items:center;gap:4px}
      .site{display:inline-flex;align-items:center;gap:8px;background:none;border:1px solid var(--line);border-radius:999px;padding:3px 4px 3px 10px;font:500 11.5px var(--mono);color:var(--muted);cursor:pointer;max-width:200px}
      .site .site-host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .site .sw{width:28px;height:16px;border-radius:999px;background:var(--ink3);position:relative;flex:none;transition:background .15s}
      .site .knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--muted);transition:transform .15s,background .15s}
      .site[aria-checked="true"]{color:var(--text)}
      .site[aria-checked="true"] .sw{background:rgba(61,220,151,.3)}
      .site[aria-checked="true"] .knob{transform:translateX(12px);background:var(--device)}
      .icon{width:30px;height:30px;display:inline-grid;place-items:center;background:none;border:0;border-radius:8px;color:var(--muted);cursor:pointer}
      .icon:hover,.icon[aria-expanded="true"]{background:var(--ink3);color:var(--text)}
      .icon svg{width:17px;height:17px}
      .menu{display:none;flex-direction:column;gap:2px;background:var(--ink0);border:1px solid var(--line);border-radius:12px;padding:6px}
      .menu.open{display:flex}
      .menu .row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:none;border:0;text-align:left;cursor:pointer;color:var(--text);font:13px var(--sans)}
      .menu .row:hover{background:var(--ink2)}
      .menu .row .hint{margin-left:auto;color:var(--muted);font:11px var(--mono)}
      .menu .row .sw{margin-left:auto;width:28px;height:16px;border-radius:999px;background:var(--ink3);position:relative;flex:none}
      .menu .row .knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--muted);transition:transform .15s}
      .menu .row[aria-checked="true"] .sw{background:rgba(255,178,36,.3)}
      .menu .row[aria-checked="true"] .knob{transform:translateX(12px);background:var(--signal)}
      .menu .keys{display:flex;flex-wrap:wrap;gap:10px 16px;padding:8px 10px 4px;color:var(--muted);font-size:12px}
      .kbd{font:500 10.5px var(--mono);padding:2px 5px;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;color:var(--text);background:var(--ink2);margin-right:4px}
      .grantbar{display:none;align-items:center;gap:10px;padding:9px 10px 9px 12px;border-radius:10px;background:rgba(255,178,36,.1);border:1px solid rgba(255,178,36,.35);font-size:12.5px}
      .grantbar.open{display:flex}
      .grantbar .grant-text{flex:1}
      .tray{display:none;flex-wrap:wrap;align-items:center;gap:6px}
      .tray.open{display:flex}
      .tchip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 3px 3px 3px;border:1px solid rgba(61,220,151,.45);background:rgba(61,220,151,.07);border-radius:8px;min-width:0}
      .tray.one .tchip{flex:1;padding:5px 4px 5px 5px}
      .tchip .kind{font:500 10px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--device);flex:none}
      .tchip .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:220px}
      .tray.one .tchip .name{max-width:none;flex:1}
      .tchip .eye{font:10.5px var(--mono);color:var(--signal);flex:none}
      .tchip .tx{background:none;border:0;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;padding:0 4px;border-radius:5px;flex:none}
      .tchip .tx:hover{background:var(--ink3);color:var(--text)}
      .tray .tact{height:26px;padding:0 10px;border-radius:8px;border:1px dashed var(--line);background:none;color:var(--muted);cursor:pointer;font:500 12px var(--sans)}
      .tray .tact:hover{color:var(--text);border-color:var(--muted)}
      .field{position:relative}
      .q{width:100%;min-height:88px;max-height:240px;resize:none;background:var(--ink2);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:14px 16px;font:17px/1.45 var(--sans);outline:none;transition:border-color .15s,box-shadow .15s}
      .q::placeholder{color:#6f8178}
      .q:focus{border-color:var(--signal);box-shadow:0 0 0 4px rgba(255,178,36,.14)}
      .tools{display:flex;align-items:center;gap:6px}
      .tool{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;border-radius:9px;background:none;border:1px solid var(--line);color:var(--text);cursor:pointer;font:500 12.5px var(--sans)}
      .tool svg{width:16px;height:16px;flex:none}
      .tool:hover{border-color:#47574f;background:var(--ink2)}
      .tool.trace-btn[aria-pressed="true"]{background:rgba(255,178,36,.12);border-color:var(--signal);color:var(--signal)}
      .tool.pick-btn[aria-pressed="true"]{background:rgba(61,220,151,.16);border-color:var(--device);color:var(--device)}
      .tool.cloud-btn[aria-pressed="true"]{background:rgba(116,183,255,.14);border-color:var(--cloud);color:var(--cloud)}
      .spacer{flex:1}
      .go{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 16px;border:0;border-radius:10px;background:var(--signal);color:var(--signal-ink);font:700 14px var(--sans);cursor:pointer}
      .go:hover{filter:brightness(1.07)}
      .go:disabled{opacity:.45;cursor:default;filter:none}
      .go .kbd{background:rgba(0,0,0,.12);border-color:rgba(0,0,0,.2);color:var(--signal-ink);margin:0}
      .bar-foot{display:flex;flex-direction:column;gap:8px}
      .bar-foot:has(.bstatus:empty):has(.suggest:empty){display:none}
      .bstatus{color:var(--muted);font:12px var(--mono);display:flex;align-items:center;gap:8px}
      .bstatus:empty{display:none}
      .bstatus.busy::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--signal);animation:pulse 1s ease-in-out infinite;flex:none}
      .suggest{display:flex;flex-wrap:wrap;gap:6px}
      .suggest:empty{display:none}
      .suggest button{background:none;border:1px dashed #3d4c45;border-radius:999px;padding:5px 11px;color:#c3cfc8;font:12.5px var(--sans);cursor:pointer}
      .suggest button:hover{border-style:solid;border-color:var(--signal);color:var(--text)}
      /* ---- mini status (the bar folded up while Waypoint works) ---- */
      .mini{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:none;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 24px));background:var(--ink1);color:var(--text);border:1px solid var(--line);border-radius:999px;padding:5px 6px 5px 12px;font:13px/1.3 var(--sans);box-shadow:0 10px 30px rgba(0,0,0,.4);pointer-events:auto;animation:drop .16s ease-out}
      .mini.open{display:flex}
      .mini .mini-o{width:13px;height:13px;border-radius:50%;border:2.5px solid var(--signal);position:relative;flex:none}
      .mini .mini-o::after{content:"";position:absolute;inset:2px;border-radius:50%;background:var(--signal)}
      .mini.busy .mini-o{animation:pulse 1s ease-in-out infinite}
      .mini.paused .mini-o{border-color:var(--muted)} .mini.paused .mini-o::after{background:var(--muted)}
      .mini .mini-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
      .mini .mini-act{height:28px;min-width:28px;padding:0 9px;border-radius:999px;border:1px solid var(--line);background:none;color:var(--text);cursor:pointer;font:500 12px var(--sans);flex:none}
      .mini .mini-act:hover{background:var(--ink3)}
      .mini .mini-act.primary{background:var(--signal);color:var(--signal-ink);border-color:var(--signal)}
      .mini .mini-act[hidden]{display:none}
      @media (prefers-reduced-motion:reduce){.ring,.bubble,.pill,.pill .dot,.scroll-icon,.spinner,.bubble.streaming .text::after,.pick,.bar,.mini,.mini .mini-o,.bstatus.busy::before{transition:none;animation:none}}
    </style>
    <div class="marks"></div>
    <div class="ring"></div>
    <div class="pick"></div>
    <div class="pick-tag" role="status" aria-live="polite"><span class="kind"></span><span class="name"></span><span class="eye" hidden title="Gemini Nano will look at it">👁</span><span class="pstate"></span></div>
    <div class="pins"></div>
    <div class="pickbar" role="toolbar" aria-label="Picking"><span class="pb-dot"></span><span class="pb-count"></span><span class="pb-hint"></span><button class="pb-clear" type="button">Clear</button><button class="pb-done" type="button">Done</button></div>
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
      <div class="foot"><div class="src"></div><a class="doc" target="_blank" rel="noopener noreferrer" hidden>Docs ↗</a></div><div class="arrow"></div>
    </div>
    <div class="pill" role="status" aria-live="polite"><span class="dot"></span><span class="pill-text"></span>
      <span class="acts"><button class="btn resume">Resume</button><button class="btn ghost end">End</button></span></div>
    <div class="bar" role="dialog" aria-label="Waypoint">
      <div class="bar-head">
        <button class="nano" type="button" title="Gemini Nano on this device"><span class="dot"></span><span class="nano-text">Checking Nano…</span></button>
        <div class="wordmark" aria-label="Waypoint">WAYP<span class="o" aria-hidden="true"></span>INT</div>
        <div class="head-right">
          <button class="site" type="button" role="switch" aria-checked="false" title="Waypoint on this site"><span class="site-host"></span><span class="sw"><span class="knob"></span></span></button>
          <button class="icon gear" type="button" aria-label="Settings" aria-expanded="false" title="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg></button>
          <button class="icon close" type="button" aria-label="Close (Esc)" title="Close (Esc)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
      </div>
      <div class="menu" role="menu">
        <button class="row m-cloud" role="menuitemcheckbox" aria-checked="false">Cloud only <span class="sw"><span class="knob"></span></span></button>
        <button class="row m-all" role="menuitemcheckbox" aria-checked="false">On for every site <span class="sw"><span class="knob"></span></span></button>
        <button class="row m-trace" role="menuitem">Open Trace (what ran where) <span class="hint">side panel</span></button>
        <button class="row m-setup" role="menuitem">Setup &amp; Gemini Nano help <span class="hint">new tab</span></button>
        <div class="keys"><span><span class="kbd">Alt</span><span class="kbd">Shift</span><span class="kbd">W</span>open</span><span><span class="kbd">Alt</span><span class="kbd">Shift</span><span class="kbd">P</span>pick</span><span><span class="kbd">Esc</span>close</span><span><span class="kbd">↑</span><span class="kbd">↓</span>widen a pick</span></div>
      </div>
      <div class="grantbar"><span class="grant-text"></span><button class="btn grant-btn" type="button">Allow</button></div>
      <div class="tray" aria-label="Picked on the page"></div>
      <div class="field"><textarea class="q" rows="3" spellcheck="false" aria-label="What do you need?"></textarea></div>
      <div class="tools">
        <button class="tool pick-btn" type="button" aria-pressed="false" title="Pick something on the page to ask about (Alt+Shift+P)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg><span>Pick</span></button>
        <button class="tool cloud-btn" type="button" aria-pressed="false" title="Skip Gemini Nano and use cloud Gemini only"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M7 18h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.3 9.2 4.5 4.5 0 0 0 7 18z"/></svg><span>Cloud only</span></button>
        <button class="tool trace-btn" type="button" title="Open the Trace panel: every AI call, where it ran, what was sent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="6" cy="19" r="2"/><path d="M8 5h3a3 3 0 0 1 3 3v1M16 12h-2a3 3 0 0 0-3 3v1a3 3 0 0 1-3 3" stroke-dasharray="2 2.5"/></svg><span>Trace</span></button>
        <span class="spacer"></span>
        <button class="go" type="button" disabled>Go <span class="kbd">↵</span></button>
      </div>
      <div class="bar-foot"><div class="bstatus" role="status" aria-live="polite"></div><div class="suggest"></div></div>
    </div>
    <div class="mini" role="status" aria-live="polite">
      <span class="mini-o" aria-hidden="true"></span><span class="mini-text"></span>
      <button class="mini-act replan" type="button" hidden>Re-plan</button>
      <button class="mini-act pause" type="button" title="Pause">Pause</button>
      <button class="mini-act end" type="button" title="End">End</button>
      <button class="mini-act open primary" type="button" title="Open the bar (Alt+Shift+W)">Open</button>
      <button class="mini-act dismiss" type="button" title="Hide until next time" aria-label="Hide">×</button>
    </div>`;
  document.documentElement.appendChild(host);
  if (!document.getElementById("waypoint-fonts")) {
    const f = document.createElement("style");
    f.id = "waypoint-fonts";
    const url = (n) => chrome.runtime.getURL(`fonts/${n}.woff2`);
    f.textContent = [["WP Display", "display-800", 800], ["WP Display", "display-700", 700], ["WP Sans", "sans-400", 400], ["WP Sans", "sans-500", 500], ["WP Sans", "sans-600", 600], ["WP Mono", "mono-400", 400], ["WP Mono", "mono-500", 500]]
      .map(([fam, file, w]) => `@font-face{font-family:"${fam}";src:url("${url(file)}") format("woff2");font-weight:${w};font-display:swap}`)
      .join("");
    (document.head || document.documentElement).appendChild(f);
  }
  // Typing in the bar must not trigger the page's keyboard shortcuts ("/" for search, "." for menus…).
  for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (e) => e.stopPropagation());
  const $s = (sel) => shadow.querySelector(sel);

  // Clicks on the bubble or chip are ours: keep them from reaching the page, or the page treats them
  // as a click outside its open drawer or menu and closes it (pausing used to close Google Cloud's
  // navigation drawer). Pressing our buttons also mustn't move focus away from the page.
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "touchstart", "touchend"]) {
    host.addEventListener(type, (e) => {
      // Text stays selectable (answers, the question box); only our buttons skip the default, so
      // pressing them doesn't move focus off the page.
      const t = e.composedPath()[0];
      const isText = t?.closest?.(".text,.title,.why,.loading-text,.q,.bstatus,.scroll-text,textarea,input");
      if ((type === "pointerdown" || type === "mousedown") && !isText) e.preventDefault();
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
  const anyVisible = () =>
    ring.style.display === "block" || pillEl.style.display === "flex" || shadow.querySelector(".pick").style.display === "block" ||
    (!!shadow.querySelector(".pin") && pinsShown) || !!shadow.querySelector(".mark") ||
    [".pickbar", ".mini", ".bar"].some((c) => shadow.querySelector(c)?.classList.contains("open"));
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
    if (barUsed && (mode === "busy" || mode === "paused" || mode === "done")) {
      pillEl.style.display = "none";
      return miniState(mode, text);
    }
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
    if (bubbleMode === "pick") {
      hide();
      return;
    }
    const wasExplain = bubbleMode === "explain";
    hide();
    pill("paused", wasExplain ? "Tour paused" : "Guide paused");
    safeSend({ type: "overlay-paused" });
  });
  // Show me: scroll it into view; if it still can't be seen afterwards, it isn't really there any more
  // (e.g. its menu closed), so let the panel find the step again rather than leave a dead button.
  $s(".show-me").addEventListener("click", () => {
    if (!target) return;
    const el = target;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => {
      if (target === el && bubble.classList.contains("away")) {
        hide();
        safeSend({ type: "target-lost" });
      }
    }, 900);
  });

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

  // Open menus, dropdowns and dialogs on the page: the bubble must not sit on top of them (it would hide
  // the very option the user was just told to pick). Refreshed every few frames.
  let obstacles = [];
  function refreshObstacles() {
    obstacles = [];
    for (const n of document.querySelectorAll("[role=menu],[role=listbox],[role=dialog],[role=alertdialog],.cdk-overlay-pane,[popover]")) {
      if (n === host || !n.isConnected) continue;
      if (n.hasAttribute("popover") && !n.matches(":popover-open")) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 24 || r.height < 24 || !isVisible(n)) continue;
      // The control is inside it: a dialog is fine to sit in (it's usually big), but a menu or dropdown
      // still counts, so the bubble goes beside the menu instead of over its other options.
      if (target && composedContains(n, target) && !n.matches("[role=menu],[role=listbox],.cdk-overlay-pane")) continue;
      obstacles.push(r);
    }
  }
  function addOwnObstacles() {
    for (const el of [barEl, miniEl]) if (el.classList.contains("open")) obstacles.push(el.getBoundingClientRect());
    // An answer about several picks shouldn't cover the other picks it's talking about.
    if (bubbleMode === "pick") for (const p of pins) if (p.el !== target) obstacles.push(p.el.getBoundingClientRect(), p.tag.getBoundingClientRect());
  }
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  /** Place the bubble beside the box: below, above, right or left, avoiding open menus and dialogs. */
  function anchorBubble(box, prefer) {
    const r = { ...box, width: box.right - box.left, height: box.bottom - box.top }; // box: {left, top, right, bottom}
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight, gap = 12, m = 8;
    const cx = (x) => Math.min(Math.max(m, x), innerWidth - bw - m);
    const cy = (y) => Math.min(Math.max(m, y), innerHeight - bh - m);
    const sides = {
      below: { x: cx(r.left + r.width / 2 - bw / 2), y: r.bottom + gap, fits: r.bottom + gap + bh <= innerHeight - m },
      above: { x: cx(r.left + r.width / 2 - bw / 2), y: r.top - gap - bh, fits: r.top - gap - bh >= m },
      right: { x: r.right + gap, y: cy(r.top + r.height / 2 - bh / 2), fits: r.right + gap + bw <= innerWidth - m },
      left: { x: r.left - gap - bw, y: cy(r.top + r.height / 2 - bh / 2), fits: r.left - gap - bw >= m },
    };
    const order = prefer === "above" ? ["above", "below", "right", "left"] : ["below", "above", "right", "left"];
    const clear = (k) => !obstacles.some((o) => overlaps({ left: sides[k].x, top: sides[k].y, right: sides[k].x + bw, bottom: sides[k].y + bh }, o));
    const side = order.find((k) => sides[k].fits && clear(k)) || order.find((k) => sides[k].fits) || "below";
    const pos = sides[side];
    const x = side === "below" || side === "above" ? pos.x : pos.x;
    const y = side === "below" ? Math.min(pos.y, innerHeight - bh - m) : side === "above" ? Math.max(m, pos.y) : pos.y;
    bubble.style.left = `${x}px`;
    bubble.style.top = `${y}px`;
    if (side === "below" || side === "above") {
      const ax = Math.min(Math.max(12, r.left + r.width / 2 - x - 6), bw - 24);
      Object.assign(arrow.style, side === "below" ? { top: "-6px", bottom: "", left: `${ax}px`, right: "" } : { bottom: "-6px", top: "", left: `${ax}px`, right: "" });
    } else {
      const ay = Math.min(Math.max(12, r.top + r.height / 2 - y - 6), bh - 24);
      Object.assign(arrow.style, side === "right" ? { left: "-6px", right: "", top: `${ay}px`, bottom: "" } : { right: "-6px", left: "", top: `${ay}px`, bottom: "" });
    }
  }

  let frame = 0;
  let covered = false;
  let twinCheckedAt = 0;
  const sameLabel = (a, b) => a.toLowerCase().replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/\s+/g, " ").trim();
  /** A control with the same label as `el` that is fully in view and on top (not covered), if any. */
  function visibleTwin(el) {
    const label = labelOf(el);
    if (!label) return null;
    for (const c of deepQueryAll(document, INTERACTIVE)) {
      if (c === el || c.closest("#waypoint-host") || !isVisible(c) || !sameLabel(labelOf(c) || "", label)) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const pts = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7]].filter(([fx, fy]) => onTop(c, r.left + r.width * fx, r.top + r.height * fy)).length;
      if (pts >= 4) return c;
    }
    return null;
  }
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
      refreshObstacles();
      addOwnObstacles();
      // Covered = the control is really under something else, judged at its centre and four inner points
      // (the centre alone was fooled by a passing tooltip). Only the control itself counts: a hover-only
      // control's row is often overlapped by its own expanded details.
      covered = false;
      if (el === target && vis.right > vis.left && vis.bottom > vis.top) {
        const w = vis.right - vis.left, h = vis.bottom - vis.top;
        // Covered needs the centre hidden AND 3 of 4 inner points: a tooltip over just the centre, or
        // corners that fall outside a rounded button's box, don't count.
        const hiddenAt = (fx, fy) => !onTop(el, vis.left + w * fx, vis.top + h * fy);
        const corners = [[0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7]].filter(([fx, fy]) => hiddenAt(fx, fy)).length;
        covered = hiddenAt(0.5, 0.5) && corners >= 3;
        // Same label twice ("View all products" in an open drawer and on the page behind it): the one
        // that's covered isn't the one the user can click. Move to the twin that's in plain sight.
        if (covered && performance.now() - twinCheckedAt > 500) {
          twinCheckedAt = performance.now();
          const twin = visibleTwin(el);
          if (twin) {
            target = twin;
            covered = false;
          }
        }
      }
    }
    const clipped = vis.right - vis.left < 4 || vis.bottom - vis.top < Math.min(8, r.height / 2);
    bubble.classList.toggle("away", clipped);
    bubble.classList.toggle("covered", !clipped && covered);
    ring.classList.toggle("covered", !clipped && covered);
    if (!clipped && covered) $s(".scroll-text").textContent = "Something on the page is covering it. Close it to continue.";
    if (clipped) {
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

  function show(el, { step, text, why, src, mode, title, loading, loadingText, streaming, back, next, nextLabel, docUrl }) {
    target = el;
    lostSince = 0;
    covered = false;
    bubbleMode = mode === "explain" ? "explain" : mode === "pick" ? "pick" : "guide";
    ring.classList.remove("multi");
    showPins(bubbleMode === "pick");
    pill(null);
    // The mini status follows along: what to do now, with Pause / End / Open next to it.
    if (barUsed && bubbleMode !== "pick" && !loading && !streaming) miniState("guide", title || text);
    if (barUsed && bubbleMode === "pick" && !loading && !streaming && miniEl.classList.contains("open")) miniState("done", "Answered");
    raise();
    bubble.classList.toggle("explain", bubbleMode !== "guide");
    bubble.classList.toggle("nonav", bubbleMode === "pick");
    ring.classList.toggle("pick", bubbleMode === "pick");
    if (bubbleMode === "pick") hidePickBox(); // the ring takes over while the answer shows
    $s(".step").textContent = step || "";
    $s(".title").textContent = title || "";
    $s(".why").textContent = why || "";
    $s(".loading-text").textContent = loadingText || "Writing…";
    $s(".back").hidden = !back;
    $s(".next").textContent = nextLabel || (next ? "Next →" : "Done");
    update({ text, src, loading, streaming, docUrl });
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
  function update({ text, src, loading, streaming, docUrl }) {
    $s(".text").textContent = text || "";
    $s(".src").textContent = src || "";
    const doc = $s(".doc");
    doc.hidden = !docUrl;
    if (docUrl) {
      doc.href = docUrl;
      doc.title = `Source: ${docUrl}`;
    }
    bubble.classList.toggle("loading", !!loading);
    bubble.classList.toggle("streaming", !!streaming);
    // A streamed explainer finished: the mini status stops "thinking" and names what's showing.
    if (barUsed && !loading && !streaming && bubbleMode === "explain") miniState("guide", $s(".title").textContent || text);
    // A picked element's answer is complete on its own: the pill says so and folds away.
    if (barUsed && !loading && !streaming && bubbleMode === "pick" && miniEl.classList.contains("open")) miniState("done", "Answered");
  }

  function hide() {
    const wasPick = bubbleMode === "pick";
    target = null;
    cancelAnimationFrame(raf);
    ring.style.display = "none";
    bubble.style.display = "none";
    clearMarks();
    if (wasPick) showPins(false);
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
    if (e.data.__waypoint === "bar") return void toggleBar(); // same as the toolbar icon / Alt+Shift+W
    safeSend({ type: "page-command", command: e.data.__waypoint, q: e.data.q });
  });

  // ---------- Element picker ----------
  // Like devtools' inspector, but it snaps to what a person means (a control, a field with its label, a
  // row, a card, a chart, a column) and names it in plain words. Each click adds a numbered pin (click a
  // pin again to remove it); everything pinned is asked about together.
  const PICK_BLOCKS =
    "label,fieldset,[role=group],[role=region],[role=img],[role=figure],figure,img,svg,canvas,table,section,article,mat-card,.mat-mdc-card,li,dl,h1,h2,h3,h4,p,mat-form-field,.mat-mdc-form-field,[class*=chart],[class*=Chart],th,[role=columnheader],mat-header-cell,.mat-mdc-header-cell";
  const pickBox = shadow.querySelector(".pick");
  const pickTag = shadow.querySelector(".pick-tag");
  let picking = false;
  let hoverChain = [];
  let hoverLevel = 0;
  let lastContextTarget = null;
  let cursorStyle = null;
  let pickLoop = 0;

  const inHost = (e) => e.composedPath().includes(host);

  /** From the element under the cursor outward: the things a person could mean, smallest first. */
  function meaningfulChain(start) {
    const chain = [];
    for (let n = start, k = 0; n && n !== document.body && n !== document.documentElement && k < 30; n = parentOf(n), k++) {
      if (n.nodeType !== 1 || n === host || !n.matches) continue;
      if (!n.matches(INTERACTIVE) && !n.matches(PICK_BLOCKS)) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width * r.height > innerWidth * innerHeight * 0.85) continue;
      if (!isVisible(n) && !hoverOf.has(n)) continue;
      const prev = chain[chain.length - 1];
      if (prev) {
        const pr = prev.getBoundingClientRect();
        // A wrapper exactly around the previous one adds nothing.
        if (Math.abs(pr.left - r.left) < 2 && Math.abs(pr.top - r.top) < 2 && Math.abs(pr.width - r.width) < 2 && Math.abs(pr.height - r.height) < 2) continue;
      }
      chain.push(n);
    }
    return chain;
  }
  /** Where to start in the chain: an icon or graphic inside a control means the control. */
  function baseLevel(chain) {
    const ctl = chain.findIndex((n) => n.matches(INTERACTIVE));
    if (ctl > 0 && ctl <= 3 && chain.slice(0, ctl).every((n) => n.matches("svg,img,canvas,[role=img],p,label,li") && n.getBoundingClientRect().width < 64)) return ctl;
    return 0;
  }

  function visionNeed(el) {
    const has = (sel) => el.matches(sel) || !!el.querySelector?.(sel);
    const r = el.getBoundingClientRect();
    const big = r.width > 120 && r.height > 60; // charts are chart-sized; a "chart legend" button isn't
    if (big && has("canvas")) return "chart";
    const svgs = [el.matches("svg") ? el : null, ...(el.querySelectorAll?.("svg") || [])].filter(Boolean);
    if (svgs.some((sv) => { const b = sv.getBoundingClientRect(); return b.width > 90 && b.height > 45; })) return "chart";
    if (big && /chart|graph|sparkline|plot/i.test(`${el.className?.baseVal ?? el.className} ${el.getAttribute("aria-label") || ""}`)) return "chart";
    const imgs = [el.matches("img") ? el : null, ...(el.querySelectorAll?.("img") || [])].filter(Boolean);
    if (imgs.some((im) => { const b = im.getBoundingClientRect(); return b.width > 64 && b.height > 48; })) return "image";
    // Icon-only: no words, just an icon.
    if (textOf(el).replace(/\W/g, "").length < 2 && (has(ICON) || has("svg") || has("img"))) return "icon";
    return null;
  }

  const KIND = {
    button: "Button", link: "Link", switch: "Switch", checkbox: "Checkbox", radio: "Option", textbox: "Field", searchbox: "Field",
    combobox: "Dropdown", select: "Dropdown", tab: "Tab", "menu-toggle": "Menu", menuitem: "Menu item", menuitemcheckbox: "Menu item",
    menuitemradio: "Menu item", row: "Row", treeitem: "Item", option: "Option", summary: "Toggle",
  };
  function pickKind(el, vision) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const cls = String(el.className?.baseVal ?? el.className ?? "");
    if (vision === "chart") return "Chart";
    if (vision === "image") return "Image";
    if (vision === "icon") return el.matches(INTERACTIVE) ? "Icon button" : "Icon";
    if (el.matches(COLHEAD) && !el.matches(ROW) && !el.closest("tbody")) return "Column";
    if (el.matches(ROW)) return "Row";
    if (tag === "table") return "Table";
    if (/^h[1-6]$/.test(tag) || role === "heading") return "Heading";
    if (tag === "label" || tag === "fieldset" || tag === "mat-form-field" || /form-field/.test(cls) || role === "group") return "Setting";
    if (el.matches(INTERACTIVE)) return KIND[roleOf(el)] || "Control";
    if (tag === "section" || tag === "article" || role === "region") return "Section";
    if (/card/i.test(tag + " " + cls)) return "Card";
    if (tag === "p") return "Text";
    if (tag === "li" || tag === "dl") return "Item";
    return "Element";
  }
  /** A column header's own words, without its sort arrow or help icon ("Verified requests", not "… help"). */
  function colName(th) {
    const c = th.cloneNode(true);
    c.querySelectorAll("mat-icon,.material-icons,.material-symbols-outlined,[aria-hidden=true],button,svg").forEach((n) => n.remove());
    return clean(c.textContent || "") || textOf(th);
  }
  /** A column's values, row by row ("Firebase AI Logic: 100%"), so a picked column carries its data. */
  function colFields(th) {
    const table = th.closest("table,[role=table],[role=grid],[role=treegrid],mat-table,.mat-mdc-table");
    if (!table) return "";
    const heads = [...table.querySelectorAll(COLHEAD)].filter((h) => !h.closest("tbody"));
    const idx = heads.indexOf(th);
    if (idx < 0) return "";
    const out = [];
    for (const row of [...table.querySelectorAll(ROW)].slice(0, 40)) {
      const cells = [...row.querySelectorAll(CELL)];
      const cell = cells[idx - (heads.length - cells.length)];
      const v = cell && textOf(cell);
      if (v && cells.length > 1) out.push(`${textOf(cells[0]).slice(0, 40)}: ${v.slice(0, 60)}`);
      if (out.length >= 12) break;
    }
    return out.join(" · ");
  }
  function pickName(el, kind) {
    if (kind === "Column") return colName(el).slice(0, 80);
    if (kind === "Chart" || kind === "Image") {
      // A chart's own label usually starts with its name ("Traffic This chart is described by…").
      const own = (el.getAttribute("aria-label") || el.querySelector?.("[aria-label]")?.getAttribute("aria-label") || "").split(/\s+(?:This|The)\s+(?:chart|graph|image)\b|[.:\n]/i)[0].trim();
      if (own && own.length <= 40) return clean(own);
      // Otherwise the nearest visible title around it (a card's header, a panel's heading).
      for (let n = el, k = 0; n && k < 5; n = parentOf(n), k++) {
        const t = [...(n.querySelectorAll?.("h1,h2,h3,h4,h5,[role=heading],mat-card-title,[class*=card-title],[class*=chart-title],[class*=header-title]") || [])].find(
          (x) => !x.contains(el) && isVisible(x) && textOf(x)
        );
        if (t) return textOf(t).slice(0, 60);
      }
      const under = (contextOf(el).match(/under "([^"]+)"/) || [])[1];
      // Only a heading people can see (charts often carry a visually hidden one like "Graphs").
      const h = [...(el.querySelectorAll?.("h1,h2,h3,h4,[role=heading]") || [])].find((x) => isVisible(x) && textOf(x));
      if (h) return textOf(h).slice(0, 60);
      if (under) return under.slice(0, 60);
    }
    if (el.matches(INTERACTIVE) || el.matches(ROW)) {
      const l = labelOf(el);
      if (l) return l.slice(0, 80);
    }
    const aria = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title");
    if (aria) return clean(aria).slice(0, 80);
    const h = el.querySelector?.("h1,h2,h3,h4,h5,[role=heading],legend,mat-card-title,label");
    if (h && textOf(h)) return textOf(h).slice(0, 80);
    const t = textOf(el);
    if (t) return t.slice(0, 60) + (t.length > 60 ? "…" : "");
    const under = (contextOf(el).match(/under "([^"]+)"/) || [])[1];
    return under ? `${kind} in "${under}"` : kind;
  }

  /** A table row as "Column: value" pairs, so numbers mean something ("Verified requests: 100%"). */
  function rowFields(row) {
    const table = row.closest("table,[role=table],[role=grid],[role=treegrid],mat-table,.mat-mdc-table");
    if (!table) return "";
    const heads = [...table.querySelectorAll("thead th, [role=columnheader], mat-header-cell, .mat-mdc-header-cell")].map((h) => colName(h));
    const cells = [...row.querySelectorAll(CELL)].map((c) => textOf(c));
    if (!heads.length || !cells.length) return "";
    // Checkbox/select columns can make the counts differ: line them up from the right.
    const off = heads.length - cells.length;
    return cells
      .map((v, i) => {
        const h = heads[i + off] || "";
        return v ? (h ? `${h}: ${v}` : v) : "";
      })
      .filter(Boolean)
      .join(" · ");
  }

  /** Everything Nano gets about a picked element (redacted). */
  function describePick(el) {
    const vision = visionNeed(el);
    const kind = pickKind(el, vision);
    const d = describeEl(el);
    const text = textOf(el);
    return {
      kind,
      name: redact(pickName(el, kind)),
      role: roleOf(el),
      state: stateOf(el),
      context: redact(contextOf(el)),
      text: redact(text).slice(0, 1400),
      fields: el.matches(ROW) ? redact(rowFields(el)).slice(0, 600) : kind === "Column" ? redact(colFields(el)).slice(0, 600) : "",
      hint: d.hint,
      nearby: text.length > 60 ? "" : d.nearby,
      docHref: d.docHref,
      vision,
      pageTitle: redact(document.title),
      path: pagePath(),
    };
  }

  // ---- Tour marks: stops still to come in an explain tour, faint and numbered ----
  const marksLayer = shadow.querySelector(".marks");
  let marks = []; // { el, box, badge }
  function setMarks(list) {
    clearMarks();
    for (const { id, n } of list || []) {
      let el = idToEl.get(id);
      if (!el?.isConnected) continue;
      const head = el.closest("th,[role=columnheader]"); // same as the ring: a column's ⓘ marks the column
      if (head && head.getBoundingClientRect().width < 480) el = head;
      const box = document.createElement("div");
      box.className = "mark";
      const badge = document.createElement("div");
      badge.className = "mark-n";
      badge.textContent = String(n);
      marksLayer.append(box, badge);
      marks.push({ el, box, badge });
    }
    if (marks.length) runLoop();
  }
  function clearMarks() {
    for (const m of marks) m.box.remove(), m.badge.remove();
    marks = [];
  }
  function drawMarks() {
    for (const m of marks) {
      const r = m.el.isConnected ? m.el.getBoundingClientRect() : null;
      const off = !r || r.bottom < 0 || r.top > innerHeight || r.width === 0;
      m.box.style.display = m.badge.style.display = off ? "none" : "";
      if (off) continue;
      Object.assign(m.box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
      Object.assign(m.badge.style, { left: `${Math.max(4, r.left - 9)}px`, top: `${Math.max(4, r.top - 11)}px` });
    }
  }

  // ---- Pins: everything picked so far, numbered in the order it was picked ----
  const MAX_PINS = 8;
  const pinsLayer = shadow.querySelector(".pins");
  const pickbar = shadow.querySelector(".pickbar");
  let pins = []; // { el, key, box, tag }
  // Outlines show while picking, while the bar lists the picks and while their answer is open; closing
  // the answer (or starting a guide or tour) puts them away. The picks themselves stay in the bar.
  let pinsShown = true;
  const showPins = (on) => {
    pinsShown = on;
    if (on && pins.length) raise(), runLoop();
  };
  let pinSeq = 0;
  const pinOf = (el) => pins.find((p) => p.el === el);

  function tagSpot(r, w) {
    const th = 22, m = 6;
    let top = r.top - th - 6;
    if (top < m) top = Math.min(r.bottom + 6, innerHeight - th - m);
    return { left: Math.min(Math.max(m, r.left), innerWidth - Math.min(360, w || 200) - m), top };
  }
  function drawBox(el) {
    const r = el.getBoundingClientRect();
    Object.assign(pickBox.style, { display: "block", left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    pickTag.style.display = "flex";
    const t = tagSpot(r, pickTag.offsetWidth);
    Object.assign(pickTag.style, { left: `${t.left}px`, top: `${t.top}px` });
  }
  function labelTag(el) {
    const vision = visionNeed(el);
    const kind = pickKind(el, vision);
    pickTag.querySelector(".kind").textContent = kind;
    pickTag.querySelector(".name").textContent = kind === pickName(el, kind) ? "" : pickName(el, kind);
    pickTag.querySelector(".eye").hidden = !vision;
    const pinned = pinOf(el);
    pickTag.classList.toggle("is-pinned", !!pinned);
    pickTag.querySelector(".pstate").textContent = pinned ? `#${pins.indexOf(pinned) + 1} · click to remove` : pins.length >= MAX_PINS ? `max ${MAX_PINS}` : `+ #${pins.length + 1}`;
  }
  function hidePickBox() {
    pickBox.style.display = "none";
    pickTag.style.display = "none";
  }
  function renumber() {
    pins.forEach((p, i) => (p.tag.querySelector(".pin-n").textContent = String(i + 1)));
    updatePickbar();
  }
  function addPin(el) {
    const key = `p${++pinSeq}`;
    const vision = visionNeed(el);
    const kind = pickKind(el, vision);
    const name = pickName(el, kind);
    const box = document.createElement("div");
    box.className = "pin";
    const tag = document.createElement("div");
    tag.className = "pin-tag";
    tag.innerHTML = `<span class="pin-n"></span><span class="kind"></span><span class="name"></span><button class="unpin" type="button">×</button>`;
    tag.querySelector(".kind").textContent = kind;
    tag.querySelector(".name").textContent = kind === name ? "" : name;
    tag.querySelector(".unpin").setAttribute("aria-label", `Remove ${name}`);
    tag.querySelector(".unpin").title = "Remove";
    tag.querySelector(".unpin").addEventListener("click", () => removePin(key, true));
    tag.addEventListener("mouseenter", () => box.classList.add("hot"));
    tag.addEventListener("mouseleave", () => box.classList.remove("hot"));
    pinsLayer.append(box, tag);
    pins.push({ el, key, box, tag });
    raise();
    renumber();
    runLoop();
    const desc = describePick(el);
    safeSend({ type: "picked", desc, key });
    return desc;
  }
  function removePin(key, notify) {
    const p = pins.find((x) => x.key === key);
    if (!p) return;
    p.box.remove();
    p.tag.remove();
    pins = pins.filter((x) => x !== p);
    renumber();
    if (!pins.length && bubbleMode === "pick") hide();
    if (notify) safeSend({ type: "pick-removed", key });
    if (!pins.length) lower();
  }
  function clearPins(notify) {
    for (const p of pins) p.box.remove(), p.tag.remove();
    pins = [];
    updatePickbar();
    if (bubbleMode === "pick") hide();
    if (notify) safeSend({ type: "pick-cleared" });
    lower();
  }
  function drawPins() {
    for (const p of [...pins]) {
      if (!p.el.isConnected) {
        removePin(p.key, true);
        continue;
      }
      const r = p.el.getBoundingClientRect();
      const off = !pinsShown || r.bottom < 0 || r.top > innerHeight || r.width === 0;
      p.box.style.display = off ? "none" : "";
      p.tag.style.display = off || (picking && hoverChain[hoverLevel] === p.el) ? "none" : "";
      if (off) continue;
      Object.assign(p.box.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
      // One pick gets a full label above it; several get a numbered badge on the corner (name and × on
      // hover), so stacked rows don't bury each other under labels.
      const compact = pins.length > 1;
      p.tag.classList.toggle("compact", compact);
      const t = compact ? { left: Math.max(4, r.left - 8), top: Math.max(4, r.top - 10) } : tagSpot(r, p.tag.offsetWidth);
      Object.assign(p.tag.style, { left: `${t.left}px`, top: `${t.top}px` });
    }
  }
  // Follow scrolling / layout while picking or while anything is pinned (cheap: a few rects per frame).
  function loop() {
    pickLoop = requestAnimationFrame(loop);
    if (picking && hoverChain.length) drawBox(hoverChain[hoverLevel]);
    if (pins.length) drawPins();
    if (marks.length) drawMarks();
    if (!picking && !pins.length && !marks.length) cancelAnimationFrame(pickLoop);
  }
  function runLoop() {
    cancelAnimationFrame(pickLoop);
    loop();
  }
  function updatePickbar() {
    const n = pins.length;
    pickbar.querySelector(".pb-count").textContent = n ? `${n} picked` : "Picking";
    pickbar.querySelector(".pb-hint").textContent =
      n >= MAX_PINS ? `That's the most Nano can weigh at once. Click one to swap it out.` : n ? "Click more to add, click a pick to remove · ↑ ↓ widen" : "Click anything to ask about it · ↑ ↓ widen";
    pickbar.querySelector(".pb-clear").hidden = !n;
    pickbar.querySelector(".pb-done").textContent = n ? "Done" : "Cancel";
    pickbar.classList.toggle("full", n >= MAX_PINS);
  }

  function startPicking() {
    hide();
    showPins(true);
    picking = true;
    hoverChain = [];
    hoverLevel = 0;
    cursorStyle = document.createElement("style");
    cursorStyle.textContent = "*{cursor:crosshair !important}";
    (document.head || document.documentElement).appendChild(cursorStyle);
    pill(null);
    miniEl.classList.remove("open");
    updatePickbar();
    pickbar.classList.add("open");
    raise();
    runLoop();
  }
  /** Leave picking mode. With picks, Waypoint asks what you want to know; with none, it's a cancel. */
  function stopPicking(report = true) {
    if (!picking) return;
    picking = false;
    cursorStyle?.remove();
    cursorStyle = null;
    pickbar.classList.remove("open");
    hidePickBox();
    lower();
    if (report) safeSend(pins.length ? { type: "pick-finished", count: pins.length } : { type: "pick-cancelled" });
  }
  function togglePick(el) {
    const p = pinOf(el);
    if (p) removePin(p.key, true);
    else if (pins.length < MAX_PINS) addPin(el);
    else {
      pickbar.animate?.([{ transform: "translateX(-50%)" }, { transform: "translateX(calc(-50% - 6px))" }, { transform: "translateX(calc(-50% + 6px))" }, { transform: "translateX(-50%)" }], { duration: 260 });
      return;
    }
    labelTag(el);
  }
  pickbar.querySelector(".pb-done").addEventListener("click", () => stopPicking());
  pickbar.querySelector(".pb-clear").addEventListener("click", () => clearPins(true));

  function hoverAt(node) {
    const chain = meaningfulChain(node);
    if (!chain.length) return;
    if (chain[0] !== hoverChain[0]) {
      hoverChain = chain;
      hoverLevel = baseLevel(chain);
      labelTag(hoverChain[hoverLevel]);
    }
  }
  window.addEventListener(
    "pointermove",
    (e) => {
      if (!picking || inHost(e)) return;
      hoverAt(e.composedPath()[0]);
    },
    true
  );
  // While picking, the page must not react to clicks (consoles are full of Delete buttons).
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend"]) {
    window.addEventListener(
      type,
      (e) => {
        if (!picking || inHost(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (type === "click") {
          hoverAt(e.composedPath()[0]);
          if (hoverChain.length) togglePick(hoverChain[hoverLevel]);
        }
      },
      true
    );
  }
  window.addEventListener(
    "keydown",
    (e) => {
      if (!picking) return;
      if (e.key === "Escape" || e.key === "Enter") stopPicking(); // finish: with picks it's "Done", without it's a cancel
      else if (e.key === "ArrowUp" && hoverChain.length) hoverLevel = Math.min(hoverLevel + 1, hoverChain.length - 1), labelTag(hoverChain[hoverLevel]);
      else if (e.key === "ArrowDown" && hoverChain.length) hoverLevel = Math.max(hoverLevel - 1, 0), labelTag(hoverChain[hoverLevel]);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );
  // Right-click "Ask Waypoint about this": remember what was right-clicked.
  window.addEventListener("contextmenu", (e) => { if (!picking) lastContextTarget = e.composedPath()[0]; }, true);

  // ---------- The command bar ----------
  // Opened by the toolbar icon or Alt+Shift+W. The bar is the main way in: ask, pick, toggle cloud-only,
  // open the Trace panel. While Waypoint works it folds into the mini status at the top.
  const barEl = shadow.querySelector(".bar");
  const miniEl = shadow.querySelector(".mini");
  const qEl = shadow.querySelector(".q");
  const goEl = shadow.querySelector(".go");
  const b$ = (sel) => shadow.querySelector(sel);
  let barUsed = true; // the bar is the only way in now, so progress always shows in the top pill
  let snap = null; // the brain's view of things (status, nano, route, pick, settings…)
  let site = null;
  let miniMode = null;
  const toBrain = (msg) => chrome.runtime.sendMessage({ ...msg, to: "brain" }).catch(() => {});
  const toSW = (msg) => chrome.runtime.sendMessage({ ...msg, to: "sw" }).catch(() => null);

  const PLACEHOLDERS = [
    "What do you need? e.g. “Set log retention to 30 days”",
    "Ask how to do something… or “What do these settings do?”",
    "“Where do I manage my API keys?”",
    "“Walk me through this page”",
  ];
  let phIdx = 0;

  async function openBar({ focus = true } = {}) {
    barUsed = true;
    showPins(true);
    raise();
    miniEl.classList.remove("open");
    barEl.classList.add("open");
    qEl.placeholder = PLACEHOLDERS[phIdx++ % PLACEHOLDERS.length];
    if (focus) setTimeout(() => qEl.focus(), 30);
    toSW({ type: "ensure-brain" });
    const [s1, s2] = await Promise.all([chrome.runtime.sendMessage({ type: "brain:snapshot" }).catch(() => null), toSW({ type: "site-info", url: location.href })]);
    if (s1) snap = s1;
    site = s2;
    renderBar();
    toSW({ type: "trace-state" }).then((r) => renderTrace(r?.open));
  }
  function closeBar() {
    barEl.classList.remove("open");
    closeMenu();
    if (snap && (snap.mode && snap.mode !== "idle" || snap.paused)) miniEl.classList.add("open");
    else if (miniMode) miniState("done", "");
    lower();
  }
  const barOpen = () => barEl.classList.contains("open");
  function toggleBar() {
    if (barOpen()) closeBar();
    else openBar();
  }

  function renderNano() {
    const n = snap?.nano || { state: "checking", text: "Checking Nano…" };
    const btn = b$(".nano");
    btn.className = `nano ${n.state === "ready" ? "ready" : n.state === "checking" || n.state === "warming" ? "" : "warn"}`;
    b$(".nano-text").textContent = n.state === "ready" ? `Nano on-device${n.vision ? " · vision" : ""}` : n.state === "warming" ? "Waking Nano…" : n.state === "checking" ? "Checking Nano…" : "Set up Gemini Nano";
    btn.title = n.text || "";
  }
  function renderSite() {
    const el = b$(".site");
    el.hidden = !site?.web;
    if (!site?.web) return;
    b$(".site-host").textContent = site.host.replace(/^www\./, "").split(".").slice(-3).join("."); // console.firebase.google.com → firebase.google.com
    const on = site.allowed || site.all;
    el.setAttribute("aria-checked", String(!!on));
    el.title = site.all ? "On for every site (Settings to change)" : on ? `On for ${site.host}. Click to turn off.` : `Off for ${site.host}: click to keep Waypoint on here`;
    b$(".m-all").setAttribute("aria-checked", String(!!site.all));
  }
  /** The picks, as numbered chips matching the outlines on the page; × removes one, + adds more. */
  function renderChip() {
    const items = snap?.pick?.items || [];
    const tray = b$(".tray");
    tray.classList.toggle("open", items.length > 0);
    tray.classList.toggle("one", items.length === 1);
    tray.replaceChildren();
    if (!items.length) return;
    qEl.placeholder = items.length === 1 ? `Ask about “${items[0].desc.name}”…` : `Ask about these ${items.length}: compare them, how they relate…`;
    items.forEach(({ key, desc }, i) => {
      const c = document.createElement("span");
      c.className = "tchip";
      c.title = `${desc.kind}: ${desc.name}`;
      c.innerHTML = `<span class="pin-n"></span><span class="kind"></span><span class="name"></span><span class="eye" hidden>👁</span><button class="tx" type="button">×</button>`;
      c.querySelector(".pin-n").textContent = String(i + 1);
      c.querySelector(".kind").textContent = desc.kind;
      c.querySelector(".name").textContent = desc.name;
      c.querySelector(".eye").hidden = !desc.vision;
      if (desc.vision) c.querySelector(".eye").title = "Gemini Nano will look at a screenshot of it, on this device";
      const x = c.querySelector(".tx");
      x.setAttribute("aria-label", `Remove ${desc.name}`);
      x.title = "Remove";
      x.addEventListener("click", () => toBrain({ type: "bar:pick-remove", key }));
      tray.appendChild(c);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "tact";
    add.textContent = "+ Pick more";
    add.title = "Add more to ask about together (Alt+Shift+P)";
    add.addEventListener("click", startPickFromBar);
    tray.appendChild(add);
    if (items.length > 1) {
      const clr = document.createElement("button");
      clr.type = "button";
      clr.className = "tact";
      clr.textContent = "Clear all";
      clr.addEventListener("click", () => toBrain({ type: "bar:pick-clear" }));
      tray.appendChild(clr);
    }
  }
  function renderGrant() {
    const g = snap?.grant;
    b$(".grantbar").classList.toggle("open", !!g);
    if (g) b$(".grant-text").textContent = g.text;
  }
  function renderSuggest() {
    const box = b$(".suggest");
    box.innerHTML = "";
    const items = snap?.pick
      ? snap.pick.suggestions.map((t) => ({ t }))
      : qEl.value.trim()
        ? []
        : [{ t: "Walk me through this page" }, { t: "Pick something to ask about", pick: true }];
    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = it.t;
      b.addEventListener("click", () => (it.pick ? startPickFromBar() : submit(it.t)));
      box.appendChild(b);
    }
  }
  function renderBar() {
    renderNano();
    renderSite();
    renderChip();
    renderGrant();
    renderSuggest();
    b$(".cloud-btn").setAttribute("aria-pressed", String(!!snap?.settings?.cloudOnly));
    b$(".m-cloud").setAttribute("aria-checked", String(!!snap?.settings?.cloudOnly));
    b$(".pick-btn").setAttribute("aria-pressed", String(!!snap?.picking));
    setBarStatus(snap?.status || "", false);
    goEl.disabled = !qEl.value.trim();
  }
  function setBarStatus(text, busy) {
    const el = b$(".bstatus");
    el.textContent = text || "";
    el.classList.toggle("busy", !!busy);
  }
  function miniState(mode, text) {
    miniMode = mode;
    if (text) b$(".mini-text").textContent = text;
    miniEl.classList.toggle("busy", mode === "busy");
    miniEl.classList.toggle("paused", mode === "paused");
    // Finished: the pill stays as Waypoint's home base (what happened + Open), until dismissed.
    miniEl.classList.toggle("idle", mode === "done");
    b$(".mini .pause").textContent = mode === "paused" ? "Resume" : "Pause";
    if (mode === "done" && (text || !b$(".mini-text").textContent)) b$(".mini-text").textContent = text || "Done";
    clearTimeout(pillTimer);
    if (!barOpen() && !picking) {
      raise();
      miniEl.classList.add("open");
    }
  }

  function submit(text) {
    const q = (text ?? qEl.value).trim();
    if (!q) return;
    toBrain({ type: "bar:ask", q });
    qEl.value = "";
    goEl.disabled = true;
    // Fold up so the page (and the guide) is visible; progress shows in the mini status.
    barEl.classList.remove("open");
    closeMenu();
    const picked = snap?.pick?.items || [];
    b$(".mini-text").textContent = picked.length === 1 ? `Asking about “${picked[0].desc.name}”…` : picked.length ? `Asking about ${picked.length} picks…` : "Thinking…";
    miniState("busy");
  }
  function startPickFromBar() {
    barEl.classList.remove("open");
    miniEl.classList.remove("open");
    toBrain({ type: "bar:pick" });
  }
  const closeMenu = () => {
    b$(".menu").classList.remove("open");
    b$(".gear").setAttribute("aria-expanded", "false");
  };

  qEl.addEventListener("input", () => {
    goEl.disabled = !qEl.value.trim();
    qEl.style.height = "auto";
    qEl.style.height = `${Math.min(240, Math.max(88, qEl.scrollHeight + 2))}px`;
    if (!snap?.pick) renderSuggest();
  });
  qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeBar();
    }
  });
  barEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeBar();
  });
  goEl.addEventListener("click", () => submit());
  b$(".close").addEventListener("click", closeBar);
  b$(".pick-btn").addEventListener("click", startPickFromBar);
  b$(".cloud-btn").addEventListener("click", () => toBrain({ type: "bar:settings", settings: { cloudOnly: !snap?.settings?.cloudOnly } }));
  b$(".m-cloud").addEventListener("click", () => toBrain({ type: "bar:settings", settings: { cloudOnly: !snap?.settings?.cloudOnly } }));
  const renderTrace = (open) => {
    b$(".trace-btn").setAttribute("aria-pressed", String(!!open));
    b$(".trace-btn").title = open ? "Close the Trace panel" : "Open the Trace panel: every AI call, where it ran, what was sent";
    b$(".m-trace").firstChild.textContent = open ? "Close Trace " : "Open Trace (what ran where) ";
  };
  const openTrace = async () => {
    const r = await toSW({ type: "trace" });
    if (!r?.ok) setBarStatus("Open Trace from Chrome's side panel menu (the panel icon in the toolbar).", false);
    else renderTrace(r.open);
  };
  b$(".trace-btn").addEventListener("click", openTrace);
  b$(".m-trace").addEventListener("click", openTrace);
  b$(".m-setup").addEventListener("click", () => toSW({ type: "onboarding" }));
  b$(".nano").addEventListener("click", () => {
    if (snap?.nano?.state !== "ready") toSW({ type: "onboarding", hash: "nano" });
  });
  b$(".gear").addEventListener("click", () => {
    const m = b$(".menu");
    const open = !m.classList.contains("open");
    m.classList.toggle("open", open);
    b$(".gear").setAttribute("aria-expanded", String(open));
  });
  b$(".m-all").addEventListener("click", async () => {
    if (site?.all) {
      await toSW({ type: "all-sites-off" });
      site = await toSW({ type: "site-info", url: location.href });
      renderSite();
    } else toSW({ type: "grant", origins: ["<all_urls>"], text: "Use Waypoint on any site you visit, and let Nano see charts and icons you pick (screenshots stay on your device)." });
  });
  b$(".site").addEventListener("click", async () => {
    if (!site?.web) return;
    if (site.all) {
      b$(".menu").classList.add("open");
      return;
    }
    if (site.allowed && !site.builtIn) {
      await toSW({ type: "site-off", pattern: site.pattern });
      site = await toSW({ type: "site-info", url: location.href });
      renderSite();
    } else if (!site.allowed) toSW({ type: "grant", origins: [site.pattern], text: `Keep Waypoint on for ${site.host}, so it can guide you here any time.` });
  });
  b$(".grant-btn").addEventListener("click", () => snap?.grant && toSW({ type: "grant", origins: snap.grant.origins, text: snap.grant.text }));
  b$(".mini .open").addEventListener("click", () => openBar());
  b$(".mini .end").addEventListener("click", () => {
    toBrain({ type: "bar:end" });
    hide();
    miniState("done", "Ended. Ask something else any time.");
  });
  b$(".mini .dismiss").addEventListener("click", () => {
    miniEl.classList.remove("open");
    lower();
  });
  b$(".mini .pause").addEventListener("click", () => toBrain({ type: miniMode === "paused" ? "bar:resume" : "bar:pause" }));
  b$(".mini .replan").addEventListener("click", () => toBrain({ type: "bar:replan" }));
  miniEl.addEventListener("dblclick", () => openBar());

  /** Updates from the brain. */
  function onUi(msg) {
    snap ||= {};
    switch (msg.ui) {
      case "status":
        snap.status = msg.text;
        if (barOpen()) setBarStatus(msg.text, false);
        if (miniEl.classList.contains("open") || (barUsed && !barOpen() && snap.mode !== "idle")) b$(".mini-text").textContent = msg.text;
        break;
      case "nano":
        snap.nano = msg.nano;
        renderNano();
        break;
      case "route":
        snap.route = msg.route;
        snap.mode = msg.route ? (msg.route.kind === "tour" ? "explain" : "route") : snap.mode;
        break;
      case "paused":
        snap.paused = msg.on;
        // Un-pausing returns to following the guide; it never revives a finished or ended pill.
        if (barUsed && msg.on) miniState("paused", "Paused");
        else if (barUsed && miniMode === "paused") miniState("guide", "");
        break;
      case "replan":
        snap.replan = msg.visible;
        b$(".mini .replan").hidden = !msg.visible;
        break;
      case "picking":
        snap.picking = msg.on;
        if (msg.on) {
          barEl.classList.remove("open");
          miniEl.classList.remove("open");
        }
        b$(".pick-btn").setAttribute("aria-pressed", String(!!msg.on));
        break;
      case "pick":
        snap.pick = msg.pick;
        // While still picking, the pick bar shows the count; the command bar opens once they're done.
        if (msg.pick && !picking) openBar();
        else if (barOpen()) renderBar();
        break;
      case "grant":
        snap.grant = msg.grant;
        if (msg.grant?.kind === "screenshot") openBar({ focus: false });
        else renderGrant();
        break;
      case "query":
        qEl.value = msg.text || "";
        goEl.disabled = !qEl.value.trim();
        break;
      case "settings":
        snap.settings = msg.settings;
        if (barOpen()) renderBar();
        break;
    }
  }

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
        let el = idToEl.get(msg.id);
        if (el && el.isConnected) {
          // Explaining a column through its ⓘ: ring the whole header, so it's clear which column is meant.
          const head = msg.mode === "explain" && el.closest("th,[role=columnheader]");
          if (head && head.getBoundingClientRect().width < 480) el = head;
          show(el, msg);
          if (msg.mode === "explain") setMarks(msg.marks);
          reply({ ok: true });
        } else reply({ ok: false });
        break;
      }
      case "hide":
        hide();
        reply({ ok: true });
        break;
      case "doclinks":
        reply(pageDocLinks());
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
      case "ui":
        onUi(msg);
        reply({ ok: true });
        break;
      case "trace-state":
        renderTrace(msg.open);
        reply({ ok: true });
        break;
      case "bar-toggle":
        toggleBar();
        reply({ ok: true });
        break;
      case "bar-pick":
        startPickFromBar();
        reply({ ok: true });
        break;
      case "pick-start":
        startPicking();
        reply({ ok: true });
        break;
      case "pick-stop":
        if (picking) stopPicking();
        reply({ ok: true });
        break;
      case "pick-clear":
        clearPins(false);
        reply({ ok: true });
        break;
      case "pick-remove":
        removePin(msg.key, false);
        reply({ ok: true });
        break;
      case "pick-from-context": {
        const chain = lastContextTarget ? meaningfulChain(lastContextTarget) : [];
        if (!chain.length) reply(null);
        else {
          const el = chain[baseLevel(chain)];
          // Right-click adds to what's already picked (or re-reports it if it's picked already).
          const had = pinOf(el);
          if (had) safeSend({ type: "picked", desc: describePick(el), key: had.key, again: true });
          reply(had ? describePick(el) : pins.length < MAX_PINS ? addPin(el) : null);
        }
        break;
      }
      case "pick-show":
        if (pins[0]?.el.isConnected) {
          // The answer anchors on the first pick; every pick stays outlined and numbered around it.
          show(pins[0].el, { ...msg, mode: "pick" });
          ring.classList.toggle("multi", pins.length > 1);
          reply({ ok: true });
        } else reply({ ok: false });
        break;
      case "pick-rect": {
        // For the screenshot: bring it into view, hide Waypoint's own overlay, then report where it is.
        const pinned = (msg.key && pins.find((p) => p.key === msg.key)?.el) || pins[0]?.el;
        if (!pinned || !pinned.isConnected) {
          reply(null);
          break;
        }
        const r0 = pinned.getBoundingClientRect();
        const offscreen = r0.top < 0 || r0.bottom > innerHeight || r0.left < 0 || r0.right > innerWidth;
        if (offscreen) pinned.scrollIntoView({ block: "center", inline: "nearest" });
        host.style.visibility = "hidden";
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            setTimeout(() => {
              const r = pinned.getBoundingClientRect();
              reply({ left: r.left, top: r.top, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight });
            }, offscreen ? 250 : 30)
          )
        );
        return true; // async reply
      }
      case "pick-restore":
        host.style.visibility = "";
        reply({ ok: true });
        break;
      case "pill":
        pill(msg.mode || null, msg.text || "");
        reply({ ok: true });
        break;
      case "status":
        host.dataset.status = msg.text;
        // During a tour the pill says which stop is showing ("Explaining 2 of 5: Region").
        if (barUsed && bubbleMode === "explain" && target && /^Explaining /.test(msg.text)) miniState("guide", msg.text);
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
