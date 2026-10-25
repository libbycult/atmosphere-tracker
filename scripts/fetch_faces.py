"""Download free-licensed portraits of famous atmospheric scientists from Wikipedia.

Saves each photo into faces/ next to the site and writes data/faces.json, so the
Faces tab loads everything from our own site. Photos already downloaded are kept.
"""

import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "faces"
USER_AGENT = "Atmosphere Scholar photo collector (+https://github.com/libbycult/atmosphere-tracker)"
API = "https://en.wikipedia.org/w/api.php"
THUMB = 500  # Wikimedia serves a fixed set of thumbnail widths; 500 is one of them

FACES = [  # Wikipedia title, display name, caption
    ("Edward Norton Lorenz", "Edward Lorenz", "Chaos, butterflies"),
    ("Ted Fujita", "Ted Fujita", "Mr. Tornado"),
    ("Joanne Simpson", "Joanne Simpson", "Hot towers"),
    ("Jule Gregory Charney", "Jule Charney", "Quasi-geostrophic everything"),
    ("Carl-Gustaf Rossby", "Carl-Gustaf Rossby", "Rossby waves"),
    ("Vilhelm Bjerknes", "Vilhelm Bjerknes", "Founded modern forecasting"),
    ("Lewis Fry Richardson", "Lewis Fry Richardson", "Forecast by hand, in a war"),
    ("Charles David Keeling", "Charles David Keeling", "The Keeling Curve"),
    ("Syukuro Manabe", "Syukuro Manabe", "Nobel for climate models"),
    ("Susan Solomon", "Susan Solomon", "Solved the ozone hole"),
    ("F. Sherwood Rowland", "F. Sherwood Rowland", "CFCs and ozone"),
    ("Mario J. Molina", "Mario Molina", "CFCs and ozone"),
    ("Paul J. Crutzen", "Paul Crutzen", "Coined the Anthropocene"),
    ("Kerry Emanuel", "Kerry Emanuel", "Hurricane intensity"),
    ("Svante Arrhenius", "Svante Arrhenius", "CO₂ warming, 1896"),
    ("John Tyndall", "John Tyndall", "Measured the greenhouse effect, 1859"),
    ("Joseph Fourier", "Joseph Fourier", "Discovered the greenhouse effect"),
    ("Luke Howard (meteorologist)", "Luke Howard", "Named the clouds"),
    ("Francis Beaufort", "Francis Beaufort", "The wind scale"),
    ("Robert FitzRoy", "Robert FitzRoy", "Coined “forecast”"),
    ("Gilbert Walker (physicist)", "Gilbert Walker", "Found the Southern Oscillation"),
    ("Milutin Milanković", "Milutin Milanković", "Ice age cycles"),
    ("John von Neumann", "John von Neumann", "Backed the first computer forecast"),
    ("Warren M. Washington", "Warren Washington", "Pioneer of climate models"),
    ("James Hansen", "James Hansen", "1988 climate testimony"),
    ("Anders Celsius", "Anders Celsius", "Yes, that Celsius"),
    # Working today
    ("Katharine Hayhoe", "Katharine Hayhoe", "Will talk climate with anyone"),
    ("Michael E. Mann", "Michael Mann", "The hockey stick"),
    ("Gavin Schmidt", "Gavin Schmidt", "Climate models and RealClimate"),
    ("Ed Hawkins (scientist)", "Ed Hawkins", "Made the warming stripes"),
    ("Friederike Otto", "Friederike Otto", "Was it climate change? She checks"),
    ("Isaac Held", "Isaac Held", "The dynamics blog everyone reads"),
    ("Zeke Hausfather", "Zeke Hausfather", "Climate data detective"),
    ("Andrew Dessler", "Andrew Dessler", "Clouds, feedbacks, The Climate Brink"),
    ("J. Marshall Shepherd", "Marshall Shepherd", "Former AMS president"),
    ("Jennifer Francis", "Jennifer Francis", "The Arctic and the wavy jet stream"),
    ("Kim Cobb", "Kim Cobb", "Reads climate history in corals"),
    ("Valérie Masson-Delmotte", "Valérie Masson-Delmotte", "Led an IPCC report"),
    ("Bjorn Stevens", "Bjorn Stevens", "Clouds, clouds, clouds"),
    ("Daniel Swain", "Daniel Swain", "Weather whiplash"),
    ("Jim Cantore", "Jim Cantore", "If he's in your town, leave"),
    ("Ginger Zee", "Ginger Zee", "TV meteorologist"),
]


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def main():
    params = {
        "action": "query", "format": "json", "redirects": "1", "prop": "pageimages",
        "piprop": "thumbnail|original|name", "pithumbsize": str(THUMB), "pilicense": "free",
        "pilimit": "50", "titles": "|".join(f[0] for f in FACES),
    }
    q = json.loads(get(f"{API}?{urllib.parse.urlencode(params)}")).get("query", {})
    hop = lambda t, pairs: next((p["to"] for p in pairs or [] if p["from"] == t), t)  # noqa: E731
    pages = {p.get("title"): p for p in q.get("pages", {}).values()}
    OUT_DIR.mkdir(exist_ok=True)
    out = []
    for title, name, caption in FACES:
        page = pages.get(hop(hop(title, q.get("normalized")), q.get("redirects")))
        if not page or "thumbnail" not in page:
            print(f"no free photo for {name}")
            continue
        src = page["thumbnail"]["source"]
        ext = Path(urllib.parse.urlsplit(src).path).suffix.lower() or ".jpg"
        local = OUT_DIR / f"{name.lower().replace(' ', '-').replace('.', '')}{ext}"
        try:
            local.write_bytes(get(src))
        except Exception as exc:
            print(f"WARN {name}: {exc}", file=sys.stderr)
            if not local.exists():
                continue
        out.append({
            "name": name,
            "caption": caption,
            "src": f"faces/{local.name}",
            "full": page.get("original", {}).get("source", src),
            "credit": f"https://commons.wikimedia.org/wiki/File:{urllib.parse.quote(page.get('pageimage', ''))}",
        })
    if not out:
        print("no photos collected", file=sys.stderr)
        return 1
    (ROOT / "data" / "faces.json").write_text(json.dumps({"faces": out}, ensure_ascii=False))
    print(f"Wrote {len(out)} faces")
    return 0


if __name__ == "__main__":
    sys.exit(main())
