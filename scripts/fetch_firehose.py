"""Collect job postings and research news from Firehose (firehose.com), a live web crawl.

Firehose matches every newly crawled page against our rules (Lucene queries) and keeps
matches for about 24 hours. Each run replays the last day, merges it with what the live
site already shows, and writes data/web.json. Skips quietly if FIREHOSE_TAP_TOKEN isn't set.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_jobs import sector  # noqa: E402

API = "https://api.firehose.com/v1"
LIVE = "https://libbycult.github.io/atmosphere-tracker/data/web.json"
OUT = Path(__file__).resolve().parent.parent / "data" / "web.json"
KEEP_DAYS = 30
MAX_ITEMS = 400
STREAM_SECONDS = 60
# Rules the owner asked to remove (a stray "Lapse Rate" rule made in the dashboard, 2026-10-24).
REMOVE_RULE_IDS = {"982b20c4-32dd-4342-91ee-10f73d2c2be1"}
RULE_LIST = []  # the tap's rules as found at the start of the run, written out for checking

# Rules are kept in sync with this list, matched by tag. Keep them narrow: every match costs credit.
RULES = {
    "jobs": (
        '(title:meteorologist OR title:"atmospheric scientist" OR title:"atmospheric science" '
        'OR title:"atmospheric sciences" OR title:"climate scientist" OR title:"air quality scientist" '
        'OR (title:postdoc* AND (added:atmospheric OR added:meteorology OR added:"climate dynamics"))) '
        'AND (url:*job* OR url:*career* OR url:*position* OR url:*vacanc* OR title:hiring OR title:vacancy '
        'OR title:"job opening" OR title:position) AND language:en'
    ),
    "research": (
        '(title:hurricane OR title:typhoon OR title:aerosol* OR title:"jet stream" OR title:monsoon '
        'OR title:"atmospheric river" OR title:stratosphere* OR title:ozone OR title:"cloud seeding" '
        'OR title:"polar vortex" OR title:"climate model" OR title:"extreme heat" OR title:thunderstorm*) '
        'AND (added:"published in" OR added:"journal" OR added:"study" OR added:"researchers") '
        'AND page_category:"/News" AND language:en AND recent:7d'
    ),
    "preprints": (
        '(domain:eartharxiv.org OR domain:essopenarchive.org OR domain:egusphere.copernicus.org) '
        'AND (added:atmospheric OR added:atmosphere OR added:meteorolog* OR added:precipitation '
        'OR added:aerosol* OR added:cloud* OR added:convection)'
    ),
}


def call(method, path, token, body=None, query=None, timeout=30):
    url = f"{API}{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    return urllib.request.urlopen(req, timeout=timeout)


def sync_rules(token):
    """Create or update our rules; returns {rule id: tag}."""
    with call("GET", "/rules", token) as res:
        data = json.load(res)
    existing = data.get("data", data) if isinstance(data, dict) else data
    for r in list(existing or []):
        if str(r.get("id")) in REMOVE_RULE_IDS:
            try:
                with call("DELETE", f"/rules/{r['id']}", token):
                    pass
                existing.remove(r)
                print(f"removed rule {r['id']}")
            except urllib.error.HTTPError as exc:
                print(f"WARN removing rule {r['id']}: {exc.code}", file=sys.stderr)
    by_tag = {r.get("tag"): r for r in existing or []}
    ids = {}
    for tag, value in RULES.items():
        rule = by_tag.get(tag)
        body = {"value": value, "tag": tag, "quality": True}
        try:
            if rule is None:
                with call("POST", "/rules", token, body) as res:
                    rule = json.load(res)
                    rule = rule.get("data", rule)
                print(f"created rule {tag}")
            elif rule.get("value") != value:
                with call("PUT", f"/rules/{rule['id']}", token, body) as res:
                    pass
                print(f"updated rule {tag}")
        except urllib.error.HTTPError as exc:
            print(f"WARN rule {tag}: {exc.code} {exc.read()[:300]!r}", file=sys.stderr)
            continue
        ids[str(rule["id"])] = tag
    for r in existing or []:  # rules added by hand in the dashboard keep their own tag
        ids.setdefault(str(r["id"]), r.get("tag") or "other")
    global RULE_LIST
    RULE_LIST = [{"id": str(r.get("id")), "tag": r.get("tag"), "value": (r.get("value") or "")[:160]} for r in existing or []]
    return ids


def stream(token):
    """Replay the last 24 hours of matches. Yields the `data` of each update event."""
    query = {"since": "24h", "timeout": STREAM_SECONDS, "limit": 5000}
    with call("GET", "/stream", token, query=query, timeout=STREAM_SECONDS + 30) as res:
        event, data = None, []
        for raw in res:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())
            elif line == "":
                if event == "update" and data:
                    try:
                        yield json.loads("\n".join(data))
                    except ValueError:
                        pass
                elif event == "error":
                    print(f"WARN stream error: {' '.join(data)[:300]}", file=sys.stderr)
                elif event == "end":
                    return
                event, data = None, []


def snippet(doc, limit=280):
    text = " ".join(c.get("text", "") for c in (doc.get("diff") or {}).get("chunks", []) if c.get("typ") == "ins")
    text = re.sub(r"\s+", " ", re.sub(r"[#*_>`\[\]]+", "", text or doc.get("markdown", ""))).strip()
    return text[:limit].rsplit(" ", 1)[0] + "…" if len(text) > limit else text


def employer_from(title, domain):
    m = re.search(r"\s(?:at|@)\s+(.+?)(?:\s[-|–]\s.*)?$", title) or re.search(r"\s[-|–]\s([^-|–]+)$", title)
    return m.group(1).strip() if m else domain


def to_item(update, tags):
    doc = update.get("document") or {}
    url, title = doc.get("url"), (doc.get("title") or "").strip()
    if not url or not title:
        return None
    domain = urllib.parse.urlsplit(url).hostname or ""
    domain = domain.removeprefix("www.")
    item = {
        "tag": tags.get(str(update.get("query_id")), "other"),
        "url": url,
        "title": title[:200],
        "domain": domain,
        "published": (doc.get("publish_time") or update.get("matched_at") or "")[:10],
        "matched": update.get("matched_at") or datetime.now(timezone.utc).isoformat(),
        "summary": snippet(doc),
    }
    if item["tag"] == "jobs":
        item["employer"] = employer_from(title, domain)
        item["sector"] = sector(item["employer"], title)
    return item


def previous():
    try:
        with urllib.request.urlopen(LIVE, timeout=30) as res:
            return json.load(res).get("items", [])
    except Exception as exc:
        print(f"no previous web.json ({exc})")
        return []


def main():
    token = os.environ.get("FIREHOSE_TAP_TOKEN", "").strip()
    if not token:
        print("FIREHOSE_TAP_TOKEN not set; skipping Firehose")
        return 0
    try:
        tags = sync_rules(token)
        fresh = [i for i in (to_item(u, tags) for u in stream(token)) if i]
    except urllib.error.HTTPError as exc:
        print(f"WARN firehose: {exc.code} {exc.read()[:300]!r}", file=sys.stderr)
        return 1
    print(f"{len(fresh)} matches from the last 24 hours")
    cutoff = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).isoformat()
    merged, seen = [], set()
    for item in sorted(fresh + previous(), key=lambda i: i.get("matched", ""), reverse=True):
        if item["url"] in seen or item.get("matched", "") < cutoff:
            continue
        seen.add(item["url"])
        merged.append(item)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"updated": datetime.now(timezone.utc).isoformat(), "rules": RULE_LIST, "items": merged[:MAX_ITEMS]},
                              separators=(",", ":"), ensure_ascii=False))
    print(f"Wrote {len(merged[:MAX_ITEMS])} web items")
    return 0


if __name__ == "__main__":
    sys.exit(main())
