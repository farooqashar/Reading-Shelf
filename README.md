# What Ashar has been reading

A small static site that shows everything I've clipped into my Obsidian vault
([farooqashar/ashar-obsidian-vault](https://github.com/farooqashar/ashar-obsidian-vault)):
a bookshelf of every page (one spine per clipping, colored by topic, grouped by month),
followed by a searchable, filterable reading log. It rebuilds itself whenever the vault changes.

Only metadata is published — title, link, site, description, tags and dates. The clipped
article text stays in the vault.

## How it works

```
Obsidian ──obsidian-git push──▶ vault repo ──GitHub Action──▶ build hook (Netlify/Vercel)
                                                                     │
                       site repo (this) ◀── build clones the vault ──┘
                                                │
                                   dist/  index.html, data.json, feed.xml
```

- `scripts/build.mjs` shallow-clones the vault, reads every note under `Clippings/`,
  and writes `dist/` (static site + `data.json` + an RSS `feed.xml`).
- `vault-workflow/notify-reading-site.yml` goes in the **vault** repo and pings the host's
  build hook whenever something under `Clippings/` changes.
- `.github/workflows/refresh.yml` in **this** repo rebuilds daily as a safety net.

## Run it locally

```bash
npm install
npm run dev                       # clones the vault from GitHub, builds, serves on :4321
VAULT_DIR=~/path/to/vault npm run dev   # or build from a local copy of the vault
```

## Deploy

It's a static site, so any static host works. Configs are included for Netlify and Vercel.

**Netlify**
1. Add new site → Import from Git → pick this repo. `netlify.toml` sets the build
   (`npm run build`, publish `dist`, Node 22).
2. Site configuration → Build & deploy → **Build hooks** → add one for `main`. Copy the URL.

**Vercel**
1. Import this repo. `vercel.json` sets the build command and `dist/` output.
2. Project → Settings → Git → **Deploy Hooks** → create one for `main`. Copy the URL.

**Then, for either host**
3. Add the hook URL as a secret named `DEPLOY_HOOK` in **both** repos
   (Settings → Secrets and variables → Actions).
4. Copy `vault-workflow/notify-reading-site.yml` into the vault repo at
   `.github/workflows/notify-reading-site.yml` and push.
5. Optional: add a custom domain (e.g. `reading.asharfarooq.xyz`) and update `siteUrl`
   in `site.config.json` so the RSS links are right.

## Keeping things off the site

Edit `site.config.json`:

| Setting | What it hides |
| --- | --- |
| `exclude.domains` | Any clipping whose link or title mentions the domain (e.g. `sant.ai`) |
| `exclude.titleContains` | Titles containing a phrase |
| `exclude.folders` | Whole vault folders (e.g. `"NYC-Local"`) |
| `exclude.tags` | Notes tagged `private` or `draft` |

Or, per note, add `publish: false` to its frontmatter in Obsidian.

Folder names map to the labels and colors on the site via `categories` in the config; a new
vault folder shows up automatically with its folder name until you give it a label (and a
color in `src/styles.css`, under "topic colors").
