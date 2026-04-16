# Job Scout — Daily Automated Job Tracker

Automatically fetches job listings from Indeed, Google Jobs, Greenhouse, and Lever every morning, scores them against your resume using Claude, and saves the results so they're ready when you open the app.

## Setup (15 minutes)

### Step 1 — Create the GitHub repo

1. Go to [github.com/new](https://github.com/new)
2. Name it `job-scout` (or anything you like)
3. Set it to **Private**
4. Click **Create repository**

### Step 2 — Upload these files

Upload the entire contents of this folder to your new repo. You can drag and drop files directly in the GitHub UI, or use Git:

```bash
git clone https://github.com/YOUR_USERNAME/job-scout.git
cd job-scout
# copy all files here, then:
git add .
git commit -m "Initial setup"
git push
```

### Step 3 — Add your Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com) → API Keys → Create key
2. In your GitHub repo, go to **Settings → Secrets and variables → Actions**
3. Click **New repository secret**
4. Name: `ANTHROPIC_API_KEY`
5. Value: paste your API key
6. Click **Add secret**

### Step 4 — Configure your feeds and resume

1. In your repo, go to `scripts/`
2. Copy `config.example.json` → rename to `config.json`
3. Edit `config.json`:
   - Add your feed URLs (copy them from the Job Scout app's Feeds tab)
   - Add your keywords
   - Paste your resume text into the `"resume"` field
4. Commit and push

> ⚠️ **Important:** `config.json` contains your resume. The repo is private, but never commit API keys to the file — use GitHub Secrets for that (already done in Step 3).

### Step 5 — Test it manually

1. In your repo, go to **Actions** tab
2. Click **Daily Job Fetch** workflow
3. Click **Run workflow** → **Run workflow**
4. Watch the logs — it should fetch jobs and commit `public/jobs.json`

### Step 6 — Open the tracker app

The Job Scout app in Claude will automatically detect and load results from `public/jobs.json` when you open it — jobs will be pre-fetched and pre-scored, ready to review.

---

## Schedule

The workflow runs **Monday–Friday at 7:00 AM Eastern** by default.

To change the time, edit `.github/workflows/daily-fetch.yml`:

```yaml
- cron: '0 12 * * 1-5'   # 12 UTC = 7am ET
- cron: '0 13 * * 1-5'   # 13 UTC = 8am ET
- cron: '0 14 * * 1-5'   # 9am ET
- cron: '0 12 * * 1-7'   # Include weekends
```

[Cron expression helper →](https://crontab.guru)

---

## Cost

- **GitHub Actions**: Free (2,000 minutes/month on free tier — this uses ~2 min/day)
- **Claude API**: Uses `claude-haiku` for bulk scoring — roughly **$0.01–0.05 per daily run** depending on number of jobs scored
- **Total**: Essentially free

---

## Config reference

```json
{
  "feeds": [
    {
      "id": "unique-id",
      "name": "Display name",
      "url": "https://... (RSS URL or company slug for Greenhouse/Lever)",
      "source": "indeed | rss | greenhouse | lever",
      "type": "rss | greenhouse | lever"
    }
  ],
  "keywords": ["keyword1", "keyword2"],
  "resume": "Your full resume text here",
  "maxJobsToScore": 20
}
```

**`maxJobsToScore`**: How many jobs to score with Claude per run. Higher = more cost. 20 is a good default.

---

## Troubleshooting

**Workflow fails with permission error**
→ Go to repo Settings → Actions → General → set "Workflow permissions" to "Read and write"

**No jobs appearing**
→ Check the workflow logs in the Actions tab for feed errors. RSS URLs can change — verify them in the Feeds tab of the app.

**Scores seem off**
→ Make sure your resume in `config.json` is the full plain text version, not a PDF path.
