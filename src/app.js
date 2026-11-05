const $ = (s) => document.querySelector(s);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "2026-11-04" -> parts without timezone drift
const parts = (d) => {
  const [y, m, day] = d.split("-").map(Number);
  return { y, m, day };
};
const monthKey = (d) => d.slice(0, 7);
const monthName = (key) => {
  const { y, m } = parts(key + "-01");
  return `${MONTHS[m - 1]} ${y}`;
};
const shortMonth = (key) => {
  const { y, m } = parts(key + "-01");
  return { m: MONTHS[m - 1].slice(0, 3), y };
};
const prettyDate = (d) => {
  const { y, m, day } = parts(d);
  return `${MONTHS[m - 1]} ${day}, ${y}`;
};

const state = { cat: null, tag: null, q: "", sort: "new" };
let data;
let catLabel = {};

async function load() {
  try {
    const res = await fetch("data.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    $("#lede").textContent = "The reading list didn’t load. Refresh the page to try again.";
    return;
  }
  catLabel = Object.fromEntries(data.categories.map((c) => [c.key, c.label]));
  renderIntro();
  renderShelf();
  renderLegend();
  bind();
  apply();
}

function renderIntro() {
  const items = data.items;
  const oldest = items[items.length - 1]?.created;
  const thisMonth = monthKey(items[0]?.created || "");
  const recent = items.filter((n) => monthKey(n.created) === thisMonth).length;
  const synced = prettyDate(data.vault.date.slice(0, 10));
  $("#lede").textContent =
    `${items.length} pages saved from the web since ${oldest ? monthName(monthKey(oldest)) : "the start"} — ` +
    `essays, tools, docs and the odd curiosity. ${recent} so far in ${monthName(thisMonth)}.`;
  $("#foot").textContent = `Pulled from Ashar’s Obsidian vault, last synced ${synced}.`;
}

function renderShelf() {
  const byMonth = new Map();
  // oldest on the left, so the shelf reads like a timeline
  for (const n of [...data.items].reverse()) {
    const k = monthKey(n.created);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(n);
  }
  const logs = data.items.map((n) => Math.log(Math.max(n.words, 20)));
  const lo = Math.min(...logs);
  const span = Math.max(...logs) - lo || 1;
  let i = 0;
  const html = [...byMonth]
    .map(([k, list]) => {
      const { m, y } = shortMonth(k);
      const books = list
        .map((n) => {
          const s = (Math.log(Math.max(n.words, 20)) - lo) / span;
          const wide = n.category === "Reading";
          return `<button class="spine${wide ? " wide" : ""}" type="button" data-id="${n.id}" data-cat="${esc(n.category)}"
            style="--s:${s.toFixed(3)};--i:${i++}" aria-label="${esc(n.title)}">${wide ? `<span>${esc(n.title)}</span>` : ""}</button>`;
        })
        .join("");
      return `<div class="month"><div class="month-books">${books}</div>
        <div class="month-label"><b>${m}</b> ${y}, ${list.length}</div></div>`;
    })
    .join("");
  const shelf = $("#shelf");
  shelf.innerHTML = html;
  shelf.classList.add("rise");
  shelf.scrollLeft = shelf.scrollWidth;
}

function renderLegend() {
  $("#legend").innerHTML = data.categories
    .slice()
    .sort((a, b) => b.count - a.count)
    .map(
      (c) => `<li><button type="button" data-cat="${esc(c.key)}" aria-pressed="false">
        ${esc(c.label)} <span class="count">${c.count}</span></button></li>`
    )
    .join("");
}

function matches(n) {
  if (state.cat && n.category !== state.cat) return false;
  if (state.tag && !n.tags.includes(state.tag)) return false;
  if (state.q) {
    const hay = `${n.title} ${n.domain ?? ""} ${n.description} ${n.tags.join(" ")} ${n.authors.join(" ")}`.toLowerCase();
    if (!state.q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

function entry(n) {
  const url = safeUrl(n.url);
  const { m, day } = parts(n.created);
  const fav = n.domain
    ? `<img src="https://icons.duckduckgo.com/ip3/${encodeURIComponent(n.domain)}.ico" alt="" loading="lazy" onerror="this.remove()">`
    : "";
  const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title);
  const tags = n.tags
    .map((t) => `<button type="button" data-tag="${esc(t)}" aria-pressed="${state.tag === t}">#${esc(t)}</button>`)
    .join("");
  return `<li class="entry" id="${n.id}" data-cat="${esc(n.category)}">
    <div class="day">${MONTHS[m - 1].slice(0, 3)}<br>${day}</div>
    <div>
      <h3>${title}</h3>
      <div class="meta">
        ${n.domain ? `<span>${fav}${esc(n.domain)}</span>` : ""}
        <span>${esc(catLabel[n.category] || n.category)}</span>
        ${n.words > 150 ? `<span>${n.minutes} min read</span>` : ""}
      </div>
      ${n.description ? `<p class="desc">${esc(n.description)}</p>` : ""}
      ${tags ? `<div class="tags">${tags}</div>` : ""}
    </div>
  </li>`;
}

function apply() {
  const shown = data.items.filter(matches);
  if (state.sort === "old") shown.reverse();
  const visible = new Set(shown.map((n) => n.id));

  document.querySelectorAll(".spine").forEach((el) => el.classList.toggle("dim", !visible.has(el.dataset.id)));
  document.querySelectorAll("#legend button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cat === state.cat)));

  const groups = new Map();
  for (const n of shown) {
    const k = monthKey(n.created);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  $("#list").innerHTML = shown.length
    ? [...groups]
        .map(
          ([k, list]) => `<section class="group" aria-label="${monthName(k)}">
          <h2>${monthName(k)}<small>${list.length} saved</small></h2>
          <ul class="entries">${list.map(entry).join("")}</ul></section>`
        )
        .join("")
    : `<p class="empty">Nothing matches that. Try a broader search or clear the filters.</p>`;

  const filters = [
    state.cat && catLabel[state.cat],
    state.tag && `#${state.tag}`,
    state.q && `“${state.q}”`,
  ].filter(Boolean);
  $("#status").innerHTML = filters.length
    ? `Showing ${shown.length} of ${data.items.length} for ${filters.map(esc).join(" + ")}. <button type="button" id="clear">Clear filters</button>`
    : "";
}

function clearFilters() {
  Object.assign(state, { cat: null, tag: null, q: "" });
  $("#q").value = "";
}

function jumpTo(id) {
  const n = data.items.find((x) => x.id === id);
  if (n && !matches(n)) {
    clearFilters();
    apply();
  }
  const row = document.getElementById(id);
  if (!row) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  row.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  row.classList.remove("flash");
  void row.offsetWidth;
  row.classList.add("flash");
  row.querySelector("h3 a")?.focus({ preventScroll: true });
}

function bind() {
  const tip = $("#tip");
  const showTip = (el) => {
    const n = data.items.find((x) => x.id === el.dataset.id);
    if (!n) return;
    tip.innerHTML = `<b>${esc(n.title)}</b>${esc(n.domain || "")}${n.domain ? ", " : ""}${prettyDate(n.created)}`;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 10)}px`;
  };
  const hideTip = () => (tip.hidden = true);

  const shelf = $("#shelf");
  shelf.addEventListener("pointerover", (e) => e.target.closest(".spine") && showTip(e.target.closest(".spine")));
  shelf.addEventListener("pointerout", hideTip);
  shelf.addEventListener("focusin", (e) => e.target.closest(".spine") && showTip(e.target.closest(".spine")));
  shelf.addEventListener("focusout", hideTip);
  shelf.addEventListener("scroll", hideTip, { passive: true });
  shelf.addEventListener("click", (e) => {
    const s = e.target.closest(".spine");
    if (s) {
      hideTip();
      jumpTo(s.dataset.id);
    }
  });

  $("#legend").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.cat = state.cat === b.dataset.cat ? null : b.dataset.cat;
    apply();
  });

  let t;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.q = e.target.value.trim().toLowerCase();
      apply();
    }, 120);
  });

  document.querySelector(".sort").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.sort = b.dataset.sort;
    document.querySelectorAll(".sort button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    apply();
  });

  document.addEventListener("click", (e) => {
    const tag = e.target.closest("[data-tag]");
    if (tag) {
      state.tag = state.tag === tag.dataset.tag ? null : tag.dataset.tag;
      apply();
      $("#status").scrollIntoView({ block: "nearest" });
    }
    if (e.target.id === "clear") {
      clearFilters();
      apply();
    }
  });
}

load();
