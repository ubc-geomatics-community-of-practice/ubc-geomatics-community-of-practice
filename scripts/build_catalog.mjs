// scripts/build_catalog.mjs
import fs from "fs/promises";

// --- config from env ---
const token = process.env.GH_TOKEN;
const org = process.env.ORG;
const allowlist = (process.env.REPO_ALLOWLIST || "").split(",").map(s => s.trim()).filter(Boolean);
const blocklist = (process.env.REPO_BLOCKLIST || "").split(",").map(s => s.trim()).filter(Boolean);

// --- helpers ---
async function gh(path) {
  const url = `https://api.github.com${path}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Accept": "application/vnd.github+json"
    }
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`GitHub API ${r.status} on ${path}: ${text}`);
  }
  return r.json();
}

async function listAllOrgRepos(org) {
  const repos = [];
  let page = 1;
  const per_page = 100;
  while (true) {
    const batch = await gh(`/orgs/${org}/repos?per_page=${per_page}&page=${page}&type=public&sort=full_name`);
    repos.push(...batch);
    if (batch.length < per_page) break;
    page++;
  }
  return repos;
}

function allowed(name) {
  if (allowlist.length && !allowlist.includes(name)) return false;
  if (blocklist.includes(name)) return false;
  return true;
}

async function fetchIfExists(url) {
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function normalizeItem(it, repo) {
  // Ensure required fields and add repo context.
  return {
    // required from per-repo JSON
    id: it.id || `${repo.name}-${(it.title || "item").toLowerCase().replace(/\s+/g, "-")}`,
    title: it.title || repo.name,
    course_code: it.course_code ?? null,
    page_url: it.page_url || it.site_url || `https://${org}.github.io/${repo.name}/`,
    summary: it.summary ?? null,
    topics: Array.isArray(it.topics) ? it.topics : [],
    software: Array.isArray(it.software) ? it.software : [],
    keywords: Array.isArray(it.keywords) ? it.keywords : [],
    license: it.license || "CC-BY-4.0",
    learning_outcomes: Array.isArray(it.learning_outcomes) ? it.learning_outcomes : [],
    // Bloom fields may already be present (preferred)
    blooms_verbs: Array.isArray(it.blooms_verbs) ? it.blooms_verbs : [],
    blooms_levels: Array.isArray(it.blooms_levels) ? it.blooms_levels : [],
    // context
    repo_name: repo.name,
    repo_url: repo.html_url
  };
}

(async () => {
  if (!token || !org) {
    throw new Error("Missing GH_TOKEN or ORG env vars.");
  }

  const repos = (await listAllOrgRepos(org)).filter(r => allowed(r.name));
  const items = [];

  for (const repo of repos) {
    // Where might oer-assignments.json live?
    const base = `https://${org}.github.io/${repo.name}/`;
    const candidates = [
      `${base}oer-assignments.json`,
      `${base}docs/oer-assignments.json`
    ];

    let data = null;
    for (const u of candidates) {
      data = await fetchIfExists(u);
      if (data?.items?.length) break;
    }

    if (data?.items?.length) {
      for (const it of data.items) items.push(normalizeItem(it, repo));
      continue;
    }

    // (Optional) Fallback: repo-level oer.yml -> one coarse item (skip if you only want lab pages)
    // try to read oer.yml from default branch:
    try {
      const meta = await gh(`/repos/${org}/${repo.name}/contents/oer.yml?ref=${repo.default_branch || "main"}`);
      if (meta?.download_url) {
        const text = await (await fetch(meta.download_url)).text();
        // If you want to support YAML fallback, either add js-yaml to dev deps
        // or skip parsing here to keep things lab-level only.
        // For now we skip to keep catalog lab-centric.
      }
    } catch {/* ignore */}
  }

  // Sort for nicer UX: course_code, then title
  items.sort((a, b) =>
    (a.course_code || "").localeCompare(b.course_code || "") ||
    a.title.localeCompare(b.title)
  );

  await fs.mkdir("assets", { recursive: true });
  await fs.writeFile("assets/assignments.json", JSON.stringify({
    org,
    generated_at: new Date().toISOString(),
    item_count: items.length,
    items
  }, null, 2));

  console.log(`Wrote ${items.length} lab items to assets/assignments.json`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
