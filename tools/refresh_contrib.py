#!/usr/bin/env python3
"""Refresh data/contrib.json (the GitHub contribution snapshot).

    python3 tools/refresh_contrib.py [github-user]

On any failure it leaves the existing snapshot alone and exits 0, so a
flaky API never breaks a deploy.
"""
import datetime, json, pathlib, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "contrib.json"
USER = sys.argv[1] if len(sys.argv) > 1 else "mattkoco"
URL = f"https://github-contributions-api.jogruber.de/v4/{USER}?y=last"


def main():
    try:
        with urllib.request.urlopen(URL, timeout=20) as r:
            data = json.load(r)
        days = data["contributions"]
        if not isinstance(days, list) or not days:
            raise ValueError("no contribution days in response")
        clean = [{"date": d["date"], "count": int(d["count"]), "level": int(d["level"])} for d in days]
    except Exception as e:
        print(f"contrib: kept the existing snapshot ({e})")
        return
    snapshot = {
        "user": USER,
        "fetched": datetime.date.today().isoformat(),
        "total": sum(d["count"] for d in clean),
        "contributions": clean,
    }
    OUT.write_text(json.dumps(snapshot))
    print(f"contrib: {snapshot['total']} contributions, {len(clean)} days")


if __name__ == "__main__":
    main()
