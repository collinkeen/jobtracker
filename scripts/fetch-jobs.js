/**
 * fetch-jobs.js
 * Reads config.json, auto-generates feed URLs from keywords,
 * fetches all feeds, scores against resume using Claude,
 * and writes results to ../public/jobs.json
 */

import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const OUTPUT_PATH = path.join(__dirname, "../public/jobs.json");

// ── Load config ───────────────────────────────────────────────────────────────
if (!fs.existsSync(CONFIG_PATH)) {
  console.error("❌ config.json not found. Copy config.example.json to config.json and fill it in.");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const { feeds = [], resume = "", keywords = [], location = "", maxJobsToScore = 20 } = config;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_KEY) {
  console.error("❌ ANTHROPIC_API_KEY environment variable not set.");
  process.exit(1);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => ["item", "entry"].includes(name),
});

// ── URL builders ──────────────────────────────────────────────────────────────
function buildIndeedRSS(query, loc = "") {
  const q = encodeURIComponent(query);
  const l = loc ? `&l=${encodeURIComponent(loc)}` : "";
  return `https://www.indeed.com/rss?q=${q}${l}&sort=date&fromage=1`;
}

function buildGoogleJobsRSS(query, loc = "") {
  const q = encodeURIComponent(`"${query}"${loc ? ` ${loc}` : ""} job`);
  return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

function generateFeedsFromKeywords(kws, loc) {
  const autoFeeds = [];
  kws.forEach((kw, i) => {
    autoFeeds.push({ id: `indeed-${i}`, name: `Indeed — ${kw}`, url: buildIndeedRSS(kw, loc), source: "indeed" });
    autoFeeds.push({ id: `google-${i}`, name: `Google Jobs — ${kw}`, url: buildGoogleJobsRSS(kw, loc), source: "rss" });
  });
  return autoFeeds;
}

// ── Fetch RSS ─────────────────────────────────────────────────────────────────
async function fetchRSS(url, feedName, source) {
  try {
    console.log(`    URL: ${url}`);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Cache-Control": "no-cache",
      },
      timeout: 20000,
      redirect: "follow",
    });

    console.log(`    HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    console.log(`    Response: ${text.length} chars — preview: ${text.slice(0, 120).replace(/\n/g, " ")}`);

    if (text.length < 100) { console.warn(`    ⚠ Response too short`); return []; }

    const parsed = parser.parse(text);
    const channel = parsed?.rss?.channel || parsed?.feed || parsed?.["rdf:RDF"];
    if (!channel) { console.warn(`    ⚠ No RSS channel found`); return []; }

    const rawItems = channel?.item || channel?.entry || [];
    const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
    console.log(`    Found ${items.length} items`);

    return items.slice(0, 30).map((item) => {
      const link = item.link?.["@_href"] || item.link?.["#text"] || item.link || "#";
      return {
        id: String(item.guid?.["#text"] || item.guid || item.id?.["#text"] || item.id || link || Math.random()),
        title: stripHtml(String(item.title?.["#text"] || item.title || "Untitled")),
        company: stripHtml(String(item["source"]?.["#text"] || item["source"] || item["author"] || item["a10:author"]?.name || "")),
        link,
        description: stripHtml(String(item.description?.["#text"] || item.description || item.summary?.["#text"] || item.summary || item["content:encoded"] || "")).slice(0, 600),
        pubDate: String(item.pubDate || item.published || item.updated || ""),
        feedName,
        source,
        score: null,
        matchReason: "",
        keyMatches: [],
        gaps: [],
      };
    });
  } catch (e) {
    console.warn(`    ⚠ "${feedName}" failed: ${e.message}`);
    return [];
  }
}

// ── Fetch Greenhouse ──────────────────────────────────────────────────────────
async function fetchGreenhouse(slug, feedName) {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.jobs || []).slice(0, 30).map((j) => ({
      id: String(j.id), title: j.title || "Untitled", company: slug,
      link: j.absolute_url || "#", description: stripHtml(j.content || "").slice(0, 600),
      pubDate: j.updated_at || "", feedName, source: "greenhouse",
      score: null, matchReason: "", keyMatches: [], gaps: [],
    }));
  } catch (e) { console.warn(`⚠ Greenhouse "${slug}": ${e.message}`); return []; }
}

// ── Fetch Lever ───────────────────────────────────────────────────────────────
async function fetchLever(slug, feedName) {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).slice(0, 30).map((j) => ({
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

{"score":<0-100>,"matchReason":"<one sentence>","keyMatches":["match1","match2"],"gaps":["gap1","gap2"]}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 250, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content?.map((b) => b.text || "").join("") || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON");
    return JSON.parse(match[0]);
  } catch (e) {
    console.warn(`  ⚠ Score failed "${job.title}": ${e.message}`);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stripHtml(str) {
  return String(str).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "").replace(/\s+/g, " ").trim();
}

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter((j) => {
    const key = (j.title + j.company).toLowerCase().replace(/\s+/g, "");
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀 Job Scout starting — ${new Date().toISOString()}`);
  console.log(`🔑 Keywords: ${keywords.join(", ") || "none"}`);
  console.log(`📍 Location: ${location || "none (nationwide)"}`);

  const keywordFeeds = generateFeedsFromKeywords(keywords, location);
  const manualFeeds = feeds.filter(f => f.source === "greenhouse" || f.source === "lever");
  const allFeeds = [...keywordFeeds, ...manualFeeds];

  console.log(`📡 ${allFeeds.length} feeds (${keywordFeeds.length} auto-generated, ${manualFeeds.length} manual)\n`);

  const allJobs = [];
  for (const feed of allFeeds) {
    console.log(`  ▶ ${feed.name}`);
    let items = [];
    if (feed.source === "greenhouse") items = await fetchGreenhouse(feed.url, feed.name);
    else if (feed.source === "lever") items = await fetchLever(feed.url, feed.name);
    else items = await fetchRSS(feed.url, feed.name, feed.source);
    console.log(`    ✓ ${items.length} jobs\n`);
    allJobs.push(...items);
  }

  const deduped = dedupe(allJobs);
  console.log(`📦 ${deduped.length} unique jobs after dedup`);

  if (deduped.length === 0) {
    console.log("⚠ No jobs found — RSS feeds may be blocking requests or returning empty results.");
    console.log("  Indeed and Google News RSS can be rate-limited. Try running again in a few minutes.");
  }

  // Score
  if (resume.trim() && deduped.length > 0) {
    const toScore = deduped.filter(j => j.description?.length > 50).slice(0, maxJobsToScore);
    console.log(`\n⭐ Scoring ${toScore.length} jobs...`);
    for (let i = 0; i < toScore.length; i++) {
      const job = toScore[i];
      process.stdout.write(`  [${i + 1}/${toScore.length}] ${job.title.slice(0, 45).padEnd(45)} → `);
      const result = await scoreJob(job, resume);
      if (result) {
        const idx = deduped.findIndex(j => j.id === job.id);
        if (idx !== -1) Object.assign(deduped[idx], result);
        process.stdout.write(`${result.score}\n`);
      } else {
        process.stdout.write(`skipped\n`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  deduped.sort((a, b) => (b.score || 0) - (a.score || 0));

  const outDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ fetchedAt: new Date().toISOString(), totalJobs: deduped.length, jobs: deduped }, null, 2));

  console.log(`\n✅ Done — ${deduped.length} jobs saved to public/jobs.json`);
  if (deduped[0]) console.log(`   Top: "${deduped[0].title}" (${deduped[0].score ?? "unscored"})`);
}

main().catch(e => { console.error("❌ Fatal:", e); process.exit(1); });
