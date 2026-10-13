#!/usr/bin/env python3
"""Rebuild generated content. Run after adding or editing files or blog posts:

    python3 tools/build_manifest.py

It does two things:
  1. Rewrites the "# Recent blogposts" section of ~/README.md from
     blog/posts.json (the newest RECENT_COUNT posts, in posts.json order).
  2. Regenerates fs.json from the fs/ directory.
"""
import json, re, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
FS = ROOT / "fs"
README = FS / "home" / "matt" / "README.md"
POSTS = ROOT / "blog" / "posts.json"
RECENT_COUNT = 5
HEADING = "# Recent blogposts"
NEXT_HEADING = "## Start here"
# per-path overrides: (mode, owner)
OVERRIDES = {"/etc/shadow": (0o640, "root")}


def recent_posts_section():
    posts = json.loads(POSTS.read_text()).get("posts", []) if POSTS.exists() else []
    lines = [HEADING, ""]
    if not posts:
        lines.append("Nothing yet.")
    for p in posts[:RECENT_COUNT]:
        note = p.get("event") or p.get("date") or ""
        lines.append(f"- [{p['title']}](blog.html#{p['slug']})" + (f" — {note}" if note else ""))
    lines.append("")
    lines.append(f"All posts: [blog.html](blog.html)")
    return "\n".join(lines) + "\n\n", len(posts[:RECENT_COUNT])


def update_readme():
    text = README.read_text()
    section, n = recent_posts_section()
    if HEADING in text:
        text = re.sub(re.escape(HEADING) + r".*?(?=" + re.escape(NEXT_HEADING) + ")", lambda m: section, text, flags=re.S)
    elif NEXT_HEADING in text:
        text = text.replace(NEXT_HEADING, section + NEXT_HEADING, 1)
    else:
        print("README: no '## Start here' heading found, skipped the blog section")
        return
    README.write_text(text)
    print(f"README: listed {n} recent post(s)")


def write_manifest():
    files = []
    for p in sorted(FS.rglob("*")):
        if not p.is_file():
            continue
        vpath = "/" + p.relative_to(FS).as_posix()
        owner = "matt" if vpath.startswith("/home/matt") else "root"
        head = p.read_bytes()[:2]
        mode = 0o755 if head == b"#!" or "/bin/" in vpath else 0o644
        mode, owner = OVERRIDES.get(vpath, (mode, owner))
        files.append({"p": vpath, "s": p.stat().st_size, "m": mode, "o": owner,
                      "t": int(p.stat().st_mtime * 1000)})
    (ROOT / "fs.json").write_text(json.dumps({"files": files}, indent=1))
    print(f"wrote fs.json ({len(files)} files)")


if __name__ == "__main__":
    update_readme()
    write_manifest()
