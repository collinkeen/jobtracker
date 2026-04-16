/**
 * fetch-jobs.js
 * Reads config.json, fetches all feeds, scores against resume using Claude,
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
const { feeds = [], resume = "", keywords = [], maxJobsToScore = 20 } = config;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_KEY) {
  console.error("❌ ANTHROPIC_API_KEY environment variable not set.");
  process.exit(1);
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

// ── Fetch RSS feed ────────────────────────────────────────────────────────────
async function fetchRSS(url, feedName, source) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; JobScout/1.0; RSS reader)",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
      timeout: 15000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = parser.parse(text);

    const channel = parsed?.rss?.channel || parsed?.feed;
    const rawItems = channel?.item || channel?.entry || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];

    return items.slice(0, 30).map((item) => ({
      id: String(item.guid?.["#text"] || item.id || item.link || Math.random()),
      title: stripHtml(item.title || "Untitled"),
      company: stripHtml(item["source"] || item["author"] || item["a10:author"]?.name || ""),
      link: item.link?.["@_href"] || item.link || "#",
      description: stripHtml(item.description || item.summary || item["content:encoded"] || "").slice(0, 600),
      pubDate: item.pubDate || item.published || item.updated || "",
      feedName,
      source,
      score: null,
      matchReason: "",
      keyMatches: [],
      gaps: [],
    }));
  } catch (e) {
    console.warn(`⚠ Feed "${feedName}" failed: ${e.message}`);
    return [];
  }
}

// ── Fetch Greenhouse jobs ─────────────────────────────────────────────────────
async function fetchGreenhouse(slug, feedName) {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.jobs || []).slice(0, 30).map((j) => ({
      id: String(j.id),
      title: j.title || "Untitled",
      company: slug,
      link: j.absolute_url || "#",
      description: stripHtml(j.content || "").slice(0, 600),
      pubDate: j.updated_at || "",
      feedName,
      source: "greenhouse",
      score: null,
      matchReason: "",
      keyMatches: [],
      gaps: [],
    }));
  } catch (e) {
    console.warn(`⚠ Greenhouse "${slug}" failed: ${e.message}`);
    return [];
  }
}

// ── Fetch Lever jobs ──────────────────────────────────────────────────────────
async function fetchLever(slug, feedName) {
  try {
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).slice(0, 30).map((j) => ({
      id: j.id || String(Math.random()),
      title: j.text || "Untitled",
      company: slug,
      link: j.hostedUrl || "#",
      description: (j.descriptionPlain || "").slice(0, 600),
      pubDate: j.createdAt ? new Date(j.createdAt).toISOString() : "",
      feedName,
      source: "lever",
      score: null,
      matchReason: "",
      keyMatches: [],
      gaps: [],
    }));
  } catch (e) {
    console.warn(`⚠ Lever "${slug}" failed: ${e.message}`);
    return [];
  }
}

// ── Score with Claude ─────────────────────────────────────────────────────────
async function scoreJob(job, resumeText) {
  const prompt = `You are an ATS and career advisor. Score this job posting against the candidate's resume.

RESUME:
${resumeText.slice(0, 1500)}

JOB TITLE: ${job.title}
COMPANY: ${job.company}
DESCRIPTION: ${job.description}

Return ONLY valid JSON (no markdown):
{
  "score": <0-100>,
  "matchReason": "<one sentence>",
  "keyMatches": ["<match1>", "<match2>", "<match3>"],
  "gaps": ["<gap1>", "<gap2>"]
}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", // Haiku for speed + cost efficiency in bulk scoring
        max_tokens: 250,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content?.map((b) => b.text || "").join("") || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in response");
    return JSON.parse(match[0]);
  } catch (e) {
    console.warn(`  ⚠ Scoring failed for "${job.title}": ${e.message}`);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stripHtml(str) {
  return String(str)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter((j) => {
    const key = (j.title + j.company).toLowerCase().replace(/\s+/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchesKeywords(job, kws) {
  if (!kws.length) return true;
  const hay = (job.title + " " + job.description + " " + job.company).toLowerCase();
  return kws.some((kw) => hay.includes(kw.toLowerCase()));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀 Job Scout starting — ${new Date().toISOString()}`);
  console.log(`📡 ${feeds.length} feeds configured`);

  // Fetch all feeds
  const allJobs = [];
  for (const feed of feeds) {
    console.log(`  Fetching: ${feed.name}`);
    let items = [];
    if (feed.source === "greenhouse") items = await fetchGreenhouse(feed.url, feed.name);
    else if (feed.source === "lever") items = await fetchLever(feed.url, feed.name);
    else items = await fetchRSS(feed.url, feed.name, feed.source);
    console.log(`    → ${items.length} jobs`);
    allJobs.push(...items);
  }

  // Dedupe
  const deduped = dedupe(allJobs);
  console.log(`\n📦 ${deduped.length} unique jobs after deduplication`);

  // Filter by keywords
  const filtered = matchesKeywords ? deduped.filter((j) => matchesKeywords(j, keywords)) : deduped;
  console.log(`🔑 ${filtered.length} jobs after keyword filter`);

  // Score with Claude
  if (resume.trim()) {
    const toScore = filtered
      .filter((j) => j.description && j.description.length > 50)
      .slice(0, maxJobsToScore);

    console.log(`\n⭐ Scoring ${toScore.length} jobs with Claude...`);
    for (let i = 0; i < toScore.length; i++) {
      const job = toScore[i];
      process.stdout.write(`  [${i + 1}/${toScore.length}] ${job.title.slice(0, 50)}...`);
      const result = await scoreJob(job, resume);
      if (result) {
        const idx = filtered.findIndex((j) => j.id === job.id);
        if (idx !== -1) Object.assign(filtered[idx], result);
        process.stdout.write(` ${result.score}\n`);
      } else {
        process.stdout.write(` skipped\n`);
      }
      // Small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 300));
    }
  } else {
    console.log("⚠ No resume in config — skipping scoring");
  }

  // Sort by score
  filtered.sort((a, b) => (b.score || 0) - (a.score || 0));

  // Write output
  const output = {
    fetchedAt: new Date().toISOString(),
    totalJobs: filtered.length,
    jobs: filtered,
  };

  const outDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\n✅ Done — ${filtered.length} jobs written to public/jobs.json`);
  console.log(`   Top match: "${filtered[0]?.title}" (${filtered[0]?.score ?? "unscored"})`);
}

main().catch((e) => {
  console.error("❌ Fatal error:", e);
  process.exit(1);
});
