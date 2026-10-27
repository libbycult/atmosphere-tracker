"""Collect the weekly hot papers, recent PhD theses, new NASA datasets and upcoming ECMWF seminars.

Writes data/hot.json, data/theses.json, data/datasets.json and data/seminars.json. Each step is
independent; one failing leaves the others (and the rest of the site) alone. Also records whether
a few outside images used on Sky Now answer, in data/probes.json.
"""

import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
USER_AGENT = "Atmosphere Scholar data collector (+https://github.com/libbycult/atmosphere-tracker)"
OPENALEX = "https://api.openalex.org/works"
CMR = "https://cmr.earthdata.nasa.gov/search/collections.json"
INDICO = "https://events.ecmwf.int/export/categ/{cat}.json"
ECMWF_CATEGORIES = {9: "ECMWF seminar"}
# Same fields the Papers tab asks for, so the site can draw these with the same paper cards.
WORK_FIELDS = ("id,doi,title,publication_date,authorships,primary_location,open_access,abstract_inverted_index,"
               "cited_by_count,type,primary_topic,biblio,citation_normalized_percentile,countries_distinct_count,"
               "institutions_distinct_count,is_retracted,funders")
PROBES = {
    "airnow_aqi": "https://files.airnowtech.org/airnow/today/cur_aqi_usa.jpg",
    "goes_fire": "https://cdn.star.nesdis.noaa.gov/GOES19/ABI/CONUS/FireTemperature/1250x750.jpg",
}


def get(url, params=None):
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)


def write(name, obj):
    (DATA / name).write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))


def now():
    return datetime.now(timezone.utc).isoformat()


def hot():
    """Atmospheric science papers from the last 60 days with the most citations so far."""
    since = (date.today() - timedelta(days=60)).isoformat()
    body = get(OPENALEX, {
        "filter": f"primary_topic.subfield.id:1902,type:article|review,from_publication_date:{since},to_publication_date:{date.today()}",
        "sort": "cited_by_count:desc", "per_page": "12", "select": WORK_FIELDS,
    })
    works = [w for w in body.get("results", []) if w.get("cited_by_count")]
    write("hot.json", {"updated": now(), "since": since, "items": works})
    print(f"Wrote {len(works)} hot papers")


def theses():
    """The newest atmospheric science PhD dissertations OpenAlex knows about."""
    body = get(OPENALEX, {
        "filter": f"primary_topic.subfield.id:1902,type:dissertation,to_publication_date:{date.today()}",
        "sort": "publication_date:desc", "per_page": "60",
        "select": "id,doi,title,publication_date,authorships,primary_location,open_access,abstract_inverted_index",
    })
    items = []
    for w in body.get("results", []):
        a = (w.get("authorships") or [{}])[0]
        inst = (a.get("institutions") or [{}])[0].get("display_name") if a.get("institutions") else None
        loc = w.get("primary_location") or {}
        items.append({
            "title": w.get("title") or "Untitled",
            "author": (a.get("author") or {}).get("display_name"),
            "institution": inst or ((loc.get("source") or {}).get("display_name")),
            "date": w.get("publication_date"),
            "url": (w.get("open_access") or {}).get("oa_url") or loc.get("landing_page_url") or w.get("doi") or w.get("id"),
            "free": bool((w.get("open_access") or {}).get("is_oa")),
            "abstract": abstract(w.get("abstract_inverted_index")),
        })
    write("theses.json", {"updated": now(), "total": body.get("meta", {}).get("count"), "items": items})
    print(f"Wrote {len(items)} theses")


def abstract(inv, limit=600):
    if not inv:
        return ""
    words = {}
    for word, positions in inv.items():
        for p in positions:
            words[p] = word
    text = " ".join(words[i] for i in sorted(words))
    return text[:limit].rsplit(" ", 1)[0] + "…" if len(text) > limit else text


def datasets():
    """Atmosphere collections added to NASA's Earthdata catalog in the last 120 days."""
    since = (datetime.now(timezone.utc) - timedelta(days=120)).strftime("%Y-%m-%dT00:00:00Z")
    body = get(CMR, {
        "science_keywords[0][topic]": "ATMOSPHERE", "created_at": f"{since},",
        "sort_key": "-create-data-date", "page_size": "60",
    })
    items, seen = [], set()
    for e in body.get("feed", {}).get("entry", []):
        title = (e.get("title") or "").strip()
        # Near-real-time copies duplicate the standard product; keep one of each.
        key = re.sub(r"\b(near real-time|nrt|low latency)\b", "", title.lower()).strip()
        if not title or key in seen:
            continue
        seen.add(key)
        summary = re.sub(r"\s+", " ", e.get("summary") or "").strip()
        items.append({
            "title": title,
            "short_name": e.get("short_name"),
            "version": e.get("version_id"),
            "center": e.get("data_center"),
            "start": (e.get("time_start") or "")[:10],
            "summary": summary[:320].rsplit(" ", 1)[0] + "…" if len(summary) > 320 else summary,
            "url": f"https://search.earthdata.nasa.gov/search?q={urllib.parse.quote(e.get('short_name') or title)}",
        })
    write("datasets.json", {"updated": now(), "since": since[:10], "items": items})
    print(f"Wrote {len(items)} datasets")


def seminars():
    """Upcoming ECMWF seminars from their public Indico calendar."""
    items = []
    for cat, kind in ECMWF_CATEGORIES.items():
        body = get(INDICO.format(cat=cat), {"from": "today", "to": "+120d", "order": "start"})
        for ev in body.get("results", []):
            start = ev.get("startDate") or {}
            items.append({
                "title": (ev.get("title") or "").strip(),
                "date": start.get("date"),
                "time": (start.get("time") or "")[:5],
                "tz": start.get("tz"),
                "speaker": ", ".join(p.get("fullName", "") for p in ev.get("chairs") or [] if p.get("fullName")),
                "url": ev.get("url"),
                "host": kind,
            })
    items.sort(key=lambda i: (i["date"] or "", i["time"]))
    write("seminars.json", {"updated": now(), "items": items})
    print(f"Wrote {len(items)} seminars")


def probes():
    out = {}
    for name, url in PROBES.items():
        try:
            req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as res:
                out[name] = res.status
        except Exception as exc:
            out[name] = str(exc)[:80]
    write("probes.json", out)


def main():
    DATA.mkdir(exist_ok=True)
    steps = (hot, theses, datasets, seminars, probes)
    failures = 0
    for step in steps:
        try:
            step()
        except Exception as exc:
            failures += 1
            print(f"WARN {step.__name__}: {exc}", file=sys.stderr)
    return 1 if failures == len(steps) else 0


if __name__ == "__main__":
    sys.exit(main())
