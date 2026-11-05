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

const asDate = (v) => {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const m = String(v).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
};

const stripLink = (s) => String(s).replace(/^\[\[|\]\]$/g, "").trim();

const toList = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean).map(String);

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
    .filter((t) => !t.startsWith("[[") && !config.hiddenTags.includes(t))
    .map((t) => t.replace(/^#/, ""));
  const authors = toList(data.author).map(stripLink).filter(Boolean);
  const words = content.split(/\s+/).filter(Boolean).length;
  const description = data.description ? String(data.description).trim() : "";

  return {
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
  if (n._allTags.some((t) => ex.tags.includes(t))) return true;
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

  const files = config.includeFolders.flatMap((f) => {
    const p = path.join(vaultDir, f);
    return fs.existsSync(p) ? walk(p) : [];
  });

  const parsed = files.map((f) => parseNote(f, vaultDir));
  const kept = parsed.filter((n) => !isExcluded(n));
  const skipped = parsed.length - kept.length;

  const items = kept
    .filter((n) => n.created)
    .sort((a, b) => b.created.localeCompare(a.created) || a.title.localeCompare(b.title))
    .map(({ publish, _allTags, ...n }, i) => ({ id: `c${i}`, ...n }));

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

  console.log(`Built ${items.length} clippings (${skipped} excluded) from vault ${commit.sha ?? "(local)"} → dist/`);
}

main();
