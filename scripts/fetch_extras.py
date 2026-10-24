"""Fetch the latest Mauna Loa CO2 reading and open federal grant calls into data/.

Runs daily in GitHub Actions next to fetch_jobs.py. Standard library only.
Each part is independent: if one source fails, its existing file is left alone.
"""

import json
import re
import sys
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
USER_AGENT = "AtmoScholar data collector (+https://github.com/libbycult/atmosphere-tracker)"

CO2_URL = "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_daily_mlo.txt"
GRANTS_URL = "https://api.grants.gov/v1/api/search2"
GRANT_KEYWORDS = ["atmospheric", "meteorology", "weather research", "climate research", "air quality research"]
RELEVANT = re.compile(r"atmospher|meteorolog|weather|climat|air quality|aerosol|earth system|precipitation|hurricane|storm", re.I)


def fetch(url, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"User-Agent": USER_AGENT}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=40) as resp:
        return resp.read()


def write(name, obj):
    (DATA / name).write_text(json.dumps(obj, indent=1, ensure_ascii=False))


def co2():
    # Data lines: year month day decimal_date co2_ppm (comment lines start with #)
    rows = []
    for line in fetch(CO2_URL).decode().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split()
        try:
            y, m, d, ppm = int(parts[0]), int(parts[1]), int(parts[2]), float(parts[4])
        except (IndexError, ValueError):
            continue
        if 300 < ppm < 700:
            rows.append((date(y, m, d), ppm))
    if not rows:
        raise ValueError("no CO2 rows parsed")
    latest_day, latest = rows[-1]
    target = latest_day.replace(year=latest_day.year - 1) if not (latest_day.month == 2 and latest_day.day == 29) else latest_day.replace(year=latest_day.year - 1, day=28)
    year_ago = min(rows, key=lambda r: abs((r[0] - target).days))
    out = {"date": latest_day.isoformat(), "ppm": latest}
    if abs((year_ago[0] - target).days) <= 7:
        out["yearAgo"] = year_ago[1]
    write("co2.json", out)
    print(f"CO2 {out}")


def to_iso(mdy):
    try:
        return datetime.strptime(mdy, "%m/%d/%Y").date().isoformat()
    except (TypeError, ValueError):
        return None


def grants():
    found = {}
    for kw in GRANT_KEYWORDS:
        body = json.loads(fetch(GRANTS_URL, {"keyword": kw, "oppStatuses": "forecasted|posted", "rows": 100}))
        hits = (body.get("data") or {}).get("oppHits") or []
        print(f"{len(hits):3d} grant hits for {kw!r}")
        for h in hits:
            if not RELEVANT.search(h.get("title", "")):
                continue
            found[h["id"]] = {
                "title": h.get("title", "").strip(),
                "number": h.get("number", ""),
                "agency": h.get("agencyName") or h.get("agencyCode", ""),
                "openDate": to_iso(h.get("openDate")),
                "closeDate": to_iso(h.get("closeDate")),
                "status": h.get("oppStatus", ""),
                "url": f"https://www.grants.gov/search-results-detail/{h['id']}",
            }
    today = date.today().isoformat()
    items = [g for g in found.values() if not g["closeDate"] or g["closeDate"] >= today]
    items.sort(key=lambda g: g["closeDate"] or "9999")
    write("grants.json", {"updated": datetime.now(timezone.utc).isoformat(), "grants": items})
    print(f"Wrote {len(items)} grant calls")


def main():
    DATA.mkdir(exist_ok=True)
    failures = 0
    for step in (co2, grants):
        try:
            step()
        except Exception as exc:
            failures += 1
            print(f"WARN {step.__name__}: {exc}", file=sys.stderr)
    return 1 if failures == 2 else 0


if __name__ == "__main__":
    sys.exit(main())
