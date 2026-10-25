// The Lapse Rate: papers come live from the OpenAlex API. Jobs, funding calls and the CO2 reading
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

// OpenAlex funder ids; several ids are OR-ed where a funder appears under more than one name.
const FUNDERS = [
  ["", "Any funder"],
  ["F4320306076", "NSF (US)"],
  ["F4320332181", "NOAA (US)"],
  ["F4320306101", "NASA (US)"],
  ["F4320306084|F4320332359", "Department of Energy (US)"],
  ["F4320334678|F4320338335", "European Research Council"],
  ["F4320334631", "NERC (UK)"],
  ["F4320320879", "DFG (Germany)"],
  ["F4320321001", "NSFC (China)"],
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
  { topic: "all", topicId: "", topicLabel: "", funder: "", topOnly: false, intlOnly: false, when: "any", dateFrom: "", dateTo: "", journal: "", ptype: "article|preprint|review", sort: "publication_date:desc", oaOnly: false, query: "" },
  load("atmo.papers", {}),
  { page: 1, mode: "latest", sector: "all", jobQuery: "" }
);
let saved = load("atmo.saved", {}); // OpenAlex id -> work, the viewer's reading list

/* ---------- Tabs ---------- */
const TABS = ["papers", "scientists", "blogs", "legends", "faces", "sky", "charts", "explorer", "jobs", "funding", "events", "resources", "social"];
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
    ({ scientists: initScientists, sky: loadSky, charts: initCharts, jobs: loadJobs, funding: loadGrants, events: renderEvents, resources: renderResources, social: renderSocial, legends: renderLegends, explorer: initExplorer, blogs: renderBlogs, faces: loadFaces })[tab]?.();
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
  const daysBack = (n) => isoDate(new Date(Date.now() - n * 86400000));
  let from = "", to = today();
  if (state.mode === "trending") from = daysBack(365);
  else if (state.when === "custom") {
    from = state.dateFrom;
    if (state.dateTo && state.dateTo < to) to = state.dateTo;
  } else if (state.when !== "any") from = daysBack(Number(state.when));
  filters.push(`to_publication_date:${to}`);
  if (from) filters.push(`from_publication_date:${from}`);
  if (state.oaOnly) filters.push("is_oa:true");
  if (state.topOnly) filters.push("citation_normalized_percentile.is_in_top_10_percent:true");
  if (state.intlOnly) filters.push("countries_distinct_count:>1");
  if (state.funder) filters.push(`funders.id:${state.funder}`);
  if (state.topicId) filters.push(`primary_topic.id:${state.topicId}`);
  const topic = TOPICS.find((t) => t.id === state.topic);
  if (topic?.terms) filters.push(`title_and_abstract.search:${topic.terms.join("|")}`);

  let sort = state.mode === "trending" ? "cited_by_count:desc" : state.sort;
  if (sort === "relevance_score:desc" && !state.query) sort = "publication_date:desc";

  const params = new URLSearchParams({
    filter: filters.join(","),
    sort,
    // Rising fast pulls the 200 most-cited papers of the past year, then ranks them by citations per month
    per_page: String(state.mode === "trending" ? 200 : PER_PAGE),
    page: String(state.page),
    select: WORK_FIELDS,
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

const WORK_FIELDS = "id,doi,title,publication_date,authorships,primary_location,open_access,abstract_inverted_index,cited_by_count,type,primary_topic,biblio,citation_normalized_percentile,countries_distinct_count,institutions_distinct_count,is_retracted,funders";

// Citations per month since publication; the first month counts as one so brand-new papers don't explode.
function citesPerMonth(w) {
  if (!w.publication_date || !w.cited_by_count) return 0;
  const months = Math.max(1, (Date.now() - new Date(w.publication_date + "T12:00:00")) / (30.44 * 86400000));
  return w.cited_by_count / months;
}

/* ---------- Citations ---------- */
function splitName(full) {
  const parts = full.trim().split(/\s+/);
  const last = parts.pop() || "";
  return { last, given: parts };
}
function apaCitation(w) {
  const names = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean).map((n) => {
    const { last, given } = splitName(n);
    return `${last}, ${given.map((g) => g[0] + ".").join(" ")}`.trim().replace(/,$/, "");
  });
  let authors = names.length > 20 ? [...names.slice(0, 19), "…", names[names.length - 1]].join(", ") :
    names.length > 1 ? `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}` : (names[0] || "");
  const year = (w.publication_date || "").slice(0, 4) || "n.d.";
  const b = w.biblio || {};
  const journal = w.primary_location?.source?.display_name || "";
  let tail = journal;
  if (b.volume) tail += `, ${b.volume}`;
  if (b.issue) tail += `(${b.issue})`;
  if (b.first_page) tail += `, ${b.first_page}${b.last_page && b.last_page !== b.first_page ? "–" + b.last_page : ""}`;
  const doi = w.doi ? ` ${w.doi}` : "";
  return `${authors} (${year}). ${w.title || "Untitled"}.${tail ? " " + tail + "." : ""}${doi}`;
}
function bibtexCitation(w) {
  const first = (w.authorships || [])[0]?.author?.display_name || "anon";
  const year = (w.publication_date || "").slice(0, 4);
  const word = ((w.title || "").match(/[A-Za-z]{4,}/) || ["paper"])[0].toLowerCase();
  const key = `${splitName(first).last.toLowerCase().replace(/[^a-z]/g, "")}${year}${word}`;
  const b = w.biblio || {};
  const fields = [
    ["title", `{${w.title || ""}}`],
    ["author", (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean).map((n) => { const { last, given } = splitName(n); return `${last}, ${given.join(" ")}`; }).join(" and ")],
    ["journal", w.primary_location?.source?.display_name],
    ["year", year],
    ["volume", b.volume],
    ["number", b.issue],
    ["pages", b.first_page ? `${b.first_page}${b.last_page && b.last_page !== b.first_page ? "--" + b.last_page : ""}` : ""],
    ["doi", w.doi ? w.doi.replace("https://doi.org/", "") : ""],
  ].filter(([, v]) => v);
  return `@article{${key},\n${fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n")}\n}`;
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
  if (w.is_retracted) badges.push(`<span class="badge retracted">Retracted</span>`);
  const pct = w.citation_normalized_percentile;
  if (pct?.is_in_top_1_percent) badges.push(`<span class="badge top" title="Among the 1% most-cited papers in its field and year">Top 1% in field</span>`);
  else if (pct?.is_in_top_10_percent) badges.push(`<span class="badge top" title="Among the 10% most-cited papers in its field and year">Top 10% in field</span>`);
  badges.push(oaUrl ? `<span class="badge free">Free to read</span>` : `<span class="badge paywall">Subscription</span>`);
  if (w.type === "preprint") badges.push(`<span class="badge">Preprint</span>`);
  if (w.primary_topic?.display_name) badges.push(`<span class="badge">${esc(w.primary_topic.display_name)}</span>`);

  const links = [];
  if (oaUrl) links.push(`<a href="${esc(oaUrl)}" target="_blank" rel="noopener">Read free</a>`);
  links.push(`<a href="${esc(doiUrl)}" target="_blank" rel="noopener">${oaUrl ? "Publisher page" : "Publisher page (library access)"}</a>`);
  links.push(`<a href="${esc(scholar)}" target="_blank" rel="noopener">Google Scholar</a>`);
  links.push(`<button type="button" class="linkbtn" data-cite="${esc(w.id)}" aria-expanded="false">Cite</button>`);

  const isSaved = Boolean(saved[w.id]);
  return `<li class="item" data-id="${esc(w.id)}">
    <button type="button" class="save" data-save="${esc(w.id)}" aria-pressed="${isSaved}" aria-label="${isSaved ? "Remove from reading list" : "Save to reading list"}" title="${isSaved ? "Remove from reading list" : "Save to reading list"}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
    </button>
    <h3 class="item-title"><a href="${esc(oaUrl || doiUrl)}" target="_blank" rel="noopener">${esc(title)}</a></h3>
    ${w.authorships?.length ? `<p class="byline">${esc(authorLine(w.authorships))}</p>` : ""}
    <p class="meta">${source ? `<span class="journal">${esc(source)}</span>` : ""}<span>${esc(formatDate(w.publication_date))}</span><span>${w.cited_by_count || 0} citations</span>${citesPerMonth(w) >= 0.5 ? `<span class="velocity" title="Citations per month since publication">${citesPerMonth(w).toFixed(1)} per month</span>` : ""}${w.countries_distinct_count > 1 ? `<span title="Countries and institutions on the author list">${w.countries_distinct_count} countries · ${w.institutions_distinct_count} institutions</span>` : ""}</p>
    ${w.funders?.length ? `<p class="funders">Funded by ${esc(w.funders.slice(0, 4).map((f) => f.display_name).join(", "))}${w.funders.length > 4 ? ` and ${w.funders.length - 4} more` : ""}</p>` : ""}
    <div class="badges">${badges.join("")}</div>
    ${abs ? `<details class="abstract"><summary>Abstract</summary><p>${esc(abs)}</p></details>` : ""}
    <div class="links">${links.join("")}</div>
    <div class="cite" hidden></div>
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
  $("#when").closest("label").hidden = mode === "trending";
  $("#from-wrap").hidden = $("#to-wrap").hidden = mode === "trending" || state.when !== "custom";
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
  save("atmo.papers", { topicId: state.topicId, topicLabel: state.topicLabel, funder: state.funder, topOnly: state.topOnly, intlOnly: state.intlOnly, topic: state.topic, when: state.when, dateFrom: state.dateFrom, dateTo: state.dateTo, journal: state.journal, ptype: state.ptype, sort: state.sort, oaOnly: state.oaOnly, query: state.query });

  try {
    const res = await fetch(buildUrl());
    if (!res.ok) throw new Error(`OpenAlex answered ${res.status}`);
    const data = await res.json();
    if (id !== paperRequest) return; // a newer search replaced this one
    let results = data.results || [];
    if (state.mode === "trending") results = results.sort((a, b) => citesPerMonth(b) - citesPerMonth(a)).slice(0, 50);
    results.forEach((w) => onScreen.set(w.id, w));
    list.insertAdjacentHTML("beforeend", results.map(paperItem).join(""));
    const total = data.meta?.count ?? 0;
    const shown = list.children.length;
    if (!shown) {
      list.innerHTML = `<li class="empty"><strong>No papers match these filters.</strong>Try another topic, remove the journal filter, or turn off "Free to read only".</li>`;
      status.textContent = "";
    } else if (state.mode === "trending") {
      status.textContent = `The ${shown} papers from the past year gaining citations fastest, ranked by citations per month`;
    } else {
      status.textContent = `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} papers`;
    }
    more.hidden = state.mode === "trending" || shown >= total;
  } catch (err) {
    if (id !== paperRequest) return;
    status.classList.add("error");
    status.textContent = `Couldn't load papers (${err.message}). Check your connection and try again.`;
  }
}

function toggleCite(btn) {
  const item = btn.closest(".item");
  const box = item.querySelector(".cite");
  const open = box.hidden;
  box.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  if (open && !box.innerHTML) {
    const w = onScreen.get(btn.dataset.cite) || saved[btn.dataset.cite];
    if (!w) return;
    box.innerHTML = [["APA", apaCitation(w)], ["BibTeX", bibtexCitation(w)]].map(([label, text]) => `
      <div class="cite-row">
        <div class="cite-head"><span>${label}</span><button type="button" class="linkbtn" data-copy>Copy</button></div>
        <pre>${esc(text)}</pre>
      </div>`).join("");
  }
}
async function copyText(btn) {
  const pre = btn.closest(".cite-row").querySelector("pre");
  try {
    await navigator.clipboard.writeText(pre.textContent);
    btn.textContent = "Copied";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    btn.textContent = "Selected, press Ctrl+C";
  }
  setTimeout(() => { btn.textContent = "Copy"; }, 2000);
}

function renderTopicChips() {
  const custom = state.topicId ? `<button type="button" class="chip" data-clear-topic aria-pressed="true" title="Remove this topic">${esc(state.topicLabel)} ✕</button>` : "";
  $("#topic-chips").innerHTML = custom + TOPICS.map((t) =>
    `<button type="button" class="chip" data-topic="${t.id}" aria-pressed="${!state.topicId && t.id === state.topic}">${esc(t.label)}</button>`
  ).join("");
}

function initPapers() {
  renderTopicChips();
  $("#journal").innerHTML = `<option value="">All atmospheric science</option>` +
    JOURNALS.map(([name, issn]) => `<option value="${issn}">${esc(name)}</option>`).join("");
  $("#journal").value = state.journal;
  $("#when").value = state.when;
  $("#date-from").value = state.dateFrom;
  $("#date-to").value = state.dateTo;
  $("#date-from").max = $("#date-to").max = today();
  const showCustom = () => { $("#from-wrap").hidden = $("#to-wrap").hidden = state.when !== "custom" || state.mode === "trending"; };
  showCustom();
  $("#when").addEventListener("change", () => { state.when = $("#when").value; showCustom(); loadPapers(); });
  for (const [sel, key] of [["#date-from", "dateFrom"], ["#date-to", "dateTo"]]) {
    $(sel).addEventListener("change", () => { state[key] = $(sel).value; loadPapers(); });
  }
  $("#ptype").value = state.ptype;
  $("#sort").value = state.sort;
  $("#oa-only").checked = state.oaOnly;
  $("#top-only").checked = state.topOnly;
  $("#intl-only").checked = state.intlOnly;
  $("#funder").innerHTML = FUNDERS.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join("");
  $("#funder").value = state.funder;
  $("#q").value = state.query;

  $("#topic-chips").addEventListener("click", (e) => {
    if (e.target.closest("[data-clear-topic]")) { state.topicId = state.topicLabel = ""; renderTopicChips(); loadPapers(); return; }
    const btn = e.target.closest("[data-topic]");
    if (!btn) return;
    state.topic = btn.dataset.topic;
    state.topicId = state.topicLabel = "";
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
  $("#top-only").addEventListener("change", () => { state.topOnly = $("#top-only").checked; loadPapers(); });
  $("#intl-only").addEventListener("change", () => { state.intlOnly = $("#intl-only").checked; loadPapers(); });
  $("#funder").addEventListener("change", () => { state.funder = $("#funder").value; loadPapers(); });
  $("#paper-more").addEventListener("click", () => { state.page += 1; loadPapers({ append: true }); });
  document.querySelector(".modes").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (btn && btn.dataset.mode !== state.mode) setMode(btn.dataset.mode);
  });
  document.addEventListener("click", (e) => {
    const citeBtn = e.target.closest("[data-cite]");
    if (citeBtn) { toggleCite(citeBtn); return; }
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) { copyText(copyBtn); return; }
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
  const [auto, manual, web] = await Promise.all([fetchJson("data/jobs.json"), fetchJson("data/jobs-manual.json"), webFinds()]);
  jobsUpdated = auto?.updated || null;
  const webJobs = (web?.items || []).filter((i) => i.tag === "jobs").map((i) => ({
    title: i.title, employer: i.employer || i.domain, location: "", posted: i.published, url: i.url,
    source: `the web (${i.domain})`, sector: i.sector || "industry", summary: i.summary,
  }));
  const seen = new Set();
  jobs = [...(manual?.jobs || []), ...(auto?.jobs || []), ...webJobs].filter((j) => {
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

/* ---------- Web finds (Firehose live crawl, collected by the Action) ---------- */
let webPromise = null;
const webFinds = () => (webPromise ||= fetchJson("data/web.json"));
async function loadWebResearch() {
  const items = ((await webFinds())?.items || []).filter((i) => i.tag === "research" || i.tag === "preprints").slice(0, 8);
  if (!items.length) return;
  $("#web-research-list").innerHTML = items.map((i) => `<li>
      <a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>
      <span>${i.tag === "preprints" ? "Preprint · " : ""}${esc(i.domain)}${i.published ? ` · ${esc(daysAgo(i.published))}` : ""}</span>
    </li>`).join("");
  $("#web-research").hidden = false;
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


/* ---------- Scientists ---------- */
const sci = { author: null, sort: "cited_by_count:desc", page: 1, req: 0 };

function initScientists() {
  $("#sci-search").addEventListener("submit", (e) => { e.preventDefault(); searchScientists($("#sq").value.trim()); });
  $("#sci-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-author]");
    if (btn) openScientist(JSON.parse(btn.dataset.author));
  });
  $("#sci-back").addEventListener("click", () => { $("#sci-detail").hidden = true; $("#sci-list").hidden = false; $("#sci-status").hidden = false; });
  document.querySelector("[data-sci-sort]").parentElement.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sci-sort]");
    if (!btn) return;
    sci.sort = btn.dataset.sciSort;
    for (const b of document.querySelectorAll("[data-sci-sort]")) b.setAttribute("aria-pressed", String(b === btn));
    loadScientistWorks();
  });
  $("#sci-more").addEventListener("click", () => { sci.page += 1; loadScientistWorks(true); });
  $("#sci-list").innerHTML = `<li class="empty"><strong>Look up anyone in the field.</strong>Type a name to see their papers, citation counts and h-index.</li>`;
}

async function searchScientists(q) {
  if (!q) return;
  $("#sci-detail").hidden = true;
  $("#sci-list").hidden = false;
  $("#sci-status").hidden = false;
  $("#sci-status").textContent = "Searching…";
  try {
    const params = new URLSearchParams({ search: q, per_page: "12", select: "id,display_name,works_count,cited_by_count,summary_stats,last_known_institutions,topics" });
    const res = await fetch(`https://api.openalex.org/authors?${params}`);
    if (!res.ok) throw new Error(`OpenAlex answered ${res.status}`);
    const data = await res.json();
    const people = data.results || [];
    $("#sci-status").textContent = people.length ? `${people.length} matches. Pick the right person.` : "";
    $("#sci-list").innerHTML = people.length ? people.map((a) => {
      const inst = a.last_known_institutions?.[0]?.display_name || "";
      const topic = a.topics?.[0]?.display_name || "";
      const brief = { id: a.id, name: a.display_name, inst, topic, works: a.works_count, cites: a.cited_by_count, h: a.summary_stats?.h_index };
      return `<li class="item">
        <h3 class="item-title"><button type="button" class="linkbtn title-btn" data-author='${esc(JSON.stringify(brief))}'>${esc(a.display_name)}</button></h3>
        ${inst ? `<p class="byline">${esc(inst)}</p>` : ""}
        <p class="meta"><span>${(a.works_count || 0).toLocaleString()} papers</span><span>${(a.cited_by_count || 0).toLocaleString()} citations</span>${brief.h != null ? `<span>h-index ${brief.h}</span>` : ""}</p>
        ${topic ? `<p class="job-summary">Main topic: ${esc(topic)}</p>` : ""}
      </li>`;
    }).join("") : `<li class="empty"><strong>No one by that name.</strong>Check the spelling or try just the last name.</li>`;
  } catch (err) {
    $("#sci-status").textContent = `Couldn't search (${err.message}). Try again in a moment.`;
  }
}

function openScientist(a) {
  sci.author = a;
  sci.page = 1;
  $("#sci-list").hidden = true;
  $("#sci-status").hidden = true;
  $("#sci-detail").hidden = false;
  $("#sci-profile").innerHTML = `
    <h2>${esc(a.name)}</h2>
    ${a.inst ? `<p class="byline">${esc(a.inst)}</p>` : ""}
    <dl class="stats">
      <div><dt>Papers</dt><dd>${(a.works || 0).toLocaleString()}</dd></div>
      <div><dt>Citations</dt><dd>${(a.cites || 0).toLocaleString()}</dd></div>
      ${a.h != null ? `<div><dt>h-index</dt><dd>${a.h}</dd></div>` : ""}
    </dl>
    <p class="links"><a href="https://scholar.google.com/scholar?q=${encodeURIComponent('author:"' + a.name + '"')}" target="_blank" rel="noopener">Search on Google Scholar</a><a href="${esc(a.id)}" target="_blank" rel="noopener">OpenAlex profile</a></p>`;
  loadScientistWorks();
  scrollTo({ top: 0 });
}

async function loadScientistWorks(append = false) {
  const id = ++sci.req;
  const list = $("#sci-works");
  if (!append) { list.innerHTML = ""; sci.page = 1; }
  $("#sci-works-status").textContent = "Loading papers…";
  $("#sci-more").hidden = true;
  try {
    const params = new URLSearchParams({
      filter: `author.id:${sci.author.id.split("/").pop()}`,
      sort: sci.sort, per_page: String(PER_PAGE), page: String(sci.page), select: WORK_FIELDS,
    });
    const res = await fetch(`${OPENALEX}?${params}`);
    if (!res.ok) throw new Error(`OpenAlex answered ${res.status}`);
    const data = await res.json();
    if (id !== sci.req) return;
    (data.results || []).forEach((w) => onScreen.set(w.id, w));
    list.insertAdjacentHTML("beforeend", (data.results || []).map(paperItem).join(""));
    const total = data.meta?.count || 0;
    $("#sci-works-status").textContent = `Showing ${list.children.length.toLocaleString()} of ${total.toLocaleString()} papers`;
    $("#sci-more").hidden = list.children.length >= total;
  } catch (err) {
    if (id === sci.req) $("#sci-works-status").textContent = `Couldn't load papers (${err.message}).`;
  }
}

/* ---------- Sky Now ---------- */
const SATELLITES = [
  { name: "GOES-East full disk", note: "Americas and Atlantic", img: "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/FD/GEOCOLOR/1808x1808.jpg", page: "https://www.star.nesdis.noaa.gov/GOES/fulldisk.php?sat=G19" },
  { name: "GOES-West full disk", note: "Pacific and western Americas", img: "https://cdn.star.nesdis.noaa.gov/GOES18/ABI/FD/GEOCOLOR/1808x1808.jpg", page: "https://www.star.nesdis.noaa.gov/GOES/fulldisk.php?sat=G18" },
  { name: "Continental US", note: "GOES-East, GeoColor", img: "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/CONUS/GEOCOLOR/1250x750.jpg", page: "https://www.star.nesdis.noaa.gov/GOES/conus.php?sat=G19" },
];
const STORM_TYPES = { TD: "Tropical Depression", STD: "Subtropical Depression", TS: "Tropical Storm", STS: "Subtropical Storm", HU: "Hurricane", MH: "Major Hurricane", PTC: "Potential Tropical Cyclone", PC: "Post-Tropical Cyclone", TY: "Typhoon" };

function saffirSimpson(kt) {
  if (kt >= 137) return 5;
  if (kt >= 113) return 4;
  if (kt >= 96) return 3;
  if (kt >= 83) return 2;
  if (kt >= 64) return 1;
  return 0;
}

function renderSatellites() {
  const stamp = Math.floor(Date.now() / 600000); // changes every 10 minutes to bust the cache
  $("#sat-grid").innerHTML = SATELLITES.map((s) => `<figure class="sat">
      <a href="${s.page}" target="_blank" rel="noopener"><img src="${s.img}?t=${stamp}" data-fallback="${s.img.replace(/[^/]+$/, "latest.jpg")}?t=${stamp}" alt="Latest ${esc(s.name)} satellite image" loading="lazy"></a>
      <figcaption><b>${esc(s.name)}</b> ${esc(s.note)}</figcaption>
    </figure>`).join("");
  // If a sized image isn't published, fall back to the full-size "latest" file once.
  for (const img of document.querySelectorAll("#sat-grid img")) {
    img.addEventListener("error", () => {
      if (img.dataset.fallback) { img.src = img.dataset.fallback; delete img.dataset.fallback; }
    });
  }
}

async function loadSky() {
  renderSatellites();
  setInterval(renderSatellites, 600000);
  const data = await fetchJson("data/storms.json");
  const storms = data?.storms || [];
  const when = data?.updated ? `Checked ${new Date(data.updated).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "";
  $("#storm-status").textContent = when;
  $("#storm-list").innerHTML = storms.length ? storms.map((st) => {
    const kt = Number(st.intensity) || 0;
    const cat = st.classification === "HU" ? saffirSimpson(kt) : 0;
    const type = STORM_TYPES[st.classification] || st.classification || "Storm";
    const mph = Math.round(kt * 1.15078);
    return `<li class="item">
      <h3 class="item-title">${st.advisoryUrl ? `<a href="${esc(st.advisoryUrl)}" target="_blank" rel="noopener">` : ""}${esc(type)} ${esc(st.name)}${st.advisoryUrl ? "</a>" : ""}</h3>
      <div class="badges">${cat ? `<span class="badge storm">Category ${cat}</span>` : ""}</div>
      <p class="meta"><span>${kt} kt (${mph} mph)</span>${st.pressure ? `<span>${esc(st.pressure)} hPa</span>` : ""}<span>${esc(st.latitude)} ${esc(st.longitude)}</span>${st.movementSpeed ? `<span>Moving ${esc(st.movementDir)}° at ${esc(st.movementSpeed)} mph</span>` : ""}</p>
      <div class="links">${st.graphicsUrl ? `<a href="${esc(st.graphicsUrl)}" target="_blank" rel="noopener">Forecast cone</a>` : ""}${st.advisoryUrl ? `<a href="${esc(st.advisoryUrl)}" target="_blank" rel="noopener">Public advisory</a>` : ""}</div>
    </li>`;
  }).join("") : `<li class="empty"><strong>No active storms right now.</strong>The National Hurricane Center isn't tracking any tropical cyclones in the Atlantic or eastern and central Pacific.</li>`;
}

/* ---------- Datasets and programs ---------- */
const DATASETS = [
  ["ERA5 reanalysis", "ECMWF hourly global reanalysis, 1940 to present", "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels"],
  ["MERRA-2", "NASA GMAO reanalysis with aerosols, 1980 to present", "https://gmao.gsfc.nasa.gov/reanalysis/MERRA-2/"],
  ["GPM IMERG", "Half-hourly global precipitation from satellites", "https://gpm.nasa.gov/data/imerg"],
  ["CMIP6", "Climate model output from modeling centers worldwide", "https://pcmdi.llnl.gov/CMIP6/"],
  ["CERES", "Earth's radiation budget from satellites", "https://ceres.larc.nasa.gov/data/"],
  ["MODIS Atmosphere", "Clouds, aerosols and water vapor from Terra and Aqua", "https://modis-atmosphere.gsfc.nasa.gov/"],
  ["AERONET", "Ground-based aerosol optical depth network", "https://aeronet.gsfc.nasa.gov/"],
  ["ARM", "DOE atmospheric observatories: clouds, radiation, aerosols", "https://www.arm.gov/data"],
  ["IGRA radiosondes", "Global weather balloon soundings", "https://www.ncei.noaa.gov/products/weather-balloon/integrated-global-radiosonde-archive"],
  ["IBTrACS", "Global tropical cyclone best tracks", "https://www.ncei.noaa.gov/products/international-best-track-archive"],
  ["HadCRUT5", "Global surface temperature since 1850", "https://www.metoffice.gov.uk/hadobs/hadcrut5/"],
  ["GOES on AWS", "Full-resolution GOES satellite data, free in the cloud", "https://registry.opendata.aws/noaa-goes/"],
  ["Mauna Loa CO₂", "NOAA's daily and monthly CO₂ records", "https://gml.noaa.gov/ccgg/trends/"],
];
const PROGRAMS = [
  ["MIT", "Earth, Atmospheric and Planetary Sciences", "https://eaps.mit.edu"],
  ["Princeton", "Atmospheric and Oceanic Sciences", "https://aos.princeton.edu"],
  ["University of Washington", "Atmospheric and Climate Science", "https://atmos.uw.edu"],
  ["Colorado State", "Atmospheric Science", "https://www.atmos.colostate.edu"],
  ["University of Oklahoma", "School of Meteorology", "https://www.ou.edu/ags/meteorology"],
  ["Penn State", "Meteorology and Atmospheric Science", "https://www.met.psu.edu"],
  ["UCLA", "Atmospheric and Oceanic Sciences", "https://atmos.ucla.edu"],
  ["UW–Madison", "Atmospheric and Oceanic Sciences", "https://www.aos.wisc.edu"],
  ["University of Utah", "Atmospheric Sciences", "https://atmos.utah.edu"],
  ["University of Maryland", "Atmospheric and Oceanic Science", "https://aosc.umd.edu"],
  ["Stony Brook", "School of Marine and Atmospheric Sciences", "https://www.somas.stonybrook.edu"],
  ["Georgia Tech", "Earth and Atmospheric Sciences", "https://eas.gatech.edu"],
  ["University of Illinois", "Climate, Meteorology and Atmospheric Sciences", "https://climas.illinois.edu"],
  ["University of Chicago", "Geophysical Sciences", "https://geosci.uchicago.edu"],
  ["University of Miami", "Rosenstiel School", "https://earth.miami.edu"],
  ["UC San Diego", "Scripps Institution of Oceanography", "https://scripps.ucsd.edu"],
  ["ETH Zurich", "Institute for Atmospheric and Climate Science", "https://iac.ethz.ch"],
  ["University of Reading", "Department of Meteorology", "https://www.reading.ac.uk/meteorology"],
  ["McGill", "Atmospheric and Oceanic Sciences", "https://www.mcgill.ca/meteo/"],
];

function renderResources() {
  $("#dataset-list").innerHTML = DATASETS.map(([name, note, url]) => `<li><a href="${url}" target="_blank" rel="noopener">${esc(name)}</a><span>${esc(note)}</span></li>`).join("");
  $("#program-list").innerHTML = PROGRAMS.map(([school, dept, url]) => `<li><a href="${url}" target="_blank" rel="noopener">${esc(school)}</a><span>${esc(dept)}</span></li>`).join("");
}

/* ---------- Charts ---------- */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (dec) => { const y = Math.floor(dec); return `${MONTHS[Math.min(11, Math.floor((dec - y) * 12))]} ${y}`; };
const yearLabel = (x) => String(Math.round(x));

const CLIMATE = [
  { key: "co2", title: "Carbon dioxide at Mauna Loa", sub: "Monthly mean, NOAA Global Monitoring Laboratory. The Keeling Curve.", unit: "ppm", dec: 1, label: monthLabel, area: true },
  { key: "temp", title: "Global surface temperature", sub: "Annual anomaly vs. 1951–1980, NASA GISTEMP", unit: "°C", dec: 2, label: yearLabel, zero: true, signed: true },
  { key: "sst", title: "Global sea surface temperature", sub: "Annual anomaly vs. 1961–1990, Met Office HadSST4", unit: "°C", dec: 2, label: yearLabel, zero: true, signed: true },
  { key: "snow", title: "Northern Hemisphere snow cover", sub: "Monthly land snow extent vs. the 1991–2020 average for that month, Rutgers Global Snow Lab", unit: "million km²", dec: 2, label: monthLabel, zero: true, signed: true },
  { key: "ch4", title: "Global methane", sub: "Monthly mean, NOAA Global Monitoring Laboratory", unit: "ppb", dec: 0, label: monthLabel, area: true },
  { key: "seaice", title: "Arctic sea ice in September", sub: "Mean extent in the month of the yearly minimum, NSIDC Sea Ice Index", unit: "million km²", dec: 2, label: yearLabel, area: true, fromZero: true },
  { key: "oni", title: "El Niño and La Niña", sub: "Oceanic Niño Index since 2000. Above +0.5 °C is El Niño, below −0.5 °C is La Niña.", unit: "°C", dec: 1, label: monthLabel, diverging: true, since: 2000, signed: true },
];

function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}
const fmt = (v, dec, signed) => `${signed && v > 0 ? "+" : ""}${v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

// Draws a line, area or bar chart of [[x, y], ...] into `body`, with a hover crosshair and tooltip.
function drawChart(body, pts, opt) {
  const W = Math.max(280, body.clientWidth), H = opt.height || 220;
  const m = { l: 46, r: 14, t: 12, b: 26 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (opt.fromZero || opt.bars || opt.diverging) yMin = Math.min(0, yMin);
  if (opt.diverging) { const a = Math.max(Math.abs(yMin), Math.abs(yMax), 1); yMin = -a; yMax = a; }
  const pad = (yMax - yMin) * 0.06; if (!opt.fromZero && !opt.bars) yMin -= pad; yMax += pad;
  const yt = niceTicks(yMin, yMax, 4);
  yMin = Math.min(yMin, yt[0]); yMax = Math.max(yMax, yt[yt.length - 1]);
  const bw = opt.bars || opt.diverging ? pw / pts.length : 0;
  const X = (x) => m.l + (bw ? (pts.findIndex((p) => p[0] === x) + 0.5) * bw : ((x - xMin) / (xMax - xMin || 1)) * pw);
  const Y = (y) => m.t + (1 - (y - yMin) / (yMax - yMin)) * ph;
  const xt = opt.bars ? pts.filter((_, i) => i % Math.ceil(pts.length / 6) === 0).map((p) => p[0])
    : niceTicks(xMin, xMax, Math.max(3, Math.floor(pw / 90))).filter((v) => v >= xMin && v <= xMax && (xMax - xMin < 4 || v % 1 === 0));

  let marks = "";
  if (opt.bars || opt.diverging) {
    const w = Math.min(24, Math.max(1, bw - (bw > 6 ? 2 : 0)));
    const zero = Y(0);
    marks = pts.map(([x, y]) => {
      const cx = X(x), top = Y(Math.max(0, y)), bot = Y(Math.min(0, y));
      const h = Math.max(0.5, bot - top), r = Math.min(4, w / 2, h);
      const cls = opt.diverging ? (y >= 0 ? "warm" : "cool") : "bar";
      if (r < 1) return `<rect class="${cls}" x="${cx - w / 2}" y="${top}" width="${w}" height="${h}"/>`;
      // rounded at the data end, square at the baseline
      return y >= 0
        ? `<path class="${cls}" d="M${cx - w / 2},${zero} V${top + r} Q${cx - w / 2},${top} ${cx - w / 2 + r},${top} H${cx + w / 2 - r} Q${cx + w / 2},${top} ${cx + w / 2},${top + r} V${zero} Z"/>`
        : `<path class="${cls}" d="M${cx - w / 2},${zero} V${bot - r} Q${cx - w / 2},${bot} ${cx - w / 2 + r},${bot} H${cx + w / 2 - r} Q${cx + w / 2},${bot} ${cx + w / 2},${bot - r} V${zero} Z"/>`;
    }).join("");
  } else {
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join("");
    if (opt.area) marks += `<path class="wash" d="${d}L${X(xMax)},${m.t + ph}L${X(xMin)},${m.t + ph}Z"/>`;
    marks += `<path class="line" d="${d}"/>`;
    const [lx, ly] = pts[pts.length - 1];
    marks += `<circle class="end" cx="${X(lx)}" cy="${Y(ly)}" r="4"/>`;
  }
  const grid = yt.map((v) => `<line class="grid" x1="${m.l}" x2="${m.l + pw}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${fmt(v, Math.abs(v) < 10 && v % 1 ? 1 : 0, opt.signed)}</text>`).join("");
  const zeroLine = (opt.zero || opt.diverging) && yMin < 0 && yMax > 0 ? `<line class="zero" x1="${m.l}" x2="${m.l + pw}" y1="${Y(0)}" y2="${Y(0)}"/>` : "";
  const thresholds = opt.diverging ? [0.5, -0.5].map((v) => `<line class="thresh" x1="${m.l}" x2="${m.l + pw}" y1="${Y(v)}" y2="${Y(v)}"/>`).join("") : "";
  const xticks = xt.map((v) => `<text class="tick" x="${X(v)}" y="${H - 6}" text-anchor="middle">${opt.bars ? v : Math.round(v)}</text>`).join("");

  body.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(opt.title)}">
      ${grid}${zeroLine}${thresholds}${marks}${xticks}
      <line class="cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" visibility="hidden"/>
      <circle class="hover-dot" r="4" visibility="hidden"/>
      <rect class="brush" x="0" y="${m.t}" width="0" height="${ph}" visibility="hidden"/>
      <rect class="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/>
    </svg><div class="tip" hidden></div>`;

  const svg = body.querySelector("svg"), tip = body.querySelector(".tip");
  const cross = svg.querySelector(".cross"), dot = svg.querySelector(".hover-dot");
  const show = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const dd = Math.abs(X(p[0]) - px); if (dd < bd) { bd = dd; best = i; } });
    const [x, y] = pts[best];
    const cx = X(x), cy = Y(y);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    if (!opt.bars && !opt.diverging) { dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("visibility", "visible"); }
    tip.innerHTML = `<b>${fmt(y, opt.dec, opt.signed)} ${esc(opt.unit)}</b><span>${esc(opt.label(x))}</span>`;
    tip.hidden = false;
    const left = (cx / W) * rect.width;
    tip.style.left = `${Math.min(Math.max(left, 60), rect.width - 60)}px`;
    tip.style.top = `${(cy / H) * rect.height}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
  const hit = svg.querySelector(".hit");
  const brush = svg.querySelector(".brush");
  const toPx = (ev) => { const r = svg.getBoundingClientRect(); return Math.min(m.l + pw, Math.max(m.l, ((ev.clientX - r.left) / r.width) * W)); };
  // x value under a pixel: nearest point for bars, continuous scale for lines
  const toX = (px) => bw ? pts[Math.min(pts.length - 1, Math.max(0, Math.floor((px - m.l) / bw)))][0] : xMin + ((px - m.l) / pw) * (xMax - xMin);
  let drag = null;
  hit.addEventListener("pointerdown", (ev) => {
    show(ev);
    if (!opt.onZoom) return;
    drag = toPx(ev);
    hit.setPointerCapture(ev.pointerId);
  });
  hit.addEventListener("pointermove", (ev) => {
    if (drag === null) { show(ev); return; }
    const px = toPx(ev);
    brush.setAttribute("x", Math.min(drag, px)); brush.setAttribute("width", Math.abs(px - drag)); brush.setAttribute("visibility", "visible");
    hide();
  });
  hit.addEventListener("pointerup", (ev) => {
    if (drag === null) return;
    const px = toPx(ev), start = drag;
    drag = null;
    brush.setAttribute("visibility", "hidden");
    if (Math.abs(px - start) > 10) {
      const a = toX(Math.min(px, start)), b = toX(Math.max(px, start));
      if (pts.filter((p) => p[0] >= a && p[0] <= b).length >= 3) opt.onZoom(a, b);
    }
  });
  hit.addEventListener("pointerleave", () => { if (drag === null) hide(); });
  hit.addEventListener("dblclick", () => opt.onZoom?.(null, null));
}

// Renders a chart with range buttons and drag-to-zoom. `ranges` are spans in x units (years).
function zoomable(fig, body, pts, opt) {
  const span = pts[pts.length - 1][0] - pts[0][0];
  const ranges = [[0, "All"], [50, "50 yr"], [20, "20 yr"], [10, "10 yr"], [5, "5 yr"], [2, "2 yr"]].filter(([r]) => r === 0 || r < span * 0.8);
  let controls = fig.querySelector(".zoombar");
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "zoombar";
    body.before(controls);
  }
  const end = pts[pts.length - 1][0];
  let view = opt.initial && ranges.some(([r]) => r === opt.initial) ? Object.assign([end - opt.initial, end], { preset: opt.initial }) : null; // [x0, x1] or null for everything
  const render = () => {
    const shown = view ? pts.filter((p) => p[0] >= view[0] && p[0] <= view[1]) : pts;
    controls.innerHTML = ranges.map(([r, label]) => {
      const on = r === 0 ? !view : view && view.preset === r;
      return `<button type="button" class="zoom-btn" data-range="${r}" aria-pressed="${Boolean(on)}">${label}</button>`;
    }).join("") + (view && !view.preset ? `<button type="button" class="zoom-btn" data-range="0">Reset zoom</button>` : "") +
      `<span class="zoom-hint">Drag across the chart to zoom</span>`;
    (opt.draw || drawChart)(body, shown, { ...opt, onZoom: (a, b) => { view = a === null ? null : [a, b]; render(); } });
  };
  controls.onclick = (e) => {
    const btn = e.target.closest("[data-range]");
    if (!btn) return;
    const r = Number(btn.dataset.range);
    view = r ? Object.assign([end - r, end], { preset: r }) : null;
    render();
  };
  render();
}

function chartTable(pts, opt) {
  const rows = pts.slice().reverse().map(([x, y]) => `<tr><td>${esc(opt.label(x))}</td><td>${fmt(y, opt.dec, opt.signed)}</td></tr>`).join("");
  return `<details class="chart-table"><summary>Data table</summary><div class="table-scroll"><table><thead><tr><th>Date</th><th>${esc(opt.unit)}</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

let climateData = null;
function renderClimate() {
  const wrap = $("#climate-charts");
  if (!climateData) return;
  const series = climateData.series || {};
  const defs = CLIMATE.filter((c) => series[c.key]?.length);
  if (!defs.length) {
    wrap.innerHTML = `<p class="empty"><strong>Charts are on their way.</strong>The climate records are collected every 6 hours; check back shortly.</p>`;
    return;
  }
  wrap.innerHTML = defs.map((c) => `<figure class="chart" id="chart-${c.key}">
      <div class="chart-head">
        <div><h2 class="chart-title">${esc(c.title)}</h2><p class="chart-sub">${esc(c.sub)}</p></div>
        <div class="chart-stat" id="stat-${c.key}"></div>
      </div>
      <div class="chart-body"></div>
      <div class="chart-foot"></div>
    </figure>`).join("");
  for (const c of defs) {
    let pts = series[c.key];
    if (c.since) pts = pts.filter((p) => p[0] >= c.since);
    const fig = $(`#chart-${c.key}`);
    const [lx, ly] = pts[pts.length - 1];
    $(`#stat-${c.key}`).innerHTML = `<b>${fmt(ly, c.dec, c.signed)}</b> ${esc(c.unit)}<span>${esc(c.label(lx))}</span>`;
    zoomable(fig, fig.querySelector(".chart-body"), pts, c);
    fig.querySelector(".chart-foot").innerHTML = chartTable(pts, c);
  }
}

let pubsData = null;
async function loadPubs() {
  const body = $("#pubs-body");
  body.innerHTML = `<p class="status">Loading…</p>`;
  const topic = TOPICS.find((t) => t.id === $("#pubs-topic").value);
  const thisYear = new Date().getFullYear();
  const filters = [`primary_topic.subfield.id:${ATMOS_SUBFIELD}`, "type:article|preprint|review", `publication_year:${thisYear - 25}-${thisYear - 1}`];
  if (topic?.terms) filters.push(`title_and_abstract.search:${topic.terms.join("|")}`);
  try {
    const res = await fetch(`${OPENALEX}?${new URLSearchParams({ filter: filters.join(","), group_by: "publication_year" })}`);
    if (!res.ok) throw new Error(`OpenAlex answered ${res.status}`);
    const data = await res.json();
    pubsData = (data.group_by || []).map((g) => [Number(g.key), g.count]).filter(([y]) => y >= thisYear - 25 && y < thisYear).sort((a, b) => a[0] - b[0]);
    drawPubs();
  } catch (err) {
    body.innerHTML = `<p class="status error">Couldn't load the chart (${esc(err.message)}).</p>`;
  }
}
function drawPubs() {
  if (!pubsData?.length) return;
  drawChart($("#pubs-body"), pubsData, { title: "Papers per year", unit: "papers", dec: 0, label: yearLabel, bars: true, height: 240 });
}

// Opens the Papers tab filtered to one OpenAlex topic.
function browseTopic(id, label) {
  Object.assign(state, { topicId: id, topicLabel: label, topic: "all" });
  renderTopicChips();
  location.hash = "#papers";
  setMode("latest");
  scrollTo({ top: 0 });
}

async function loadEmerging() {
  const list = $("#emerging-list");
  list.innerHTML = `<li class="status">Loading…</li>`;
  const day = (n) => isoDate(new Date(Date.now() - n * 86400000));
  // Skip the most recent two months, which are still being indexed.
  const periods = [[day(425), day(60)], [day(790), day(425)]];
  try {
    const [recent, before] = await Promise.all(periods.map(async ([from, to]) => {
      const filter = `primary_topic.subfield.id:${ATMOS_SUBFIELD},type:article|preprint|review,from_publication_date:${from},to_publication_date:${to}`;
      const res = await fetch(`${OPENALEX}?${new URLSearchParams({ filter, group_by: "primary_topic.id" })}`);
      if (!res.ok) throw new Error(`OpenAlex answered ${res.status}`);
      return (await res.json()).group_by || [];
    }));
    const prev = new Map(before.map((g) => [g.key, g.count]));
    const rows = recent
      .filter((g) => (prev.get(g.key) || 0) >= 100)
      .map((g) => ({ id: g.key.split("/").pop(), name: g.key_display_name, now: g.count, was: prev.get(g.key), growth: g.count / prev.get(g.key) - 1 }))
      .sort((a, b) => b.growth - a.growth)
      .slice(0, 10);
    if (!rows.length) { list.innerHTML = `<li class="status">Not enough data yet.</li>`; return; }
    const maxG = Math.max(...rows.map((r) => Math.abs(r.growth)), 0.01);
    list.innerHTML = rows.map((r) => `<li>
        <button type="button" class="emerging-row" data-topic-id="${esc(r.id)}" data-topic-name="${esc(r.name)}">
          <span class="emerging-name">${esc(r.name)}</span>
          <span class="emerging-bar"><span class="${r.growth >= 0 ? "up" : "down"}" style="width:${Math.max(2, (Math.abs(r.growth) / maxG) * 100)}%"></span></span>
          <span class="emerging-val">${r.growth >= 0 ? "+" : "−"}${Math.abs(r.growth * 100).toFixed(0)}%</span>
          <span class="emerging-count">${r.was.toLocaleString()} → ${r.now.toLocaleString()} papers</span>
        </button>
      </li>`).join("");
  } catch (err) {
    list.innerHTML = `<li class="status error">Couldn't load topics (${esc(err.message)}).</li>`;
  }
}

function initCharts() {
  loadEmerging();
  $("#emerging-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-topic-id]");
    if (b) browseTopic(b.dataset.topicId, b.dataset.topicName);
  });
  $("#pubs-topic").innerHTML = TOPICS.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join("");
  $("#pubs-topic").addEventListener("change", loadPubs);
  fetchJson("data/climate.json").then((d) => { climateData = d || { series: {} }; renderClimate(); });
  initDaily();
  fetchJson("data/drought.json").then((d) => { droughtData = d; renderDrought(); });
  loadPubs();
  let t;
  addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (!$("#view-charts").hidden) { renderClimate(); drawSstDaily(); renderDrought(); drawPubs(); } }, 150); });
}

/* ---------- Daily sea surface temperature, one line per year ---------- */
const DAILY = [
  { key: "sst", file: "data/sst_daily.json", name: "Sea surface temperature", title: "Daily sea surface temperature, every year", sub: "World ocean 60°S–60°N, NOAA OISST v2.1 via Climate Reanalyzer. Each gray line is a past year.", unit: "°C", dec: 2 },
  { key: "t2", file: "data/t2_daily.json", name: "Air temperature", title: "Daily global air temperature, every year", sub: "World average temperature 2 m above the surface, ERA5 via Climate Reanalyzer. Each gray line is a past year.", unit: "°C", dec: 2 },
  { key: "icen", file: "data/seaice_n_daily.json", name: "Arctic sea ice", title: "Daily Arctic sea ice extent, every year", sub: "NSIDC Sea Ice Index. The yearly low comes in September. Each gray line is a past year.", unit: "million km²", dec: 2 },
  { key: "ices", file: "data/seaice_s_daily.json", name: "Antarctic sea ice", title: "Daily Antarctic sea ice extent, every year", sub: "NSIDC Sea Ice Index. The yearly low comes in February. Each gray line is a past year.", unit: "million km²", dec: 2 },
];
const dailyData = {};
let dailyKey = "sst", sstDaily = null, dailyDef = DAILY[0];
function initDaily() {
  $("#daily-picker").addEventListener("click", (e) => {
    const b = e.target.closest("[data-daily]");
    if (b) { dailyKey = b.dataset.daily; pickDaily(); }
  });
  DAILY.forEach((d) => fetchJson(d.file).then((data) => { if (data?.years) { dailyData[d.key] = data; pickDaily(); } }));
}
function pickDaily() {
  const ready = DAILY.filter((d) => dailyData[d.key]);
  if (!ready.length) return;
  if (!dailyData[dailyKey]) dailyKey = ready[0].key;
  dailyDef = DAILY.find((d) => d.key === dailyKey);
  sstDaily = dailyData[dailyKey];
  $("#daily-picker").innerHTML = ready.length > 1 ? ready.map((d) => `<button type="button" data-daily="${d.key}" aria-pressed="${d.key === dailyKey}">${esc(d.name)}</button>`).join("") : "";
  $("#sst-daily-title").textContent = dailyDef.title;
  $("#sst-daily-sub").textContent = dailyDef.sub;
  drawSstDaily();
}
function drawSstDaily() {
  const fig = $("#sst-daily"), body = $("#sst-daily-body");
  const { unit, dec } = dailyDef;
  const years = Object.keys(sstDaily?.years || {}).sort();
  if (!years.length) return;
  fig.hidden = false;
  const clean = (arr) => arr.map((v, i) => [i + 1, v]).filter(([, v]) => v !== null && v !== undefined && !Number.isNaN(v));
  const series = years.map((y) => ({ year: y, pts: clean(sstDaily.years[y]) })).filter((s) => s.pts.length);
  const cur = series[series.length - 1], prev = series[series.length - 2];
  const clim = sstDaily.climatology?.data ? clean(sstDaily.climatology.data) : [];
  const W = Math.max(280, body.clientWidth), H = 280;
  const m = { l: 46, r: 14, t: 12, b: 26 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const all = series.flatMap((s) => s.pts.map((p) => p[1])).concat(clim.map((p) => p[1]));
  let yMin = Math.min(...all), yMax = Math.max(...all);
  const yt0 = niceTicks(yMin, yMax, 4), st = yt0.length > 1 ? yt0[1] - yt0[0] : 1;
  yMin = Math.floor(yMin / st) * st; yMax = Math.ceil(yMax / st) * st;
  const yt = niceTicks(yMin, yMax, 4);
  const X = (d) => m.l + ((d - 1) / 365) * pw, Y = (v) => m.t + (1 - (v - yMin) / (yMax - yMin)) * ph;
  const path = (pts) => pts.map(([d, v], i) => `${i ? "L" : "M"}${X(d).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const starts = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const grid = yt.map((v) => `<line class="grid" x1="${m.l}" x2="${m.l + pw}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${fmt(v, v % 1 ? 1 : 0)}</text>`).join("");
  const xt = starts.filter((_, i) => pw > 500 || i % 2 === 0).map((d) => `<text class="tick" x="${X(d + 14)}" y="${H - 6}" text-anchor="middle">${MONTHS[starts.indexOf(d)]}</text>`).join("");
  const past = series.filter((s) => s !== cur && s !== prev).map((s) => `<path class="spag" d="${path(s.pts)}"/>`).join("");
  const climLine = clim.length ? `<path class="spag-clim" d="${path(clim)}"/>` : "";
  body.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(dailyDef.title)}">
      ${grid}${past}${climLine}${prev ? `<path class="spag-prev" d="${path(prev.pts)}"/>` : ""}<path class="line" d="${path(cur.pts)}"/>${xt}
      <line class="cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" visibility="hidden"/>
      <rect class="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/>
    </svg><div class="tip" hidden></div>`;
  const [ld, lv] = cur.pts[cur.pts.length - 1];
  const dayName = (d) => { const i = starts.filter((s) => s <= d).length - 1; return `${MONTHS[i]} ${d - starts[i] + 1}`; };
  $("#sst-daily-stat").innerHTML = `<b>${lv.toFixed(dec)}</b> ${esc(unit)}<span>${esc(dayName(ld))}, ${cur.year}</span>`;
  $("#sst-daily-legend").innerHTML = `<span><i class="k-cur"></i>${cur.year}</span>${prev ? `<span><i class="k-prev"></i>${prev.year}</span>` : ""}<span><i class="k-past"></i>${series[0].year}–${(prev || cur).year - 1}</span>${clim.length ? `<span><i class="k-clim"></i>${esc(sstDaily.climatology.name || "Average")}</span>` : ""}`;
  const svg = body.querySelector("svg"), tip = body.querySelector(".tip"), cross = svg.querySelector(".cross"), hit = svg.querySelector(".hit");
  const at = (s, d) => s?.pts.find((p) => p[0] === d)?.[1];
  hit.addEventListener("pointermove", (ev) => {
    const r = svg.getBoundingClientRect();
    const d = Math.min(366, Math.max(1, Math.round(((ev.clientX - r.left) / r.width * W - m.l) / pw * 365 + 1)));
    cross.setAttribute("x1", X(d)); cross.setAttribute("x2", X(d)); cross.setAttribute("visibility", "visible");
    const rows = [[cur.year, at(cur, d)], [prev?.year, at(prev, d)], ["Average", clim.find((p) => p[0] === d)?.[1]]].filter(([, v]) => v !== undefined);
    tip.innerHTML = `<span>${esc(dayName(d))}</span>` + rows.map(([k, v]) => `<b>${k}: ${v.toFixed(dec)} ${esc(unit)}</b>`).join("");
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max((X(d) / W) * r.width, 70), r.width - 70)}px`;
    tip.style.top = `${(m.t + 10) / H * r.height}px`;
  });
  hit.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
}

/* ---------- US drought, stacked by severity ---------- */
const DROUGHT_LEVELS = [
  ["D0", "Abnormally dry"], ["D1", "Moderate drought"], ["D2", "Severe drought"], ["D3", "Extreme drought"], ["D4", "Exceptional drought"],
];
let droughtData = null;
const decYear = (iso) => { const d = new Date(iso + "T12:00:00Z"), y = d.getUTCFullYear(); return y + (d - Date.UTC(y, 0, 1)) / (365.25 * 86400000); };
function renderDrought() {
  const weeks = droughtData?.weeks;
  if (!weeks?.length) return;
  const fig = $("#drought");
  fig.hidden = false;
  const pts = weeks.map((w) => [decYear(w[0]), ...w.slice(1), w[0]]);
  const last = weeks[weeks.length - 1];
  $("#drought-stat").innerHTML = `<b>${last[2].toFixed(0)}%</b> in drought<span>Week of ${esc(formatDate(last[0]))}</span>`;
  $("#drought-legend").innerHTML = DROUGHT_LEVELS.map(([k, n], i) => `<span><i class="sw d${i}"></i>${k} ${esc(n)}</span>`).join("");
  zoomable(fig, $("#drought-body"), pts, { title: "US drought", draw: drawStack, initial: 10 });
}
// Stacked area of cumulative percentages [x, D0, D1, D2, D3, D4, isoDate]; each band is "this level or worse".
function drawStack(body, pts, opt) {
  const W = Math.max(280, body.clientWidth), H = 240;
  const m = { l: 40, r: 14, t: 12, b: 26 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const xMin = pts[0][0], xMax = pts[pts.length - 1][0];
  const X = (x) => m.l + ((x - xMin) / (xMax - xMin || 1)) * pw, Y = (v) => m.t + (1 - v / 100) * ph;
  const bands = [1, 2, 3, 4, 5].map((k, i) => {
    const top = pts.map((p) => `${X(p[0]).toFixed(1)},${Y(p[k]).toFixed(1)}`).join("L");
    return `<path class="band d${i}" d="M${top}L${X(xMax)},${Y(0)}L${X(xMin)},${Y(0)}Z"/>`;
  }).join("");
  const grid = [0, 25, 50, 75, 100].map((v) => `<line class="grid" x1="${m.l}" x2="${m.l + pw}" y1="${Y(v)}" y2="${Y(v)}"/><text class="tick" x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${v}%</text>`).join("");
  const xt = niceTicks(xMin, xMax, Math.max(3, Math.floor(pw / 90))).filter((v) => v >= xMin && v <= xMax && (xMax - xMin < 4 || v % 1 === 0))
    .map((v) => `<text class="tick" x="${X(v)}" y="${H - 6}" text-anchor="middle">${Math.round(v)}</text>`).join("");
  body.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(opt.title)}">
      ${bands}${grid}${xt}
      <line class="cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" visibility="hidden"/>
      <rect class="brush" x="0" y="${m.t}" width="0" height="${ph}" visibility="hidden"/>
      <rect class="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}"/>
    </svg><div class="tip" hidden></div>`;
  const svg = body.querySelector("svg"), tip = body.querySelector(".tip"), cross = svg.querySelector(".cross");
  const hit = svg.querySelector(".hit"), brush = svg.querySelector(".brush");
  const toPx = (ev) => { const r = svg.getBoundingClientRect(); return Math.min(m.l + pw, Math.max(m.l, ((ev.clientX - r.left) / r.width) * W)); };
  const toX = (px) => xMin + ((px - m.l) / pw) * (xMax - xMin);
  const show = (ev) => {
    const x = toX(toPx(ev)), r = svg.getBoundingClientRect();
    const p = pts.reduce((a, b) => (Math.abs(b[0] - x) < Math.abs(a[0] - x) ? b : a));
    cross.setAttribute("x1", X(p[0])); cross.setAttribute("x2", X(p[0])); cross.setAttribute("visibility", "visible");
    tip.innerHTML = `<span>Week of ${esc(formatDate(p[6]))}</span>` + DROUGHT_LEVELS.map(([k], i) => `<b>${k}${i < 4 ? "+" : ""}: ${p[i + 1].toFixed(0)}%</b>`).reverse().join("");
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max((X(p[0]) / W) * r.width, 70), r.width - 70)}px`;
    tip.style.top = `${((m.t + ph * 0.6) / H) * r.height}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); };
  let drag = null;
  hit.addEventListener("pointerdown", (ev) => { show(ev); drag = toPx(ev); hit.setPointerCapture(ev.pointerId); });
  hit.addEventListener("pointermove", (ev) => {
    if (drag === null) { show(ev); return; }
    const px = toPx(ev);
    brush.setAttribute("x", Math.min(drag, px)); brush.setAttribute("width", Math.abs(px - drag)); brush.setAttribute("visibility", "visible");
    hide();
  });
  hit.addEventListener("pointerup", (ev) => {
    if (drag === null) return;
    const px = toPx(ev), start = drag;
    drag = null;
    brush.setAttribute("visibility", "hidden");
    if (Math.abs(px - start) > 10) opt.onZoom(toX(Math.min(px, start)), toX(Math.max(px, start)));
  });
  hit.addEventListener("pointerleave", () => { if (drag === null) hide(); });
  hit.addEventListener("dblclick", () => opt.onZoom(null, null));
}

/* ---------- Explorer: climate indices ---------- */
const INDICES = [
  { key: "qbo", name: "QBO", title: "Quasi-Biennial Oscillation", sub: "Equatorial zonal wind at 30 hPa, NOAA PSL", unit: "m/s", dec: 1, diverging: true,
    about: "High above the equator, the stratospheric winds flip between easterly and westerly roughly every 28 months, a rhythm driven by waves rising from below. In 2016 and again in 2020 it skipped a beat for the first time on record. Isaac Held wrote about it in his blog post “Odd recent evolution of the QBO” (see the Blogs tab)." },
  { key: "nino34", name: "Niño 3.4", title: "Niño 3.4 sea surface temperature anomaly", sub: "Monthly anomaly in the central equatorial Pacific, NOAA PSL", unit: "°C", dec: 2, diverging: true,
    about: "The ocean thermometer behind El Niño forecasts. Warm anomalies mean El Niño, cold anomalies mean La Niña, and both reshape weather around the world." },
  { key: "soi", name: "SOI", title: "Southern Oscillation Index", sub: "Tahiti minus Darwin sea level pressure, standardized, NOAA PSL", unit: "", dec: 1, diverging: true,
    about: "The atmospheric half of ENSO, measured with two barometers on opposite sides of the Pacific. Strongly negative values go with El Niño. Gilbert Walker found it in the 1920s while trying to forecast the Indian monsoon." },
  { key: "nao", name: "NAO", title: "North Atlantic Oscillation", sub: "Monthly index, NOAA PSL", unit: "", dec: 2, diverging: true,
    about: "The seesaw of pressure between Iceland and the Azores. Positive phases bring mild, stormy winters to northern Europe; negative phases let cold air spill south." },
  { key: "ao", name: "AO", title: "Arctic Oscillation", sub: "Monthly index, NOAA PSL", unit: "", dec: 2, diverging: true,
    about: "How tightly the polar vortex is wound. A negative AO means a wavier jet stream and more cold outbreaks into the mid-latitudes." },
  { key: "pdo", name: "PDO", title: "Pacific Decadal Oscillation", sub: "Monthly index, NOAA PSL", unit: "", dec: 2, diverging: true,
    about: "A slow, decades-long pattern of North Pacific sea surface temperature. It was first named in 1997 by a fisheries scientist trying to explain salmon catches." },
  { key: "amo", name: "AMO", title: "Atlantic Multidecadal Oscillation", sub: "Monthly North Atlantic sea surface temperature anomaly, NOAA PSL (no longer updated after early 2023)", unit: "°C", dec: 2, zero: true, signed: true,
    about: "Long swings in North Atlantic ocean temperature, linked to Sahel rainfall and Atlantic hurricane activity. Whether it is a true oscillation is still argued about." },
  { key: "sunspots", name: "Sunspots", title: "Sunspot number", sub: "Monthly mean total sunspot number, SILSO, Royal Observatory of Belgium", unit: "spots", dec: 0, area: true, fromZero: true,
    about: "The Sun's 11-year cycle, counted since 1749. Solar maximum brings more ultraviolet light, a puffier upper atmosphere and brighter aurora." },
];
let indexData = null, indexKey = "qbo";
function initExplorer() {
  $("#index-picker").addEventListener("click", (e) => {
    const b = e.target.closest("[data-index]");
    if (b) { indexKey = b.dataset.index; renderExplorer(); }
  });
  fetchJson("data/indices.json").then((d) => { indexData = d?.series || {}; renderExplorer(); });
  let t;
  addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (!$("#view-explorer").hidden) renderExplorer(); }, 150); });
}
function renderExplorer() {
  if (!indexData) return;
  const defs = INDICES.filter((d) => indexData[d.key]?.length);
  if (!defs.length) {
    $("#index-chart").innerHTML = `<p class="empty"><strong>The indices are on their way.</strong>They are collected every 6 hours; check back shortly.</p>`;
    return;
  }
  if (!defs.some((d) => d.key === indexKey)) indexKey = defs[0].key;
  const def = defs.find((d) => d.key === indexKey);
  $("#index-picker").innerHTML = defs.map((d) => `<button type="button" data-index="${d.key}" aria-pressed="${d.key === indexKey}">${esc(d.name)}</button>`).join("");
  const pts = indexData[def.key];
  const opt = { ...def, label: monthLabel, signed: def.signed ?? def.diverging, height: 260 };
  $("#index-title").textContent = def.title;
  $("#index-sub").textContent = def.sub;
  const [lx, ly] = pts[pts.length - 1];
  $("#index-stat").innerHTML = `<b>${fmt(ly, def.dec, opt.signed)}</b> ${esc(def.unit)}<span>${esc(monthLabel(lx))}</span>`;
  $("#index-about").textContent = def.about;
  const fig = $("#index-chart");
  fig.querySelector(".zoombar")?.remove();
  // Long monthly records are hard to read in full, so start on the last 20 years.
  zoomable(fig, $("#index-body"), pts, { ...opt, diverging: false, zero: true, initial: 20 });
}

/* ---------- Blogs ---------- */
const BLOGS = [
  { who: "Kerry Emanuel", where: "MIT", title: "Essays in Boston Review", url: "https://www.bostonreview.net/authors/kerry-emanuel/", star: true,
    note: "The hurricane scientist on climate risk, written with the dry wit of someone who has explained it to Congress more than once. “There is a lot we don't know about climate change, but what we do know should motivate us to action.”" },
  { who: "Kerry Emanuel", where: "MIT", title: "Climate Science, Risk & Solutions", url: "https://climateprimer.mit.edu/", star: true,
    note: "His free primer for everyone: the whole climate story, start to finish, in plain language." },
  { who: "Kerry Emanuel", where: "MIT", title: "10 Years Since Katrina: The Climate Connection Is Clear", url: "https://www.livescience.com/51960-10-years-since-katrina-the-climate-connection-is-clear.html", star: true,
    note: "An op-ed on what Katrina taught us, from the person who wrote the book on hurricane intensity (literally: Divine Wind)." },
  { who: "Eric Berger and Matt Lanza", where: "Houston", title: "Space City Weather", url: "https://spacecityweather.com/",
    note: "Hype-free Houston forecasts with jokes. Their post titles read like “Suntober continues for a bit longer, along with a bit more humidity.”" },
  { who: "Isaac Held", where: "NOAA GFDL / Princeton", title: "Isaac Held's Blog", url: "https://www.gfdl.noaa.gov/blog/isaac-held/",
    note: "Numbered posts on climate dynamics from one of the field's sharpest thinkers. Try #72, “Odd recent evolution of the QBO,” then look at the QBO in the Explorer tab." },
  { who: "Cliff Mass", where: "University of Washington", title: "Cliff Mass Weather Blog", url: "https://cliffmass.blogspot.com/",
    note: "Pacific Northwest weather explained, with strong opinions and boundless enthusiasm for the next windstorm." },
  { who: "Daniel Swain", where: "California", title: "Weather West", url: "https://weatherwest.com/",
    note: "California's droughts, atmospheric rivers and weather whiplash, explained by someone who studies all three." },
  { who: "Andrew Dessler and Zeke Hausfather", where: "Texas A&M / Berkeley Earth", title: "The Climate Brink", url: "https://www.theclimatebrink.com/",
    note: "Two climate scientists check the latest numbers, and the latest bad takes, against the data." },
  { who: "Gavin Schmidt, Michael Mann and others", where: "", title: "RealClimate", url: "https://www.realclimate.org/",
    note: "Climate science from climate scientists since 2004. Famous for patient, very thorough rebuttals in the comments." },
  { who: "J. Marshall Shepherd", where: "University of Georgia", title: "Forbes column", url: "https://www.forbes.com/sites/marshallshepherd/",
    note: "A former AMS president on weather, climate and why your weather app is not lying to you, exactly." },
  { who: "Jeff Masters and Bob Henson", where: "Yale Climate Connections", title: "Eye on the Storm", url: "https://yaleclimateconnections.org/topic/eye-on-the-storm/",
    note: "The best play-by-play of every hurricane season, from the founder of Weather Underground and a longtime science writer." },
];
function renderBlogs() {
  $("#blog-list").innerHTML = BLOGS.map((b) => `<li class="blog${b.star ? " star" : ""}">
      <a href="${b.url}" target="_blank" rel="noopener"><h3>${esc(b.title)}</h3></a>
      <p class="blog-who">${esc(b.who)}${b.where ? ` · ${esc(b.where)}` : ""}${b.star ? ` <span class="badge">Featured</span>` : ""}</p>
      <p>${esc(b.note)}</p>
    </li>`).join("");
}

/* ---------- Altimeter: scroll position as height through the atmosphere ---------- */
const LAYERS = [[0, "Troposphere"], [12, "Stratosphere"], [50, "Mesosphere"], [85, "Thermosphere"]];
function updateAltimeter() {
  const max = document.documentElement.scrollHeight - innerHeight;
  const f = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
  const km = Math.round(f * 120);
  $("#alt-dot").style.bottom = `${f * 100}%`;
  $("#alt-km").textContent = `${km} km`;
  $("#alt-layer").textContent = LAYERS.filter(([k]) => km >= k).pop()[1];
}
addEventListener("scroll", updateAltimeter, { passive: true });
addEventListener("resize", updateAltimeter);

/* ---------- Legends ---------- */
const LEGENDS = [
  {
    name: "Lewis Fry Richardson", years: "1881–1953",
    known: "First numerical weather forecast; the Richardson number",
    quote: "Big whirls have little whirls that feed on their velocity, and little whirls have lesser whirls and so on to viscosity.",
    source: "Weather Prediction by Numerical Process, 1922",
    fact: "He computed a six-hour forecast by hand while serving in a WWI ambulance unit. It took weeks and predicted a pressure jump of 145 hPa. The method was right; the starting data weren't.",
  },
  {
    name: "Edward Lorenz", years: "1917–2008",
    known: "Chaos theory and the limits of predictability",
    quote: "Does the flap of a butterfly's wings in Brazil set off a tornado in Texas?",
    source: "Title of his 1972 AAAS talk (the title was suggested by the session organizer, Philip Merilees)",
    fact: "He found chaos in 1961 by restarting a simulation from a printout rounded to three decimals instead of six. The new run wandered off into a completely different forecast.",
  },
  {
    name: "F. Sherwood Rowland", years: "1927–2012",
    known: "CFCs and ozone depletion; Nobel Prize in Chemistry, 1995",
    quote: "What's the use of having developed a science well enough to make predictions if, in the end, all we're willing to do is stand around and wait for them to come true?",
    source: "Attributed, widely quoted",
    fact: "He and Mario Molina published the CFC–ozone warning in 1974, more than a decade before the Antarctic ozone hole was reported in 1985.",
  },
  {
    name: "Joanne Simpson", years: "1923–2010",
    known: "Hot towers and tropical convection; TRMM",
    fact: "In 1949 she became the first woman in the US to earn a PhD in meteorology. Decades later she was project scientist for TRMM, the first satellite built to measure tropical rainfall from space.",
  },
  {
    name: "Tetsuya “Ted” Fujita", years: "1920–1998",
    known: "The Fujita scale; discovered downbursts and microbursts",
    fact: "Known as “Mr. Tornado.” His microburst work after the 1975 Eastern Air Lines Flight 66 crash led to the wind-shear detection systems now used at airports.",
  },
  {
    name: "Jule Charney", years: "1917–1981",
    known: "Quasi-geostrophic theory; the first computer forecast",
    fact: "His team's 1950 ENIAC forecast took about 24 hours to compute a 24-hour forecast, so it barely kept pace with the weather. His 1979 Charney Report put climate sensitivity at 3 °C ± 1.5 °C, a range that has held up remarkably well.",
  },
  {
    name: "Carl-Gustaf Rossby", years: "1898–1957",
    known: "Rossby waves; the jet stream",
    fact: "He started the first US university meteorology program at MIT in 1928, and in 1956 he was on the cover of Time magazine. Few dynamicists can say that.",
  },
  {
    name: "Charles David Keeling", years: "1928–2005",
    known: "The Keeling Curve",
    fact: "He began measuring CO₂ at Mauna Loa in 1958. The CO₂ number at the top of this page comes from the same mountain.",
  },
  {
    name: "Syukuro Manabe", years: "born 1931",
    known: "Climate modeling; Nobel Prize in Physics, 2021",
    fact: "His 1967 paper with Richard Wetherald was voted the most influential climate science paper of all time in a 2015 Carbon Brief poll of climate scientists.",
  },
  {
    name: "Susan Solomon", years: "born 1956",
    known: "Explained the chemistry of the Antarctic ozone hole",
    fact: "She led the 1986 National Ozone Expedition to McMurdo Station at age 30. Antarctica now has a Solomon Glacier named after her.",
  },
  {
    name: "Paul Crutzen", years: "1933–2021",
    known: "Nitrogen oxides and ozone; Nobel Prize in Chemistry, 1995",
    fact: "He popularized the word “Anthropocene” after blurting it out at a conference in 2000, frustrated that people kept calling the present the Holocene.",
  },
  {
    name: "Not Mark Twain", years: "bonus",
    known: "Charles Dudley Warner, Hartford Courant, 1897",
    quote: "Everybody talks about the weather, but nobody does anything about it.",
    source: "Usually credited to Mark Twain, but it was his friend and co-author Warner",
    fact: "Meteorologists have since done quite a lot about it. See the Papers tab.",
  },
];

function renderLegends() {
  $("#legend-list").innerHTML = LEGENDS.map((l) => `<li class="legend">
      <div class="legend-head"><h3>${esc(l.name)}</h3><span class="years">${esc(l.years)}</span></div>
      <p class="known">${esc(l.known)}</p>
      ${l.quote ? `<blockquote>“${esc(l.quote)}”<cite>${esc(l.source)}</cite></blockquote>` : ""}
      <p class="fact"><b>Fun fact</b>${esc(l.fact)}</p>
    </li>`).join("");
}

/* ---------- Faces: free-licensed photos, downloaded from Wikipedia by the Action ---------- */
async function loadFaces() {
  const list = $("#face-list");
  list.innerHTML = `<li class="status">Loading photos…</li>`;
  const faces = (await fetchJson("data/faces.json"))?.faces || [];
  list.innerHTML = faces.length ? faces.map((f) => `<li class="face">
      <a href="${esc(f.full)}" target="_blank" rel="noopener"><img src="${esc(f.src)}" alt="${esc(f.name)}" loading="lazy"></a>
      <b>${esc(f.name)}</b><span>${esc(f.caption)}</span>
      <a class="credit" href="${esc(f.credit)}" target="_blank" rel="noopener">Photo credit and license</a>
    </li>`).join("") : `<li class="status">Photos are on their way; check back in a few minutes.</li>`;
}

/* ---------- CO2 ---------- */
async function loadCo2() {
  const data = await fetchJson("data/co2.json");
  if (!data?.ppm) return;
  $("#co2-value").textContent = `${data.ppm.toFixed(2)} ppm`;
  if (data.yearAgo) {
    const d = data.ppm - data.yearAgo;
    $("#co2-delta").textContent = `${d >= 0 ? "+" : ""}${d.toFixed(1)} in a year`;
  }
  $("#co2").title = `Mauna Loa daily mean for ${data.date}`;
  $("#co2").hidden = false;
}

loadCo2();
initPapers();
loadWebResearch();
initJobs();
showTab();
