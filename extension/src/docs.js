// Documentation lookup for any site. Waypoint finds the docs (the page's own "Learn more" links, else
// cloud Gemini's suggestion, which only counts if it loads), then:
//   1. fetches the public docs page itself (needs the user's OK for that docs site), splits it into
//      sections and keeps the ones relevant to the question: on-device Nano reads these excerpts;
//   2. otherwise asks cloud Gemini to read the pages with the URL context tool and return the facts.
// Either way the docs are public pages; nothing from the user's own page is sent to read them.
import { readDocs, suggestDocs } from "./pipeline.js";

const STOP = new Set(
  "the and for with you your this that from are can how what where when which will into its use using page see more about also then than other".split(" ")
);
const stems = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.slice(0, 5));

/** Query terms: stems, plus acronyms of hyphenated terms ("time-to-live" also matches "TTL"). */
function queryTerms(query) {
  const terms = new Set(stems(query));
  for (const m of (query || "").toLowerCase().matchAll(/\b[a-z]+(?:-[a-z]+){1,4}\b/g)) {
    const acr = m[0].split("-").map((w) => w[0]).join("");
    if (acr.length >= 3) terms.add(acr);
  }
  return terms;
}

export const originPattern = (url) => `${new URL(url).origin}/*`;
export const cleanUrl = (u) => {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return null;
  }
};

export async function canFetch(url) {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(url)] });
  } catch {
    return false;
  }
}

// url -> Promise<{ url, title, chunks: [{ heading, text }] }>
const pages = new Map();

/** Fetch a docs page and split its main content into sections (heading + paragraphs, ~800 chars). */
function fetchDoc(url) {
  if (!pages.has(url)) {
    pages.set(
      url,
      (async () => {
        const res = await fetch(url, { credentials: "omit", redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        doc
          .querySelectorAll(
            "script,style,noscript,template,nav,header,footer,aside,button,[hidden],[aria-hidden=true],[role=navigation],[role=banner],devsite-toc,devsite-book-nav,devsite-feature-tooltip,devsite-bookmark,.devsite-nav,.devsite-page-title-meta"
          )
          .forEach((n) => n.remove());
        const root = doc.querySelector("article, main, [role=main], .devsite-article-body") || doc.body;
        // Links to other pages on the same docs site, for following one hop toward the right page.
        const base = new URL(res.url || url);
        const links = [];
        for (const a of root.querySelectorAll("a[href]")) {
          let u;
          try { u = new URL(a.getAttribute("href"), base); } catch { continue; }
          if (u.origin !== base.origin || u.pathname === base.pathname) continue;
          links.push({ url: `${u.origin}${u.pathname}`, text: a.textContent.replace(/\s+/g, " ").trim() });
        }
        const chunks = [];
        let cur = { heading: doc.title.trim(), text: "" };
        const push = () => cur.text.trim() && chunks.push({ heading: cur.heading, text: cur.text.trim() });
        for (const el of root.querySelectorAll("h1,h2,h3,h4,p,li,dt,dd,td,th,pre,blockquote")) {
          if (/^H[1-4]$/.test(el.tagName)) {
            push();
            cur = { heading: el.textContent.replace(/\s+/g, " ").trim(), text: "" };
            continue;
          }
          if (el.parentElement?.closest("p,li,dt,dd,td,th,pre,blockquote")) continue; // nested: already counted
          const t = el.textContent.replace(/\s+/g, " ").trim();
          if (!t) continue;
          // Long blocks are split at sentence ends so no single section outgrows the excerpt budget.
          const pieces = t.length <= 800 ? [t] : t.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g).reduce((acc, sen) => {
            if (!acc.length || acc[acc.length - 1].length + sen.length > 800) acc.push(sen.trim());
            else acc[acc.length - 1] += " " + sen.trim();
            return acc;
          }, []);
          for (const piece of pieces) {
            if (cur.text.length + piece.length > 800) {
              push();
              cur = { heading: cur.heading, text: "" };
            }
            cur.text += (el.tagName === "LI" ? "• " : "") + piece + "\n";
          }
        }
        push();
        if (!chunks.length) throw new Error("no readable text");
        return { url: res.url || url, title: doc.title.trim(), chunks, links };
      })()
    );
    pages.get(url).catch(() => pages.delete(url)); // let a later call retry
  }
  return pages.get(url);
}

/** The sections of the fetched docs most relevant to `query`, in page order, up to `max` characters. */
function excerpt(docs, query, max, phrase = "") {
  const q = queryTerms(query);
  if (!q.size) return "";
  // Rare words tell sections apart ("token", "ttl"); words in every section ("app", "check") barely count.
  const all = docs.flatMap((d, di) => d.chunks.map((c, ci) => ({ di, ci, c, url: d.url, head: new Set(stems(c.heading)), body: new Set(stems(c.text)) })));
  const df = new Map();
  for (const x of all) for (const w of q) if (x.head.has(w) || x.body.has(w)) df.set(w, (df.get(w) || 0) + 1);
  const idf = (w) => Math.log(1 + all.length / (df.get(w) || all.length));
  // Sections that name the control itself ("Firebase AI Logic") beat sections about neighbouring topics.
  const ph = (phrase || "").toLowerCase().replace(/\s+/g, " ").trim();
  const scored = [];
  for (const x of all) {
    let s = 0;
    for (const w of q) s += (x.head.has(w) ? 3 : 0) * idf(w) + (x.body.has(w) ? 1 : 0) * idf(w);
    if (ph.length > 3 && `${x.c.heading} ${x.c.text}`.toLowerCase().replace(/\s+/g, " ").includes(ph)) s = s * 2 + 6;
    if (s > 0) scored.push({ ...x, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const picked = [];
  let used = 0;
  for (const x of scored) {
    const len = x.c.heading.length + x.c.text.length + 6;
    if (used + len > max) {
      // Trim the best section to fit rather than skip it; skip lesser ones.
      if (picked.length === 0 && max - used > 200) {
        picked.push({ ...x, c: { heading: x.c.heading, text: x.c.text.slice(0, max - used - x.c.heading.length - 8) + "…" } });
        used = max;
      }
      continue;
    }
    picked.push(x);
    used += len;
  }
  picked.sort((a, b) => a.di - b.di || a.ci - b.ci);
  return picked.map((x) => `## ${x.c.heading}\n${x.c.text}`).join("\n\n");
}

/**
 * Look up docs for a question. `urls` are the page's own docs links (most relevant first). Returns an
 * object the guide and explainer use: text for a query, the source URL, how it was read, and any docs
 * sites the user could allow for better results.
 */
export async function docLookup({ urls = [], question, labels = [], title = "", host = "", suggest = true, onLog }) {
  const t0 = performance.now();
  let list = [...new Set(urls.map(cleanUrl).filter(Boolean))];
  let suggested = [];
  if (suggest) {
    try {
      suggested = (await suggestDocs({ question, title, host, labels })).urls.map(cleanUrl).filter(Boolean);
    } catch (e) {
      console.warn("[Waypoint] docs suggestion failed", e?.message);
    }
  }
  // Specific suggestions first, then the page's own (often general) links.
  list = [...new Set([...suggested, ...list])].slice(0, 3);
  if (!list.length) return { how: "none", list, suggested, needs: [] };

  const allowed = await Promise.all(list.map(canFetch));
  const fetched = (
    await Promise.all(list.map((u, i) => (allowed[i] ? fetchDoc(u).catch(() => null) : null)))
  ).filter(Boolean);

  // One hop, like a person browsing docs: follow the links on these pages whose text or path best
  // matches the question and what's on screen (e.g. the provider the user's app actually uses).
  if (fetched.length) {
    const q = new Set(stems(`${question} ${labels.join(" ")}`));
    const seen = new Set([...list, ...fetched.map((d) => cleanUrl(d.url))]);
    const hops = new Map();
    for (const d of fetched)
      for (const l of d.links) {
        const u = cleanUrl(l.url);
        if (!u || seen.has(u)) continue;
        const s = stems(`${l.text} ${u.split("/").slice(3).join(" ").replace(/[-_]/g, " ")}`).filter((w) => q.has(w)).length;
        if (s >= 2 && s > (hops.get(u) || 0)) hops.set(u, s);
      }
    const next = [...hops].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([u]) => u);
    const more = (await Promise.all(next.map(async (u) => ((await canFetch(u)) ? fetchDoc(u).catch(() => null) : null)))).filter(Boolean);
    fetched.push(...more);
  }
  const needs = [...new Set(list.filter((_, i) => !allowed[i]).map((u) => new URL(u).host))];

  if (fetched.length) {
    const r = {
      how: "fetched",
      list,
      suggested,
      needs,
      sources: fetched.map((d) => d.url),
      ms: Math.round(performance.now() - t0),
      text: (query, max = 1600, phrase = "") => excerpt(fetched, query, max, phrase),
      urlFor: (query) => {
        const q = new Set(stems(query));
        let best = fetched[0], bestS = -1;
        for (const d of fetched) {
          const s = d.chunks.reduce((n, c) => n + stems(c.heading + " " + c.text).filter((w) => q.has(w)).length, 0);
          if (s > bestS) [best, bestS] = [d, s];
        }
        return best.url;
      },
    };
    onLog?.(r);
    return r;
  }

  // Nothing we may (or could) fetch: let cloud Gemini read the pages with the URL context tool.
  try {
    const c = await readDocs({ urls: list, question, title, labels });
    if (c.read.length && (c.summary || c.notes.length || c.uiPath)) {
      const notes = new Map(c.notes.map((n) => [n.label, n.note]));
      const r = {
        how: "cloud",
        list,
        suggested,
        needs,
        sources: c.read,
        ms: Math.round(performance.now() - t0),
        uiPath: c.uiPath,
        summary: c.summary,
        sent: c.sent,
        text: (query) => notes.get(query) || [c.uiPath && `Where: ${c.uiPath}`, c.summary].filter(Boolean).join("\n"),
        urlFor: () => c.read[0],
      };
      onLog?.(r);
      return r;
    }
  } catch (e) {
    console.warn("[Waypoint] cloud docs read failed", e?.message);
  }
  const r = { how: "none", list, suggested, needs, ms: Math.round(performance.now() - t0) };
  onLog?.(r);
  return r;
}

/** Forget fetched pages (e.g. after the user allows a docs site, so failures are retried). */
export const clearDocsCache = () => pages.clear();
