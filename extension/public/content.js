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
      const covered = inView && !onTop(el, Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1));
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
      .ring{position:fixed;border:2px solid #4f7cff;border-radius:8px;box-shadow:0 0 0 9999px rgba(10,16,34,.28),0 0 0 4px rgba(79,124,255,.35);transition:left .18s ease,top .18s ease,width .18s ease,height .18s ease,opacity .15s;display:none}
      .bubble{position:fixed;max-width:320px;background:#111a33;color:#f4f6ff;font:13px/1.45 system-ui,-apple-system,sans-serif;padding:12px 14px 10px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:auto;display:none;animation:in .16s ease-out}
      .bubble .step{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#9fb3ff;margin-bottom:4px;padding-right:18px}
      .bubble .why{color:#c9d2f0;font-size:12px;margin-top:6px}
      .bubble .why:empty,.bubble .text:empty{display:none}
      .bubble .src{color:#7f8bb0;font-size:10.5px;margin-top:8px}
      .bubble .src:empty{display:none}
      .bubble .doc{color:#9fb3ff;font-size:11px;margin-left:8px;text-decoration:none;border-bottom:1px dotted #9fb3ff}
      .bubble .doc:hover{color:#c9d6ff}
      .bubble .doc[hidden]{display:none}
      .bubble .foot{display:flex;align-items:baseline;margin-top:8px}
      .bubble .foot .src{margin-top:0}
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
      .bubble.away .scroll,.bubble.covered .scroll{display:flex}
      .bubble.covered .scroll-icon,.bubble.covered .show-me{display:none}
      .ring.covered{border-style:dashed;opacity:.7}
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
      .ring.pick{border-color:#22c39a;box-shadow:0 0 0 9999px rgba(10,16,34,.18),0 0 0 4px rgba(34,195,154,.3)}
      .bubble.nonav .nav{display:none}
      .pick{position:fixed;display:none;border:2px solid #22c39a;background:rgba(34,195,154,.12);border-radius:6px;box-shadow:0 0 0 1px rgba(0,0,0,.25);transition:left .1s ease,top .1s ease,width .1s ease,height .1s ease;pointer-events:none}
      .pick.pinned{background:rgba(34,195,154,.05);box-shadow:0 0 0 4px rgba(34,195,154,.25)}
      .pick-tag{position:fixed;display:none;align-items:center;gap:6px;max-width:360px;background:#0f2a24;color:#e3fff6;font:600 11.5px/1.25 system-ui,-apple-system,sans-serif;padding:4px 6px 4px 8px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.3);pointer-events:none;white-space:nowrap}
      .pick-tag .kind{color:#7ff0cc;text-transform:uppercase;font-size:10px;letter-spacing:.05em;flex:none}
      .pick-tag .name{overflow:hidden;text-overflow:ellipsis}
      .pick-tag .eye{flex:none;color:#ffd78a;font-size:11px}
      .pick-tag .unpin{display:none;flex:none;background:none;border:0;color:#9ff0d6;cursor:pointer;font:14px/1 system-ui;padding:0 2px;border-radius:4px}
      .pick-tag.pinned{pointer-events:auto}
      .pick-tag.pinned .unpin{display:inline}
      .pick-tag .unpin:hover,.pick-tag .unpin:focus-visible{background:rgba(127,240,204,.15);outline:none}
      .pill.pick .dot{display:block;background:#22c39a;animation:none}
      @media (prefers-reduced-motion:reduce){.ring,.bubble,.pill,.pill .dot,.scroll-icon,.spinner,.bubble.streaming .text::after,.pick{transition:none;animation:none}}
    </style>
    <div class="ring"></div>
    <div class="pick"></div>
    <div class="pick-tag" role="status" aria-live="polite"><span class="kind"></span><span class="name"></span><span class="eye" hidden title="Gemini Nano will look at it">👁</span><button class="unpin" title="Clear selection" aria-label="Clear selection">×</button></div>
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
  const anyVisible = () =>
    ring.style.display === "block" || pillEl.style.display === "flex" || shadow.querySelector(".pick").style.display === "block";
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
    pill(null);
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
  }

  function hide() {
    const wasPick = bubbleMode === "pick";
    target = null;
    cancelAnimationFrame(raf);
    ring.style.display = "none";
    bubble.style.display = "none";
    if (wasPick && pinned) drawPin(); // back to the pinned outline
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

  // ---------- Element picker ----------
  // Like devtools' inspector, but it snaps to what a person means (a control, a field with its label, a
  // row, a card, a chart) and names it in plain words. Clicking pins it as context for questions.
  const PICK_BLOCKS =
    "label,fieldset,[role=group],[role=region],[role=img],[role=figure],figure,img,svg,canvas,table,section,article,mat-card,.mat-mdc-card,li,dl,h1,h2,h3,h4,p,mat-form-field,.mat-mdc-form-field,[class*=chart],[class*=Chart]";
  const pickBox = shadow.querySelector(".pick");
  const pickTag = shadow.querySelector(".pick-tag");
  let picking = false;
  let hoverChain = [];
  let hoverLevel = 0;
  let pinned = null;
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
    if (has("canvas")) return "chart";
    const svgs = [el.matches("svg") ? el : null, ...(el.querySelectorAll?.("svg") || [])].filter(Boolean);
    if (svgs.some((sv) => { const b = sv.getBoundingClientRect(); return b.width > 90 && b.height > 45; })) return "chart";
    if (/chart|graph|sparkline|plot/i.test(`${el.className?.baseVal ?? el.className} ${el.getAttribute("aria-label") || ""}`)) return "chart";
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
  function pickName(el, kind) {
    if (kind === "Chart" || kind === "Image") {
      // Charts' aria-labels are often long descriptions; their heading is the name people use.
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
    const heads = [...table.querySelectorAll("thead th, [role=columnheader], mat-header-cell, .mat-mdc-header-cell")].map((h) => textOf(h));
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
      fields: el.matches(ROW) ? redact(rowFields(el)).slice(0, 600) : "",
      hint: d.hint,
      nearby: text.length > 60 ? "" : d.nearby,
      docHref: d.docHref,
      vision,
      pageTitle: redact(document.title),
      path: pagePath(),
    };
  }

  function placeTag(r, pinnedMode) {
    const th = 22, m = 6;
    let top = r.top - th - 6;
    if (top < m) top = Math.min(r.bottom + 6, innerHeight - th - m);
    pickTag.style.left = `${Math.min(Math.max(m, r.left), innerWidth - Math.min(360, pickTag.offsetWidth || 200) - m)}px`;
    pickTag.style.top = `${top}px`;
    pickTag.classList.toggle("pinned", pinnedMode);
  }
  function drawBox(el, pinnedMode) {
    const r = el.getBoundingClientRect();
    Object.assign(pickBox.style, { display: "block", left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    pickBox.classList.toggle("pinned", pinnedMode);
    pickTag.style.display = "flex";
    placeTag(r, pinnedMode);
  }
  function labelTag(el) {
    const vision = visionNeed(el);
    const kind = pickKind(el, vision);
    pickTag.querySelector(".kind").textContent = kind;
    pickTag.querySelector(".name").textContent = kind === pickName(el, kind) ? "" : pickName(el, kind);
    pickTag.querySelector(".eye").hidden = !vision;
  }
  function hidePickBox() {
    pickBox.style.display = "none";
    pickTag.style.display = "none";
  }
  function drawPin() {
    if (!pinned || !pinned.isConnected) return;
    raise();
    labelTag(pinned);
    drawBox(pinned, true);
  }
  // Follow scrolling / layout while hovering or pinned (cheap: one rect per frame).
  function loop() {
    pickLoop = requestAnimationFrame(loop);
    if (picking && hoverChain.length) drawBox(hoverChain[hoverLevel], false);
    else if (pinned && !(bubbleMode === "pick" && ring.style.display === "block")) {
      if (!pinned.isConnected) return clearPin(true);
      drawBox(pinned, true);
    }
  }

  function startPicking() {
    clearPin(false);
    hide();
    picking = true;
    hoverChain = [];
    hoverLevel = 0;
    cursorStyle = document.createElement("style");
    cursorStyle.textContent = "*{cursor:crosshair !important}";
    (document.head || document.documentElement).appendChild(cursorStyle);
    pill("pick", "Click anything to ask about it · ↑ ↓ to widen · Esc to cancel");
    cancelAnimationFrame(pickLoop);
    loop();
  }
  function stopPicking() {
    picking = false;
    cursorStyle?.remove();
    cursorStyle = null;
    pill(null);
    if (!pinned) hidePickBox();
  }
  function select(el) {
    stopPicking();
    pinned = el;
    labelTag(el);
    drawPin();
    cancelAnimationFrame(pickLoop);
    loop();
    const desc = describePick(el);
    safeSend({ type: "picked", desc });
    return desc;
  }
  function clearPin(notify) {
    pinned = null;
    hidePickBox();
    if (bubbleMode === "pick") hide();
    cancelAnimationFrame(pickLoop);
    lower();
    if (notify) safeSend({ type: "pick-cleared" });
  }
  pickTag.querySelector(".unpin").addEventListener("click", () => clearPin(true));

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
          if (hoverChain.length) select(hoverChain[hoverLevel]);
        }
      },
      true
    );
  }
  window.addEventListener(
    "keydown",
    (e) => {
      if (!picking) return;
      if (e.key === "Escape") stopPicking(), safeSend({ type: "pick-cancelled" });
      else if (e.key === "ArrowUp" && hoverChain.length) hoverLevel = Math.min(hoverLevel + 1, hoverChain.length - 1), labelTag(hoverChain[hoverLevel]);
      else if (e.key === "ArrowDown" && hoverChain.length) hoverLevel = Math.max(hoverLevel - 1, 0), labelTag(hoverChain[hoverLevel]);
      else if (e.key === "Enter" && hoverChain.length) select(hoverChain[hoverLevel]);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );
  // Right-click "Ask Waypoint about this": remember what was right-clicked.
  window.addEventListener("contextmenu", (e) => { if (!picking) lastContextTarget = e.composedPath()[0]; }, true);

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
      case "pick-start":
        startPicking();
        reply({ ok: true });
        break;
      case "pick-stop":
        if (picking) stopPicking();
        reply({ ok: true });
        break;
      case "pick-clear":
        clearPin(false);
        reply({ ok: true });
        break;
      case "pick-from-context": {
        const chain = lastContextTarget ? meaningfulChain(lastContextTarget) : [];
        reply(chain.length ? select(chain[baseLevel(chain)]) : null);
        break;
      }
      case "pick-show":
        if (pinned && pinned.isConnected) {
          show(pinned, { ...msg, mode: "pick" });
          reply({ ok: true });
        } else reply({ ok: false });
        break;
      case "pick-rect": {
        // For the screenshot: bring it into view, hide Waypoint's own overlay, then report where it is.
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
