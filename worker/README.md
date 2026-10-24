# FreePeriod shared AI server

This tiny Cloudflare Worker lets judges and friends use FreePeriod's AI without their own API key. Your key stays on Cloudflare, never in the app's code.

## Set it up (about 10 minutes, free)
1. Make a free account at https://dash.cloudflare.com
2. Go to **Workers & Pages** → **Create** → **Create Worker**. Name it `freeperiod-ai` and click **Deploy**.
3. Click **Edit code**, delete everything, paste in `worker.js` from this folder, and click **Deploy**.
4. Go to the Worker's **Settings** → **Variables and Secrets** → **Add**:
   - Type **Secret**, name `ANTHROPIC_API_KEY`, value: your Anthropic key. Save.
5. (Recommended) Turn on daily limits:
   - **Storage & Databases** → **KV** → **Create** a namespace called `freeperiod-limits`.
   - Back in the Worker: **Settings** → **Bindings** → **Add** → **KV namespace**. Variable name `LIMITS`, pick `freeperiod-limits`. Deploy.
6. Copy your Worker's address, e.g. `https://freeperiod-ai.yourname.workers.dev`.
7. In `app.js`, paste it into `const PROXY_URL = '';` near the top, and push to GitHub.
8. In the Anthropic Console, set a monthly spend limit (e.g. $5) as a safety net.

## Test it
Open FreePeriod, go to **Settings**. It should say "AI is on, using the shared server." Then try **Try a sample timetable** and plan a free period.

## What it protects against
- Only your site (and localhost while testing) can use it.
- The model and maximum reply length are fixed on the server.
- With the `LIMITS` binding: 40 requests per person and 400 in total per day (change with `PER_IP_DAILY` and `GLOBAL_DAILY`).
