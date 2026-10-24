"""Fetch the latest Mauna Loa CO2 reading, open federal grant calls, active
tropical cyclones and climate time series into data/.

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
USER_AGENT = "Atmosphere Tracker data collector (+https://github.com/libbycult/atmosphere-tracker)"

CO2_MONTHLY_URL = "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.txt"
CH4_URL = "https://gml.noaa.gov/webdata/ccgg/trends/ch4/ch4_mm_gl.txt"
GISTEMP_URL = "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv"
ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
SEAICE_URLS = [  # NSIDC Sea Ice Index, September (annual minimum) extent; version bumps over time
    "https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/data/N_09_extent_v4.0.csv",
    "https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/data/N_09_extent_v3.0.csv",
    "https://masie_web.apps.nsidc.org/pub/DATASETS/NOAA/G02135/north/monthly/data/N_09_extent_v4.0.csv",
    "https://masie_web.apps.nsidc.org/pub/DATASETS/NOAA/G02135/north/monthly/data/N_09_extent_v3.0.csv",
]
STORMS_URL = "https://www.nhc.noaa.gov/CurrentStorms.json"
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


AGENCY_NAMES = [("NOAA", "NOAA"), ("DOC", "NOAA / Commerce"), ("NSF", "National Science Foundation"),
                ("NASA", "NASA"), ("DOE", "Department of Energy"), ("EPA", "EPA"), ("DOD", "Department of Defense"),
                ("USDA", "USDA"), ("DOI", "Department of the Interior")]


def agency_name(hit):
    code = (hit.get("agencyCode") or "").upper()
    for key, name in AGENCY_NAMES:
        if key in code:
            return name
    return hit.get("agencyName") or code


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
                "agency": agency_name(h),
                "openDate": to_iso(h.get("openDate")),
                "closeDate": to_iso(h.get("closeDate")),
                "status": h.get("oppStatus", ""),
                "url": f"https://www.grants.gov/search-results-detail/{h['id']}",
            }
    today = date.today()
    stale = today.replace(year=today.year - 2).isoformat()
    items = [
        g for g in found.values()
        if (g["closeDate"] and g["closeDate"] >= today.isoformat())
        or (not g["closeDate"] and (g["openDate"] or "") >= stale)  # undated calls only if recent
    ]
    items.sort(key=lambda g: g["closeDate"] or "9999")
    write("grants.json", {"updated": datetime.now(timezone.utc).isoformat(), "grants": items})
    print(f"Wrote {len(items)} grant calls")


def storms():
    body = json.loads(fetch(STORMS_URL))
    out = []
    for st in body.get("activeStorms") or []:
        out.append({
            "name": st.get("name", ""),
            "classification": st.get("classification", ""),
            "intensity": st.get("intensity", ""),
            "pressure": st.get("pressure", ""),
            "latitude": st.get("latitude", ""),
            "longitude": st.get("longitude", ""),
            "movementDir": st.get("movementDir", ""),
            "movementSpeed": st.get("movementSpeed", ""),
            "lastUpdate": st.get("lastUpdate", ""),
            "advisoryUrl": (st.get("publicAdvisory") or {}).get("url", ""),
            "graphicsUrl": (st.get("forecastGraphics") or {}).get("url", ""),
        })
    write("storms.json", {"updated": datetime.now(timezone.utc).isoformat(), "storms": out})
    print(f"Wrote {len(out)} active storms")


def noaa_monthly(url, value_col):
    """Rows of 'year month decimal value ...' -> [[decimal_year, value], ...], skipping missing values."""
    pts = []
    for line in fetch(url).decode().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split()
        try:
            dec, val = float(parts[2]), float(parts[value_col])
        except (IndexError, ValueError):
            continue
        if val > 0:
            pts.append([round(dec, 3), val])
    return pts


def gistemp():
    lines = fetch(GISTEMP_URL).decode().splitlines()
    header_i = next(i for i, l in enumerate(lines) if l.startswith("Year,"))
    cols = lines[header_i].split(",")
    jd = cols.index("J-D")
    pts = []
    for line in lines[header_i + 1:]:
        parts = line.split(",")
        try:
            pts.append([int(parts[0]), float(parts[jd])])
        except (IndexError, ValueError):
            continue  # current year shows *** until complete
    return pts


def oni():
    season_mid = {"DJF": 1, "JFM": 2, "FMA": 3, "MAM": 4, "AMJ": 5, "MJJ": 6, "JJA": 7, "JAS": 8, "ASO": 9, "SON": 10, "OND": 11, "NDJ": 12}
    pts = []
    for line in fetch(ONI_URL).decode().splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[0] in season_mid:
            try:
                pts.append([round(int(parts[1]) + (season_mid[parts[0]] - 0.5) / 12, 3), float(parts[3])])
            except ValueError:
                continue
    return pts


def seaice():
    for url in SEAICE_URLS:
        try:
            text = fetch(url).decode()
        except Exception:
            continue
        pts = []
        for line in text.splitlines()[1:]:
            parts = [p.strip() for p in line.split(",")]
            try:
                year, extent = int(parts[0]), float(parts[4])
            except (IndexError, ValueError):
                continue
            if extent > 0:
                pts.append([year, extent])
        if pts:
            return pts
    raise ValueError("no sea ice file could be read")


def climate():
    series = {}
    for key, getter in [
        ("co2", lambda: noaa_monthly(CO2_MONTHLY_URL, 3)),
        ("ch4", lambda: noaa_monthly(CH4_URL, 3)),
        ("temp", gistemp),
        ("oni", oni),
        ("seaice", seaice),
    ]:
        try:
            series[key] = getter()
            print(f"climate {key}: {len(series[key])} points")
        except Exception as exc:
            print(f"WARN climate {key}: {exc}", file=sys.stderr)
    if not series:
        raise ValueError("no climate series fetched")
    write("climate.json", {"updated": datetime.now(timezone.utc).isoformat(), "series": series})


def main():
    DATA.mkdir(exist_ok=True)
    failures = 0
    steps = (co2, grants, storms, climate)
    for step in steps:
        try:
            step()
        except Exception as exc:
            failures += 1
            print(f"WARN {step.__name__}: {exc}", file=sys.stderr)
    return 1 if failures == len(steps) else 0


if __name__ == "__main__":
    sys.exit(main())
