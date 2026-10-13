# kocorowski portfolio

A VS Code-style page (Gruvbox Material) whose main feature is a bash shell
running in the browser. Every file the shell can read lives in `fs/`.

## Layout

    index.html          the window: styles + markup
    shell.js            the interpreter: filesystem, lexer, parser, builtins, coreutils
    app.js              terminal, explorer, editor tabs, GitHub graph
    fs/                 the virtual filesystem's real files (fs/home/matt = ~)
    fs.json             manifest of fs/ (sizes, modes, owners)
    data/contrib.json   GitHub contribution snapshot, used if the live API is unreachable
    blog.html           the blog (renders markdown posts, no dependencies)
    blog/posts.json     list of posts (newest first): slug, title, date, tags, summary
    blog/<slug>.md      each post's body in Markdown
    tools/build_manifest.py

## Writing a blog post

1. Add a Markdown file at `blog/<slug>.md` (just the body, no front-matter).
2. Add an entry to the top of the `posts` array in `blog/posts.json`:
   `{ "slug": "<slug>", "title": "...", "date": "...", "event": "...", "tags": [...], "summary": "..." }`
   Only `slug` and `title` are required; `event` is optional.
3. Push. The deploy workflow refreshes the "Recent blogposts" list at the top
   of the terminal's README (newest 5, in posts.json order). To preview
   locally first, run `python3 tools/build_manifest.py`.
   The blog page itself needs no build step: it reads posts.json and fetches the .md on click.
   Posts are shown in the order they appear in posts.json (newest first).
   Supported Markdown: headings, paragraphs, **bold**, *italic*, `code`,
   fenced ``` code blocks, > blockquotes, - / 1. lists, links, and ---.

## Editing content

1. Edit or add files under `fs/home/matt/` (anything else under `fs/` works too).
2. Push. The deploy workflow regenerates the manifest (to preview locally: `python3 tools/build_manifest.py`).
3. Files starting with `#!` or living in a `bin/` folder become executable.
   Dotfiles are hidden from the explorer and from `ls` (use `ls -a`).

## Running locally

The page fetches files, so open it through a server, not file://

    python3 -m http.server
    # then visit http://localhost:8000

## Deploying on GitHub Pages

The workflow in `.github/workflows/deploy.yml` builds and deploys the site
for you, so you never run the build script by hand.

One-time setup:

1. Create a repo (for a user site: `mattkoco.github.io`) and push this folder
   to `main`. Make sure the hidden `.github/` folder goes up too; GitHub's
   drag-and-drop uploader skips dotfolders, so use git.
2. Settings -> Pages -> Build and deployment -> Source: **GitHub Actions**.
3. Push anything (or Actions tab -> "Deploy site" -> Run workflow).

After that, every push to `main` redeploys in about a minute. The workflow:

- refreshes the GitHub contribution snapshot (`tools/refresh_contrib.py`),
- runs `tools/build_manifest.py` (fs.json + the README's recent posts),
- uploads the site, dotfiles included, and deploys it.

It also runs once a day so the contribution graph stays current. Watch
runs, and see any errors, in the repo's Actions tab.

The generated files are built fresh on each deploy and never committed,
so `fs.json` in the repo can look out of date. That's expected.

## GitHub graph

`app.js` asks https://github-contributions-api.jogruber.de for live data and
falls back to `data/contrib.json`, which the deploy workflow refreshes daily.
To refresh it locally: `python3 tools/refresh_contrib.py`.
