/**
 * fetch-jobs.js — Job Scout daily fetcher
 * Uses sources that reliably work from GitHub Actions:
 *   - Arbeitnow (tech/remote jobs RSS, no bot blocking)
 *   - Jobicy (remote jobs JSON API)
 *   - Greenhouse / Lever (direct company APIs)
 *   - Indeed (attempted, may be blocked)
 */

import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH  = path.join(__dirname, "config.json");
const OUTPUT_PATH  = path.join(__dirname, "../public/jobs.json");

if (!fs.existsSync(CONFIG_PATH)) {
  console.error("❌ config.json not found.");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const { feeds = [], resume = "", keywords = [], location = "", maxJobsToScore = 20 } = config;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_KEY) {
  console.error("❌ ANTHROPIC_API_KEY not set.");
  process.exit(1);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => ["item", "entry"].includes(name),
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function stripHtml(str) {
  return String(str)
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ").trim();
}

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter(j => {
    const key = (j.title + j.company).toLowerCase().replace(/\s+/g, "");
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function matchesKeywords(job, kws) {
  if (!kws.length) return true;
  const hay = (job.title + " " + job.description + " " + job.company).toLowerCase();
  return kws.some(kw => hay.includes(kw.toLowerCase()));
}

// ── Arbeitnow RSS (tech/remote jobs, no bot blocking) ─────────────────────────
// Returns all tech jobs — we filter by keywords after fetching
async function fetchArbeitnow() {
  const url = "https://www.arbeitnow.com/rss";
  console.log(`    Fetching Arbeitnow RSS...`);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/xml, text/xml" },
      timeout: 20000,
    });
    console.log(`    HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    console.log(`    ${text.length} chars received`);
    const parsed = parser.parse(text);
    const items = parsed?.rss?.channel?.item || [];
    const list = Array.isArray(items) ? items : [items];
    console.log(`    ${list.length} raw items`);
    return list.map(item => ({
      id: String(item.guid?.["#text"] || item.guid || Math.random()),
      title: stripHtml(String(item.title?.["#text"] || item.title || "Untitled")),
      company: stripHtml(String(item["author"] || item["dc:creator"] || "")),
      link: item.link?.["#text"] || item.link || "#",
      description: stripHtml(String(item.description?.["#text"] || item.description || "")).slice(0, 600),
      pubDate: String(item.pubDate || ""),
      feedName: "Arbeitnow",
      source: "arbeitnow",
      score: null, matchReason: "", keyMatches: [], gaps: [],
    }));
  } catch (e) {
    console.warn(`    ⚠ Arbeitnow failed: ${e.message}`);
    return [];
  }
}

// ── Jobicy JSON API (remote jobs) ─────────────────────────────────────────────
async function fetchJobicy(keyword) {
  const q = encodeURIComponent(keyword);
  const url = `https://jobicy.com/api/v2/remote-jobs?count=20&geo=usa&tag=${q}`;
  console.log(`    Fetching Jobicy: ${keyword}`);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      timeout: 15000,
    });
    console.log(`    HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const jobs = data.jobs || [];
    console.log(`    ${jobs.length} jobs`);
    return jobs.map(j => ({
      id: String(j.id || Math.random()),
      title: j.jobTitle || "Untitled",
      company: j.companyName || "",
      link: j.url || "#",
      description: stripHtml(j.jobDescription || j.jobExcerpt || "").slice(0, 600),
      pubDate: j.pubDate || "",
      feedName: `Jobicy — ${keyword}`,
      source: "jobicy",
      score: null, matchReason: "", keyMatches: [], gaps: [],
    }));
  } catch (e) {
    console.warn(`    ⚠ Jobicy failed for "${keyword}": ${e.message}`);
    return [];
  }
}

// ── Indeed RSS (may be blocked by IP) ────────────────────────────────────────
async function fetchIndeed(keyword, loc) {
  const q = encodeURIComponent(keyword);
  const l = loc ? `&l=${encodeURIComponent(loc)}` : "";
  const url = `https://www.indeed.com/rss?q=${q}${l}&sort=date&fromage=7`;
  console.log(`    Fetching Indeed: ${keyword}`);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      timeout: 20000,
      redirect: "follow",
    });
    console.log(`    HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    console.log(`    ${text.length} chars — ${text.slice(0,80).replace(/\n/g," ")}`);
    if (text.length < 200 || !text.includes("<item>")) {
      console.warn(`    ⚠ Indeed returned no items (likely blocked)`);
      return [];
    }
    const parsed = parser.parse(text);
    const items = parsed?.rss?.channel?.item || [];
    const list = Array.isArray(items) ? items : [items];
    return list.map(item => ({
      id: String(item.guid?.["#text"] || item.guid || Math.random()),
      title: stripHtml(String(item.title?.["#text"] || item.title || "Untitled")),
      company: stripHtml(String(item["source"]?.["#text"] || item["source"] || "")),
      link: item.link?.["#text"] || item.link || "#",
      description: stripHtml(String(item.description?.["#text"] || item.description || "")).slice(0, 600),
      pubDate: String(item.pubDate || ""),
      feedName: `Indeed — ${keyword}`,
      source: "indeed",
      score: null, matchReason: "", keyMatches: [], gaps: [],
    }));
  } catch (e) {
    console.warn(`    ⚠ Indeed failed for "${keyword}": ${e.message}`);
    return [];
  }
}

// ── Greenhouse ────────────────────────────────────────────────────────────────
async function fetchGreenhouse(slug, feedName) {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.jobs || []).slice(0, 30).map(j => ({
      id: String(j.id), title: j.title || "Untitled", company: slug,
      link: j.absolute_url || "#", description: stripHtml(j.content || "").slice(0, 600),
      pubDate: j.updated_at || "", feedName, source: "greenhouse",
      score: null, matchReason: "", keyMatches: [], gaps: [],
    }));
  } catch (e) { console.warn(`⚠ Greenhouse "${slug}": ${e.message}`); return []; }
}

// ── Lever ─────────────────────────────────────────────────────────────────────
async function fetchLever(slug, feedName) {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).slice(0, 30).map(j => ({
      id: j.id || String(Math.random()), title: j.text || "Untitled", company: slug,
      link: j.hostedUrl || "#", description: (j.descriptionPlain || "").slice(0, 600),
      pubDate: j.createdAt ? new Date(j.createdAt).toISOString() : "", feedName, source: "lever",
      score: null, matchReason: "", keyMatches: [], gaps: [],
    }));
  } catch (e) { console.warn(`⚠ Lever "${slug}": ${e.message}`); return []; }
}

// ── Score with Claude ─────────────────────────────────────────────────────────
async function scoreJob(job, resumeText) {
  const prompt = `You are an ATS analyzer. Score this job against the resume. Return ONLY valid JSON, no markdown.
RESUME: ${resumeText.slice(0, 1500)}
JOB TITLE: ${job.title}
COMPANY: ${job.company}
DESCRIPTION: ${job.description}
{"score":<0-100>,"matchReason":"<one sentence>","keyMatches":["match1","match2"],"gaps":["gap1"]}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 250, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content?.map(b => b.text || "").join("") || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON");
    return JSON.parse(match[0]);
  } catch (e) {
    console.warn(`  ⚠ Score failed "${job.title}": ${e.message}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🚀 Job Scout — ${new Date().toISOString()}`);
  console.log(`🔑 Keywords: ${keywords.join(", ") || "none"}`);
  console.log(`📍 Location: ${location || "nationwide/remote"}\n`);

  const allJobs = [];

  // 1. Arbeitnow — fetch all, filter by keywords after
  console.log("── Arbeitnow ─────────────────────────────────");
  const arbeitnowJobs = await fetchArbeitnow();
  const arbFiltered = arbeitnowJobs.filter(j => matchesKeywords(j, keywords));
  console.log(`  ✓ ${arbFiltered.length} matching jobs (from ${arbeitnowJobs.length} total)\n`);
  allJobs.push(...arbFiltered);

  // 2. Jobicy — query each keyword
  console.log("── Jobicy ────────────────────────────────────");
  for (const kw of keywords) {
    const jobs = await fetchJobicy(kw);
    console.log(`  ✓ ${jobs.length} jobs for "${kw}"\n`);
    allJobs.push(...jobs);
  }

  // 3. Indeed — query each keyword (may be blocked)
  console.log("── Indeed ────────────────────────────────────");
  for (const kw of keywords) {
    const jobs = await fetchIndeed(kw, location);
    console.log(`  ✓ ${jobs.length} jobs for "${kw}"\n`);
    allJobs.push(...jobs);
  }

  // 4. Manual feeds (Greenhouse / Lever)
  const manualFeeds = feeds.filter(f => f.source === "greenhouse" || f.source === "lever");
  if (manualFeeds.length) {
    console.log("── Company feeds ─────────────────────────────");
    for (const feed of manualFeeds) {
      console.log(`  ${feed.name}`);
      let items = [];
      if (feed.source === "greenhouse") items = await fetchGreenhouse(feed.url, feed.name);
      else if (feed.source === "lever") items = await fetchLever(feed.url, feed.name);
      const filtered = items.filter(j => matchesKeywords(j, keywords));
      console.log(`  ✓ ${filtered.length} matching (${items.length} total)\n`);
      allJobs.push(...filtered);
    }
  }

  const deduped = dedupe(allJobs);
  console.log(`\n📦 ${deduped.length} unique jobs total`);

  if (deduped.length === 0) {
    console.log("⚠ No jobs found. Writing empty output.");
    const outDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ fetchedAt: new Date().toISOString(), totalJobs: 0, jobs: [] }, null, 2));
    return;
  }

  // Score
  if (resume.trim()) {
    const toScore = deduped.filter(j => j.description?.length > 50).slice(0, maxJobsToScore);
    console.log(`\n⭐ Scoring ${toScore.length} jobs...`);
    for (let i = 0; i < toScore.length; i++) {
      const job = toScore[i];
      process.stdout.write(`  [${i+1}/${toScore.length}] ${job.title.slice(0,45).padEnd(45)} → `);
      const result = await scoreJob(job, resume);
      if (result) {
        const idx = deduped.findIndex(j => j.id === job.id);
        if (idx !== -1) Object.assign(deduped[idx], result);
        process.stdout.write(`${result.score}\n`);
      } else process.stdout.write(`skipped\n`);
      await new Promise(r => setTimeout(r, 300));
    }
  }

  deduped.sort((a, b) => (b.score || 0) - (a.score || 0));

  const outDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ fetchedAt: new Date().toISOString(), totalJobs: deduped.length, jobs: deduped }, null, 2));

  console.log(`\n✅ Done — ${deduped.length} jobs written to public/jobs.json`);
  if (deduped[0]) console.log(`   Top: "${deduped[0].title}" at ${deduped[0].company} (score: ${deduped[0].score ?? "unscored"})`);
}

main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
