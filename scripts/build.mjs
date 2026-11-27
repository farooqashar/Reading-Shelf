// Builds the reading site from the Obsidian vault.
//
// 1. Gets the vault: uses $VAULT_DIR if set (local dev), otherwise shallow-clones
//    the public vault repo from GitHub.
// 2. Parses every clipping's frontmatter into a compact record.
// 3. Writes dist/ with the static site, data.json and feed.xml.
//
// Only metadata (title, link, description, tags, dates) is published — never the
// full clipped article text, which belongs to its original authors.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "site.config.json"), "utf8"));
const dist = path.join(root, "dist");

// ---------- 1. get the vault ----------
function getVault() {
  if (process.env.VAULT_DIR) {
    console.log(`Using local vault at ${process.env.VAULT_DIR}`);
    return path.resolve(process.env.VAULT_DIR);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const url = `https://github.com/${config.vaultRepo}.git`;
  console.log(`Cloning ${url} (${config.vaultBranch})`);
  execFileSync("git", ["clone", "--depth", "1", "--branch", config.vaultBranch, url, dir], {
    stdio: "inherit",
  });
  return dir;
}

function vaultCommit(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "log", "-1", "--format=%h|%cI"], {
      encoding: "utf8",
    }).trim();
    const [sha, date] = out.split("|");
    return { sha, date };
  } catch {
    return { sha: null, date: new Date().toISOString() };
  }
}

// ---------- 2. parse clippings ----------
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// A YYYY-MM-DD date, or null unless it is a real calendar day (so "2026-13-05"
// and "2026-02-30" are rejected rather than published).
const asDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  const m = String(v).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return !isNaN(d) && d.toISOString().slice(0, 10) === m[0] ? m[0] : null;
};

const stripLink = (s) => String(s).replace(/^\[\[|\]\]$/g, "").trim();

const toList = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean).map(String);

// Tags compare without a leading "#" and case-insensitively, so `#Private`
// matches `private` in exclude.tags and hiddenTags.
const normTag = (t) => String(t).trim().replace(/^#/, "").toLowerCase();
const hiddenTags = config.hiddenTags.map(normTag);
const excludedTags = config.exclude.tags.map(normTag);

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function plainExcerpt(md, max = 220) {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/^#+\s.*$/gm, " ")
    .replace(/[*_`>#|~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// A clipping's id is a hash of its vault-relative path, so it stays the same
// when other clippings are added. It is the feed's <guid> and an HTML id, so it
// starts with a letter.
const stableId = (rel) =>
  "c" + crypto.createHash("sha1").update(rel.split(path.sep).join("/")).digest("hex").slice(0, 10);

function parseNote(file, vaultDir) {
  const rel = path.relative(vaultDir, file);
  const parts = rel.split(path.sep);
  // parts: [Clippings, Folder?, file.md]
  const folder = parts.length > 2 ? parts[1] : "_root";
  const { data, content } = matter(fs.readFileSync(file, "utf8"));

  const title = (data.title || path.basename(file, ".md")).toString().trim();
  const url = data.source ? String(data.source).trim() : null;
  const domain = url ? domainOf(url) : null;
  const allTags = toList(data.tags);
  const tags = allTags
    .filter((t) => !t.startsWith("[[") && !hiddenTags.includes(normTag(t)))
    .map((t) => t.replace(/^#/, ""));
  const authors = toList(data.author).map(stripLink).filter(Boolean);
  const words = content.split(/\s+/).filter(Boolean).length;
  const description = data.description ? String(data.description).trim() : "";

  return {
    id: stableId(rel),
    title,
    url,
    domain,
    authors,
    published: asDate(data.published),
    created: asDate(data.created),
    description: description || plainExcerpt(content),
    tags,
    category: folder,
    words,
    minutes: Math.max(1, Math.round(words / 230)),
    publish: data.publish,
    _allTags: allTags,
  };
}

function isExcluded(n) {
  const ex = config.exclude;
  if (n.publish === false) return true;
  if (ex.folders.includes(n.category)) return true;
  // A domain is excluded if it appears as the host, or anywhere in the link or
  // title (e.g. an SSL Labs report *about* a private host).
  const haystack = `${n.url ?? ""} ${n.title}`.toLowerCase();
  if (ex.domains.some((d) => (n.domain && (n.domain === d || n.domain.endsWith("." + d))) || haystack.includes(d.toLowerCase())))
    return true;
  if (ex.titleContains.some((s) => n.title.toLowerCase().includes(s.toLowerCase()))) return true;
  if (n._allTags.some((t) => excludedTags.includes(normTag(t)))) return true;
  return false;
}

// ---------- 3. write output ----------
const xml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function feed(items, updated) {
  const site = config.siteUrl.replace(/\/$/, "");
  const entries = items
    .slice(0, 50)
    .map(
      (n) => `  <item>
    <title>${xml(n.title)}</title>
    <link>${xml(n.url || site)}</link>
    <guid isPermaLink="false">${xml(n.id)}</guid>
    <pubDate>${new Date(n.created + "T12:00:00Z").toUTCString()}</pubDate>
    <description>${xml(n.description)}</description>
${n.tags.map((t) => `    <category>${xml(t)}</category>`).join("\n")}
  </item>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>What ${xml(config.owner)} has been reading</title>
  <link>${xml(site)}</link>
  <description>Pages ${xml(config.owner)} has saved from the web.</description>
  <lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>
${entries}
</channel>
</rss>
`;
}

function main() {
  const vaultDir = getVault();
  const commit = vaultCommit(vaultDir);

  const source = process.env.VAULT_DIR ? vaultDir : config.vaultRepo;
  const folders = config.includeFolders.filter((f) => {
    const exists = fs.existsSync(path.join(vaultDir, f));
    if (!exists) console.warn(`Include folder ${f}/ not found in ${source}`);
    return exists;
  });
  const files = folders.flatMap((f) => walk(path.join(vaultDir, f)));

  const parsed = files.map((f) => ({ rel: path.relative(vaultDir, f).split(path.sep).join("/"), ...parseNote(f, vaultDir) }));
  const notExcluded = parsed.filter((n) => !isExcluded(n));
  const skipped = parsed.length - notExcluded.length;
  // No date is guessed from `published` or file times: `published` is the
  // article's date, and a shallow clone gives every file the same time.
  const undated = notExcluded.filter((n) => !n.created);
  for (const n of undated) console.warn(`Skipped ${n.rel}: no valid "created" date`);
  const kept = notExcluded.filter((n) => n.created);

  const items = kept
    .sort((a, b) => b.created.localeCompare(a.created) || a.title.localeCompare(b.title))
    .map(({ rel, publish, _allTags, ...n }) => n);
  // Fail rather than deploy an empty shelf, so a broken vault checkout can't
  // wipe the site and the host keeps the last good build. ALLOW_EMPTY_SHELF=1
  // lets an empty shelf through, e.g. after hiding every note on purpose.
  if (items.length === 0) {
    const where = config.includeFolders.map((f) => `${f}/`).join(", ");
    const why = `No clippings to publish under ${where} in ${source} (${parsed.length} found, ${skipped} excluded, ${undated.length} without a date)`;
    if (process.env.ALLOW_EMPTY_SHELF !== "1")
      throw new Error(`${why}. To publish an empty shelf on purpose, set ALLOW_EMPTY_SHELF=1.`);
    console.warn(`${why}; publishing an empty shelf because ALLOW_EMPTY_SHELF=1.`);
  }

  const seen = new Set();
  for (const n of items) {
    if (seen.has(n.id)) throw new Error(`Duplicate clipping id ${n.id} ("${n.title}")`);
    seen.add(n.id);
  }

  const categories = Object.entries(config.categories)
    .map(([key, label]) => ({ key, label, count: items.filter((n) => n.category === key).length }))
    .filter((c) => c.count > 0);
  // Folders that exist in the vault but aren't in the config still show up.
  for (const key of new Set(items.map((n) => n.category))) {
    if (!categories.find((c) => c.key === key)) {
      categories.push({ key, label: key.replace(/[-_]/g, " "), count: items.filter((n) => n.category === key).length });
    }
  }

  const data = {
    owner: config.owner,
    generatedAt: new Date().toISOString(),
    vault: { repo: config.vaultRepo, ...commit },
    categories,
    items,
  };

  fs.rmSync(dist, { recursive: true, force: true });
  fs.cpSync(path.join(root, "src"), dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "data.json"), JSON.stringify(data));
  fs.writeFileSync(path.join(dist, "feed.xml"), feed(items, commit.date));

  console.log(`Built ${items.length} clippings (${skipped} excluded, ${undated.length} without a date) from vault ${commit.sha ?? "(local)"} → dist/`);
}

main();
