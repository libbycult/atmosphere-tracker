"""Build a keyword co-occurrence network for atmospheric science from OpenAlex.

Nodes are the most common OpenAlex keywords on atmospheric science papers from the
last three years; links count how many papers carry both keywords. Writes
data/network.json. The network changes slowly, so a copy less than a week old on
the live site is reused instead of rebuilt.
"""

import json
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "network.json"
LIVE = "https://libbycult.github.io/atmosphere-tracker/data/network.json"
API = "https://api.openalex.org/works"
USER_AGENT = "Atmosphere Tracker network builder (+https://github.com/libbycult/atmosphere-tracker)"
NODES = 36
MAX_AGE = timedelta(days=7)

# Keywords that are places, sample types or too generic to say anything about the science.
SKIP = {
    "alaska", "surface-samples", "seasonal-variation", "china", "india", "arctic", "antarctica", "europe",
    "tibetan-plateau", "united-states", "africa", "case-study", "data", "model", "observations", "sensitivity",
    "variability", "trends", "impact", "analysis",
    # Ice topics OpenAlex files under atmospheric science; they would swamp the map
    "glaciers", "permafrost-thaw", "glacier-mass-balance", "ice-sheets", "sea-level-rise",
}


def get(params):
    req = urllib.request.Request(f"{API}?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=90) as res:
        return json.load(res)


def reuse_live():
    try:
        with urllib.request.urlopen(LIVE, timeout=30) as res:
            data = json.load(res)
        built = datetime.fromisoformat(data["updated"])
        if datetime.now(timezone.utc) - built < MAX_AGE and data.get("nodes"):
            return data
    except Exception as exc:
        print(f"no reusable network ({exc})")
    return None


def main():
    data = reuse_live()
    if data:
        OUT.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
        print("reused last week's network")
        return 0
    year = date.today().year
    base = f"primary_topic.subfield.id:1902,type:article|preprint|review,publication_year:{year - 3}-{year}"
    groups = get({"filter": base, "group_by": "keywords.id"}).get("group_by", [])
    slug = lambda key: key.rsplit("/", 1)[-1]  # noqa: E731
    candidates = [g for g in groups if slug(g["key"]) not in SKIP]
    nodes = [{"id": slug(g["key"]), "label": g["key_display_name"], "count": g["count"]} for g in candidates[:NODES]]
    ids = {n["id"] for n in nodes}
    links = {}
    for n in nodes:
        try:
            co = get({"filter": f"{base},keywords.id:{n['id']}", "group_by": "keywords.id"}).get("group_by", [])
        except Exception as exc:
            print(f"WARN {n['id']}: {exc}", file=sys.stderr)
            continue
        for g in co:
            other = slug(g["key"])
            if other != n["id"] and other in ids:
                pair = tuple(sorted((n["id"], other)))
                links[pair] = max(links.get(pair, 0), g["count"])
    if not links:
        print("no links built", file=sys.stderr)
        return 1
    OUT.write_text(json.dumps({
        "updated": datetime.now(timezone.utc).isoformat(),
        "years": f"{year - 3}–{year}",
        "nodes": nodes,
        "links": [{"source": a, "target": b, "count": c} for (a, b), c in links.items()],
        "skipped": [slug(g["key"]) for g in groups[:60] if slug(g["key"]) in SKIP],
    }, separators=(",", ":"), ensure_ascii=False))
    print(f"Wrote network: {len(nodes)} keywords, {len(links)} links")
    return 0


if __name__ == "__main__":
    sys.exit(main())
