// AtmoScholar: papers come live from the OpenAlex API. Jobs, funding calls and the CO2 reading
// come from files in data/ that a GitHub Action rebuilds daily (see scripts/).

const OPENALEX = "https://api.openalex.org/works";
const ATMOS_SUBFIELD = "1902"; // OpenAlex subfield "Atmospheric Science"
const PER_PAGE = 25;

// Each topic is a set of terms matched against titles and abstracts (OR-ed together).
const TOPICS = [
  { id: "all", label: "All topics", terms: null },
  { id: "clouds", label: "Clouds & precipitation", terms: ["cloud", "precipitation", "microphysics", "rainfall"] },
  { id: "aerosols", label: "Aerosols", terms: ["aerosol", "particulate matter", "cloud condensation nuclei", "black carbon"] },
  { id: "chemistry", label: "Atmospheric chemistry", terms: ["atmospheric chemistry", "tropospheric ozone", "oxidation", "secondary organic aerosol"] },
  { id: "airquality", label: "Air quality", terms: ["air quality", "PM2.5", "air pollution", "haze"] },
  { id: "convection", label: "Convection & severe storms", terms: ["convection", "thunderstorm", "tornado", "hail", "mesoscale convective"] },
  { id: "tc", label: "Tropical cyclones", terms: ["tropical cyclone", "hurricane", "typhoon"] },
  { id: "dynamics", label: "Climate dynamics", terms: ["ENSO", "El Niño", "monsoon", "teleconnection", "jet stream", "Madden-Julian"] },
  { id: "modeling", label: "Climate modeling", terms: ["climate model", "CMIP6", "earth system model", "climate projection"] },
  { id: "nwp", label: "Weather prediction", terms: ["numerical weather prediction", "data assimilation", "ensemble forecast", "forecast skill"] },
  { id: "ml", label: "AI & machine learning", terms: ["machine learning", "deep learning", "neural network"] },
  { id: "pbl", label: "Boundary layer & turbulence", terms: ["boundary layer", "turbulence", "land-atmosphere", "surface flux"] },
  { id: "remote", label: "Remote sensing", terms: ["satellite", "lidar", "radar", "remote sensing", "retrieval"] },
  { id: "strat", label: "Stratosphere & middle atmosphere", terms: ["stratosphere", "stratospheric", "polar vortex", "gravity wave"] },
  { id: "polar", label: "Polar & Arctic", terms: ["Arctic", "Antarctic", "sea ice"] },
  { id: "extremes", label: "Extremes", terms: ["heatwave", "heat wave", "drought", "extreme precipitation", "compound event"] },
  { id: "radiation", label: "Radiation & climate forcing", terms: ["radiative forcing", "radiation budget", "climate sensitivity", "cloud feedback"] },
];

// Journals are matched by ISSN.
const JOURNALS = [
  ["Journal of the Atmospheric Sciences", "0022-4928"],
  ["Journal of Climate", "0894-8755"],
  ["Monthly Weather Review", "0027-0644"],
  ["Bulletin of the AMS", "0003-0007"],
  ["Weather and Forecasting", "0882-8156"],
  ["J. Applied Meteorology and Climatology", "1558-8424"],
  ["JGR: Atmospheres", "2169-897X"],
  ["Geophysical Research Letters", "0094-8276"],
  ["J. Advances in Modeling Earth Systems", "1942-2466"],
  ["Atmospheric Chemistry and Physics", "1680-7316"],
  ["Atmospheric Measurement Techniques", "1867-1381"],
  ["Geoscientific Model Development", "1991-959X"],
  ["Weather and Climate Dynamics", "2698-4016"],
  ["Quarterly Journal of the RMetS", "0035-9009"],
  ["Atmospheric Research", "0169-8095"],
  ["Atmospheric Environment", "1352-2310"],
  ["npj Climate and Atmospheric Science", "2397-3722"],
  ["Climate Dynamics", "0930-7575"],
  ["Environmental Research Letters", "1748-9326"],
];

const SECTORS = [
  { id: "all", label: "All jobs" },
  { id: "academia", label: "Academia" },
  { id: "government", label: "Government & labs" },
  { id: "industry", label: "Industry" },
];

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const state = Object.assign(
  { topic: "all", journal: "", ptype: "article|preprint|review", sort: "publication_date:desc", oaOnly: false, query: "" },
  load("atmo.papers", {}),
  { page: 1, mode: "latest", sector: "all", jobQuery: "" }
);
let saved = load("atmo.saved", {}); // OpenAlex id -> work, the viewer's reading list

/* ---------- Tabs ---------- */
const TABS = ["papers", "jobs", "funding", "events", "social"];
const loaded = {};
function showTab() {
  const hash = location.hash.slice(1);
  const tab = TABS.includes(hash) ? hash : "papers";
  for (const t of TABS) {
    $(`#view-${t}`).hidden = t !== tab;
    $(`#tab-${t}`).setAttribute("aria-selected", String(t === tab));
  }
  if (!loaded[tab]) {
    loaded[tab] = true;
    ({ jobs: loadJobs, funding: loadGrants, events: renderEvents, social: renderSocial })[tab]?.();
  }
  updateAltimeter();
}
window.addEventListener("hashchange", showTab);

/* ---------- Papers ---------- */
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const today = () => isoDate(new Date());

function buildUrl() {
  const filters = [];
  filters.push(state.journal ? `primary_location.source.issn:${state.journal}` : `primary_topic.subfield.id:${ATMOS_SUBFIELD}`);
  filters.push(`type:${state.ptype}`);
  filters.push(`to_publication_date:${today()}`);
  if (state.mode === "trending") filters.push(`from_publication_date:${isoDate(new Date(Date.now() - 60 * 86400000))}`);
  if (state.oaOnly) filters.push("is_oa:true");
  const topic = TOPICS.find((t) => t.id === state.topic);
  if (topic?.terms) filters.push(`title_and_abstract.search:${topic.terms.join("|")}`);

  let sort = state.mode === "trending" ? "cited_by_count:desc" : state.sort;
  if (sort === "relevance_score:desc" && !state.query) sort = "publication_date:desc";

  const params = new URLSearchParams({
    filter: filters.join(","),
    sort,
    per_page: String(PER_PAGE),
    page: String(state.page),
    select: "id,doi,title,publication_date,authorships,primary_location,open_access,abstract_inverted_index,cited_by_count,type,primary_topic",
  });
  if (state.query) params.set("search", state.query);
  return `${OPENALEX}?${params}`;
}

function abstractText(inv) {
  if (!inv) return "";
  const words = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  return words.join(" ").replace(/\s+/g, " ").trim();
}

function authorLine(authorships) {
  const names = (authorships || []).map((a) => a.author?.display_name).filter(Boolean);
  if (!names.length) return "";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} et al.`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function paperItem(w) {
  const doiUrl = w.doi || w.primary_location?.landing_page_url || w.id;
  const source = w.primary_location?.source?.display_name || (w.type === "preprint" ? "Preprint" : "");
  const oaUrl = w.open_access?.is_oa ? w.open_access.oa_url : null;
  const abs = abstractText(w.abstract_inverted_index);
  const title = w.title || "Untitled";
  const scholar = `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`;

  const badges = [];
  badges.push(oaUrl ? `<span class="badge free">Free to read</span>` : `<span class="badge paywall">Subscription</span>`);
  if (w.type === "preprint") badges.push(`<span class="badge">Preprint</span>`);
  if (w.primary_topic?.display_name) badges.push(`<span class="badge">${esc(w.primary_topic.display_name)}</span>`);

  const links = [];
  if (oaUrl) links.push(`<a href="${esc(oaUrl)}" target="_blank" rel="noopener">Read free</a>`);
  links.push(`<a href="${esc(doiUrl)}" target="_blank" rel="noopener">${oaUrl ? "Publisher page" : "Publisher page (library access)"}</a>`);
  links.push(`<a href="${esc(scholar)}" target="_blank" rel="noopener">Google Scholar</a>`);

  const isSaved = Boolean(saved[w.id]);
  return `<li class="item" data-id="${esc(w.id)}">
    <button type="button" class="save" data-save="${esc(w.id)}" aria-pressed="${isSaved}" aria-label="${isSaved ? "Remove from reading list" : "Save to reading list"}" title="${isSaved ? "Remove from reading list" : "Save to reading list"}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
    </button>
    <h3 class="item-title"><a href="${esc(oaUrl || doiUrl)}" target="_blank" rel="noopener">${esc(title)}</a></h3>
    ${w.authorships?.length ? `<p class="byline">${esc(authorLine(w.authorships))}</p>` : ""}
    <p class="meta">${source ? `<span class="journal">${esc(source)}</span>` : ""}<span>${esc(formatDate(w.publication_date))}</span><span>${w.cited_by_count || 0} citations</span></p>
    <div class="badges">${badges.join("")}</div>
    ${abs ? `<details class="abstract"><summary>Abstract</summary><p>${esc(abs)}</p></details>` : ""}
    <div class="links">${links.join("")}</div>
  </li>`;
}

let paperRequest = 0;
const onScreen = new Map(); // id -> work for papers currently listed, so they can be saved

function renderSaved() {
  const list = $("#paper-list");
  const works = Object.values(saved).sort((a, b) => (b.publication_date || "").localeCompare(a.publication_date || ""));
  onScreen.clear();
  works.forEach((w) => onScreen.set(w.id, w));
  list.innerHTML = works.length
    ? works.map(paperItem).join("")
    : `<li class="empty"><strong>Your reading list is empty.</strong>Tap the star on any paper to save it here. The list stays in this browser.</li>`;
  $("#paper-status").textContent = works.length ? `${works.length} saved ${works.length === 1 ? "paper" : "papers"}` : "";
  $("#paper-more").hidden = true;
}

function updateSavedCount() {
  $("#saved-count").textContent = Object.keys(saved).length;
}

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  const browsing = mode !== "saved";
  $("#topic-chips").hidden = !browsing;
  $("#paper-filters").hidden = !browsing;
  $("#paper-search").hidden = !browsing;
  $("#sort-wrap").hidden = mode === "trending";
  if (browsing) loadPapers(); else { paperRequest++; renderSaved(); }
}

async function loadPapers({ append = false } = {}) {
  const status = $("#paper-status");
  const list = $("#paper-list");
  const more = $("#paper-more");
  const id = ++paperRequest;
  if (!append) { state.page = 1; list.innerHTML = ""; onScreen.clear(); }
  status.classList.remove("error");
  status.textContent = append ? "Loading more…" : "Loading papers…";
  more.hidden = true;
  save("atmo.papers", { topic: state.topic, journal: state.journal, ptype: state.ptype, sort: state.sort, oaOnly: state.oaOnly, query: state.query });

  try {
    const res = await fetch(buildUrl());
    if (!res.ok) throw new Error(`OpenAlex answered ${res.status}`);
    const data = await res.json();
    if (id !== paperRequest) return; // a newer search replaced this one
    const results = data.results || [];
    results.forEach((w) => onScreen.set(w.id, w));
    list.insertAdjacentHTML("beforeend", results.map(paperItem).join(""));
    const total = data.meta?.count ?? 0;
    const shown = list.children.length;
    if (!shown) {
      list.innerHTML = `<li class="empty"><strong>No papers match these filters.</strong>Try another topic, remove the journal filter, or turn off "Free to read only".</li>`;
      status.textContent = "";
    } else {
      const what = state.mode === "trending" ? "most-cited papers from the last 60 days" : "papers";
      status.textContent = `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${what}`;
    }
    more.hidden = shown >= total;
  } catch (err) {
    if (id !== paperRequest) return;
    status.classList.add("error");
    status.textContent = `Couldn't load papers (${err.message}). Check your connection and try again.`;
  }
}

function renderTopicChips() {
  $("#topic-chips").innerHTML = TOPICS.map((t) =>
    `<button type="button" class="chip" data-topic="${t.id}" aria-pressed="${t.id === state.topic}">${esc(t.label)}</button>`
  ).join("");
}

function initPapers() {
  renderTopicChips();
  $("#journal").innerHTML = `<option value="">All atmospheric science</option>` +
    JOURNALS.map(([name, issn]) => `<option value="${issn}">${esc(name)}</option>`).join("");
  $("#journal").value = state.journal;
  $("#ptype").value = state.ptype;
  $("#sort").value = state.sort;
  $("#oa-only").checked = state.oaOnly;
  $("#q").value = state.query;

  $("#topic-chips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-topic]");
    if (!btn) return;
    state.topic = btn.dataset.topic;
    renderTopicChips();
    loadPapers();
  });
  $("#paper-search").addEventListener("submit", (e) => {
    e.preventDefault();
    state.query = $("#q").value.trim();
    loadPapers();
  });
  $("#q").addEventListener("search", () => { // fires when the field is cleared
    if (!$("#q").value && state.query) { state.query = ""; loadPapers(); }
  });
  for (const [sel, key] of [["#journal", "journal"], ["#ptype", "ptype"], ["#sort", "sort"]]) {
    $(sel).addEventListener("change", () => { state[key] = $(sel).value; loadPapers(); });
  }
  $("#oa-only").addEventListener("change", () => { state.oaOnly = $("#oa-only").checked; loadPapers(); });
  $("#paper-more").addEventListener("click", () => { state.page += 1; loadPapers({ append: true }); });
  document.querySelector(".modes").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (btn && btn.dataset.mode !== state.mode) setMode(btn.dataset.mode);
  });
  $("#paper-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-save]");
    if (!btn) return;
    const id = btn.dataset.save;
    if (saved[id]) delete saved[id];
    else if (onScreen.has(id)) saved[id] = onScreen.get(id);
    save("atmo.saved", saved);
    updateSavedCount();
    if (state.mode === "saved") { renderSaved(); return; }
    const on = Boolean(saved[id]);
    btn.setAttribute("aria-pressed", String(on));
    btn.title = btn.ariaLabel = on ? "Remove from reading list" : "Save to reading list";
  });
  updateSavedCount();
  setMode("latest");
}

/* ---------- Jobs ---------- */
let jobs = [];
let jobsUpdated = null;

async function fetchJson(path) {
  try {
    const res = await fetch(path, { cache: "no-cache" });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

function daysAgo(iso) {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "Posted today";
  if (days === 1) return "Posted yesterday";
  return `Posted ${days} days ago`;
}

const SECTOR_LABEL = { academia: "Academia", government: "Government & lab", industry: "Industry" };

function jobItem(j) {
  return `<li class="item">
    <h3 class="item-title"><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></h3>
    <p class="byline">${esc(j.employer)}${j.location ? ` · ${esc(j.location)}` : ""}</p>
    <p class="meta"><span>${esc(daysAgo(j.posted))}</span>${j.deadline ? `<span>Apply by ${esc(formatDate(j.deadline))}</span>` : ""}<span>via ${esc(j.source)}</span></p>
    <div class="badges"><span class="badge">${esc(SECTOR_LABEL[j.sector] || "Other")}</span></div>
    ${j.summary ? `<p class="job-summary">${esc(j.summary)}</p>` : ""}
  </li>`;
}

function renderJobs() {
  const q = state.jobQuery.toLowerCase();
  const matchesQuery = (j) => !q || `${j.title} ${j.employer} ${j.location} ${j.summary}`.toLowerCase().includes(q);
  const pool = jobs.filter(matchesQuery);
  const counts = { all: pool.length };
  for (const j of pool) counts[j.sector] = (counts[j.sector] || 0) + 1;

  $("#sector-chips").innerHTML = SECTORS.map((s) =>
    `<button type="button" class="chip" data-sector="${s.id}" aria-pressed="${s.id === state.sector}">${esc(s.label)}<span class="count">${counts[s.id] || 0}</span></button>`
  ).join("");

  const shown = pool.filter((j) => state.sector === "all" || j.sector === state.sector);
  const list = $("#job-list");
  if (!jobs.length) {
    list.innerHTML = `<li class="empty"><strong>No job listings yet.</strong>Listings are collected once a day. Until the first run finishes, use the job boards below.</li>`;
  } else if (!shown.length) {
    list.innerHTML = `<li class="empty"><strong>No jobs match.</strong>Try a different word or sector.</li>`;
  } else {
    list.innerHTML = shown.map(jobItem).join("");
  }
  const when = jobsUpdated ? ` · updated ${new Date(jobsUpdated).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "";
  $("#job-status").textContent = jobs.length ? `${shown.length} of ${jobs.length} listings${when}` : "";
}

async function loadJobs() {
  $("#job-status").textContent = "Loading jobs…";
  const [auto, manual] = await Promise.all([fetchJson("data/jobs.json"), fetchJson("data/jobs-manual.json")]);
  jobsUpdated = auto?.updated || null;
  const seen = new Set();
  jobs = [...(manual?.jobs || []), ...(auto?.jobs || [])].filter((j) => {
    if (!j.url || seen.has(j.url)) return false;
    seen.add(j.url);
    return true;
  });
  jobs.sort((a, b) => (b.posted || "").localeCompare(a.posted || ""));
  renderJobs();
}

function initJobs() {
  $("#sector-chips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sector]");
    if (!btn) return;
    state.sector = btn.dataset.sector;
    renderJobs();
  });
  $("#job-search").addEventListener("submit", (e) => e.preventDefault());
  $("#jq").addEventListener("input", () => { state.jobQuery = $("#jq").value.trim(); renderJobs(); });
}

/* ---------- Funding ---------- */
async function loadGrants() {
  const status = $("#grant-status");
  status.textContent = "Loading funding calls…";
  const data = await fetchJson("data/grants.json");
  const grants = data?.grants || [];
  const list = $("#grant-list");
  if (!grants.length) {
    list.innerHTML = `<li class="empty"><strong>No funding calls yet.</strong>Calls are collected once a day. Until then, use the program pages below.</li>`;
    status.textContent = "";
    return;
  }
  list.innerHTML = grants.map((g) => {
    const closes = g.closeDate ? new Date(g.closeDate + "T12:00:00") : null;
    const days = closes ? Math.ceil((closes - Date.now()) / 86400000) : null;
    const rolling = days !== null && days > 3650; // agencies use far-future dates for standing programs
    const closeText = rolling ? "Rolling deadline" : closes ? `Closes ${formatDate(g.closeDate)}${days >= 0 ? ` (${days} days)` : ""}` : "No close date listed";
    return `<li class="item">
      <h3 class="item-title"><a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.title)}</a></h3>
      <p class="byline">${esc(g.agency)}</p>
      <p class="meta"><span class="${days !== null && days <= 30 ? "soon" : ""}">${esc(closeText)}</span><span>${esc(g.number)}</span></p>
      <div class="badges"><span class="badge">${g.status === "forecasted" ? "Coming soon" : rolling ? "Standing program" : "Open"}</span></div>
    </li>`;
  }).join("");
  const when = data.updated ? ` · updated ${new Date(data.updated).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "";
  status.textContent = `${grants.length} calls${when}`;
}

/* ---------- Conferences ---------- */
async function renderEvents() {
  const data = await fetchJson("data/events.json");
  const events = (data?.events || []).slice().sort((a, b) => a.start.localeCompare(b.start));
  const now = Date.now();
  const fmtRange = (a, b) => {
    const s = new Date(a + "T12:00:00"), e = new Date(b + "T12:00:00");
    const opts = { month: "short", day: "numeric" };
    return `${s.toLocaleDateString(undefined, opts)} to ${e.toLocaleDateString(undefined, { ...opts, year: "numeric" })}`;
  };
  $("#event-list").innerHTML = events.map((ev) => {
    const days = Math.ceil((new Date(ev.start + "T00:00:00") - now) / 86400000);
    const past = new Date(ev.end + "T23:59:59") < now;
    const counter = past ? `<b>✓</b><span>done</span>` : days <= 0 ? `<b>Now</b><span>on</span>` : `<b>${days}</b><span>${days === 1 ? "day" : "days"}</span>`;
    const deadlines = (ev.deadlines || []).filter((d) => new Date(d.date + "T23:59:59") >= now)
      .map((d) => `<span class="soon">${esc(d.label)}: ${esc(formatDate(d.date))}</span>`).join(" · ");
    return `<li class="event${past ? " past" : ""}">
      <div class="countdown">${counter}</div>
      <div>
        <h3>${esc(ev.name)}</h3>
        <p>${esc(fmtRange(ev.start, ev.end))} · ${esc(ev.city)}</p>
        ${deadlines ? `<p>${deadlines}</p>` : ""}
        <div class="links"><a href="${esc(ev.url)}" target="_blank" rel="noopener">Meeting site</a></div>
      </div>
    </li>`;
  }).join("") || `<li class="empty"><strong>No meetings listed.</strong>Add them in data/events.json.</li>`;
}

/* ---------- Social ---------- */
const SOCIAL = [
  { name: "Weather community", note: "Forecasters, chasers and researchers", q: "#wxtwitter OR #wxsky" },
  { name: "Atmospheric science", note: "Research news and new papers", q: "#AtmosphericScience OR #atmosci" },
  { name: "Climate science", note: "Studies, data and commentary", q: "#ClimateScience" },
  { name: "Severe storms", note: "Tornadoes, hail and convection", q: "#severewx" },
  { name: "Tropical cyclones", note: "Hurricanes and typhoons", q: "#tropics hurricane" },
  { name: "Air quality", note: "Pollution, smoke and aerosols", q: "#AirQuality" },
  { name: "Job posts", note: "Postdocs, faculty and industry roles", q: "atmospheric science job OR postdoc" },
  { name: "Conference chatter", note: "AGU, AMS and EGU meetings", q: "#AGU26 OR #AMS2027 OR #EGU27" },
];
const FOLLOW = [
  ["American Meteorological Society", "ametsoc"],
  ["American Geophysical Union", "theAGU"],
  ["European Geosciences Union", "EuroGeosciences"],
  ["NOAA", "NOAA"],
  ["National Weather Service", "NWS"],
  ["NASA Earth", "NASAEarth"],
  ["ECMWF", "ECMWF"],
  ["Met Office", "metoffice"],
  ["World Meteorological Organization", "WMO"],
];

function renderSocial() {
  const x = (q) => `https://x.com/search?q=${encodeURIComponent(q)}&f=live`;
  const li = (q) => `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(q.replace(/ OR /g, " "))}&sortBy=%22date_posted%22`;
  const bsky = (q) => `https://bsky.app/search?q=${encodeURIComponent(q.replace(/ OR /g, " "))}`;
  $("#social-grid").innerHTML = SOCIAL.map((s) => `<div class="social-card">
      <h3>${esc(s.name)}</h3>
      <p>${esc(s.note)}</p>
      <div class="social-links">
        <a class="pill" href="${x(s.q)}" target="_blank" rel="noopener">X</a>
        <a class="pill" href="${li(s.q)}" target="_blank" rel="noopener">LinkedIn</a>
        <a class="pill" href="${bsky(s.q)}" target="_blank" rel="noopener">Bluesky</a>
      </div>
    </div>`).join("");
  $("#follow-list").innerHTML = FOLLOW.map(([name, handle]) => `<li>
      <a href="https://x.com/${handle}" target="_blank" rel="noopener">${esc(name)}</a>
      <span>@${esc(handle)} on X · <a href="https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(name)}" target="_blank" rel="noopener">find on LinkedIn</a></span>
    </li>`).join("");
}

/* ---------- Sky, CO2 and altimeter ---------- */
const SKIES = [
  // [from hour, top, bottom, ink, night?, tagline]
  [0, "#0b1433", "#26315e", "#ffffff", true, "Night shift: the boundary layer is stable and the papers keep coming."],
  [5, "#3b5a99", "#f2a97c", "#ffffff", false, "Dawn: the inversion is lifting. Here's what's new."],
  [8, "#2f86cc", "#a8d8f5", "#ffffff", false, "Clear skies and fresh science, surface to thermosphere."],
  [17, "#3c3f8f", "#f08a5d", "#ffffff", false, "Golden hour: Rayleigh scattering at its finest."],
  [20, "#111a3d", "#3a3f78", "#ffffff", true, "Night shift: the boundary layer is stable and the papers keep coming."],
];
function paintSky() {
  const h = new Date().getHours();
  const sky = [...SKIES].reverse().find(([from]) => h >= from);
  const root = document.documentElement.style;
  root.setProperty("--sky-top", sky[1]);
  root.setProperty("--sky-bottom", sky[2]);
  root.setProperty("--sky-ink", sky[3]);
  $("#sky").classList.toggle("night", sky[4]);
  $("#tagline").textContent = sky[5];
}

async function loadCo2() {
  const data = await fetchJson("data/co2.json");
  if (!data?.ppm) return;
  $("#co2-value").textContent = `${data.ppm.toFixed(2)} ppm`;
  if (data.yearAgo) {
    const d = data.ppm - data.yearAgo;
    $("#co2-delta").textContent = `${d >= 0 ? "+" : ""}${d.toFixed(2)} vs. a year ago`;
  }
  $("#co2").title = `Daily mean for ${data.date}`;
  $("#co2").hidden = false;
}

const LAYERS = [[0, "Troposphere"], [12, "Stratosphere"], [50, "Mesosphere"], [85, "Thermosphere"]];
function updateAltimeter() {
  const max = document.documentElement.scrollHeight - innerHeight;
  const f = max > 0 ? Math.min(1, scrollY / max) : 0;
  const km = Math.round(f * 120);
  // track colors: troposphere 0-10%, stratosphere 10-42%, mesosphere 42-71%, thermosphere 71-100%
  const pos = km <= 12 ? km / 12 * 10 : km <= 50 ? 10 + (km - 12) / 38 * 32 : km <= 85 ? 42 + (km - 50) / 35 * 29 : 71 + (km - 85) / 35 * 29;
  $("#alt-dot").style.bottom = `${pos}%`;
  $("#alt-km").textContent = `${km} km`;
  $("#alt-layer").textContent = [...LAYERS].reverse().find(([k]) => km >= k)[1];
}
addEventListener("scroll", updateAltimeter, { passive: true });

paintSky();
setInterval(paintSky, 10 * 60 * 1000);
loadCo2();
initPapers();
initJobs();
showTab();
