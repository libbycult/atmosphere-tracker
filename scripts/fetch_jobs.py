"""Collect atmospheric science job listings from job-board RSS feeds into data/jobs.json.

Runs daily in GitHub Actions (.github/workflows/deploy.yml). Uses only the Python
standard library. If every feed fails, the existing data/jobs.json is left alone.
"""

import html
import json
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "jobs.json"
MAX_AGE_DAYS = 90
USER_AGENT = "AtmoScholar job collector (+https://github.com/libbycult/atmosphere-tracker)"

# Madgex-powered boards publish search results as RSS at /jobsrss/?keywords=...
BOARDS = {
    "AGU Career Center": "https://findajob.agu.org/jobsrss/",
    "Science Careers": "https://jobs.sciencecareers.org/jobsrss/",
}
KEYWORDS = ["atmospheric", "meteorology", "meteorologist", "climate scientist", "air quality", "weather"]
PAGES_PER_SEARCH = 3

# A listing is kept only if its title or summary mentions one of these.
RELEVANT = re.compile(
    r"atmospher|meteorolog|weather|climat|air quality|aerosol|cloud physics|precipitation|"
    r"hydrometeor|tropical cyclone|hurricane|boundary layer|ozone|emission|forecast|earth system|"
    r"remote sensing|lidar|radar|severe storm|wildfire smoke",
    re.I,
)

GOVERNMENT = re.compile(
    r"\b(NOAA|NASA|NCAR|UCAR|NWS|National Weather Service|USGS|EPA|DOE|Department of Energy|"
    r"National Laborator|National Lab|Laboratory|Met Office|ECMWF|EUMETSAT|Bureau of Meteorology|"
    r"Environment and Climate Change Canada|CSIRO|Max Planck|Helmholtz|CNRS|Government|Federal|"
    r"Air Force|Navy|Army|Naval|Agency|Ministry|Department of Defense|Department of Commerce)\b",
    re.I,
)
ACADEMIA = re.compile(r"\b(University|Universit|College|Institute of Technology|School of|Polytechnic|ETH|Academy of Sciences)", re.I)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def clean(text, limit=None):
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    if limit and len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0] + "…"
    return text


def child_text(item, name):
    """Text of the first child whose local tag name is `name` (ignores XML namespaces)."""
    for child in item:
        if child.tag.rsplit("}", 1)[-1].lower() == name:
            return (child.text or "").strip()
    return ""


def canonical(url):
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def sector(employer, title):
    if ACADEMIA.search(employer):
        return "academia"
    if GOVERNMENT.search(employer):
        return "government"
    if ACADEMIA.search(title) or re.search(r"\b(postdoc|professor|faculty|lecturer|PhD)\b", title, re.I):
        return "academia"
    return "industry"


def parse_feed(xml_bytes, source):
    root = ET.fromstring(xml_bytes)
    jobs = []
    for item in root.iter("item"):
        raw_title = clean(child_text(item, "title"))
        link = child_text(item, "link")
        if not raw_title or not link:
            continue
        # Madgex titles look like "Employer: Job title".
        employer, _, title = raw_title.partition(": ")
        if not title:
            employer, title = "", raw_title
        summary = clean(child_text(item, "description"), 280)
        location = clean(child_text(item, "location"))
        posted = None
        pub = child_text(item, "pubdate")
        if pub:
            try:
                posted = parsedate_to_datetime(pub).astimezone(timezone.utc).isoformat()
            except (TypeError, ValueError):
                pass
        jobs.append({
            "title": title,
            "employer": employer,
            "location": location,
            "url": canonical(link),
            "posted": posted,
            "source": source,
            "summary": summary,
            "sector": sector(employer, title),
        })
    return jobs


def main():
    collected = {}
    ok_fetches = 0
    for source, base in BOARDS.items():
        for keyword in KEYWORDS:
            for page in range(1, PAGES_PER_SEARCH + 1):
                url = f"{base}?{urllib.parse.urlencode({'keywords': keyword, 'page': page})}"
                try:
                    items = parse_feed(fetch(url), source)
                    ok_fetches += 1
                except Exception as exc:  # one bad feed shouldn't stop the rest
                    print(f"WARN {url}: {exc}", file=sys.stderr)
                    break
                print(f"{len(items):3d} items  {url}")
                for job in items:
                    collected.setdefault(job["url"], job)
                if len(items) < 20:
                    break

    if ok_fetches == 0:
        print("No feed could be read; keeping the existing jobs.json.", file=sys.stderr)
        return 1

    cutoff = datetime.now(timezone.utc) - timedelta(days=MAX_AGE_DAYS)
    jobs = [
        j for j in collected.values()
        if RELEVANT.search(f"{j['title']} {j['summary']}")
        and (not j["posted"] or datetime.fromisoformat(j["posted"]) >= cutoff)
    ]
    jobs.sort(key=lambda j: j["posted"] or "", reverse=True)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"updated": datetime.now(timezone.utc).isoformat(), "jobs": jobs}, indent=1, ensure_ascii=False))
    counts = {s: sum(j["sector"] == s for j in jobs) for s in ("academia", "government", "industry")}
    print(f"Wrote {len(jobs)} jobs to {OUT} {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
