# Journo Request Monitor

A production-ready Node.js application to monitor X/Twitter and LinkedIn for journalist request opportunities (e.g., #journorequest) and deliver relevant leads to your email.

## Features
- **Sources**: Monitors X (Twitter) and LinkedIn.
- **Accounts**: Multiple users can register, log in, and keep separate dashboards, keywords, posts, and run history.
- **Per-User Scheduling**: Each account can choose how often searches run and how often digest emails are sent.
- **In-App Browser Scraper**: Optional Playwright-based scraping for X and LinkedIn from inside the app on always-on Node hosting.
- **X Fallback**: Uses RapidAPI when available and falls back to public search results if the X endpoint is unavailable or unsubscribed.
- **LinkedIn Fallback**: Uses RapidAPI when available and falls back to public search results if the LinkedIn endpoint is unavailable or unsubscribed.
- **Scoring**: Ranks posts out of 100 based on niche keywords, urgency, and author expertise.
- **Priority Digest**: Groups leads into High, Medium, and Low priority.
- **Instant Alerts**: Sends immediate emails for high-priority matching leads.
- **Dashboard**: Simple admin panel to view history, captured leads, and manually trigger scans.
- **Deduplication**: Ensures you never receive the same lead twice.
- **Configurable**: Easily add/remove search terms and niche keywords via the dashboard.

## Tech Stack
- **Runtime**: Node.js (v20+) with TypeScript
- **Database**: PostgreSQL (via Prisma 7 + `@prisma/adapter-pg`)
- **Scheduling**: node-cron
- **Email**: Resend API
- **UI**: Express with EJS templates

## Setup Instructions

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   Copy `.env.example` to `.env` and fill in your details:
   - `DATABASE_URL`: PostgreSQL connection string. This is required in both local and production environments.
   - `RESEND_API_KEY`: Resend API key for outbound email delivery.
   - `EMAIL_FROM`: The sender name/address for outgoing digests.
   - `RESEND_TEST_MODE=true`: Optional temporary sandbox mode that sends from `onboarding@resend.dev` while your custom domain is still unverified.
   - `APP_URL`: Public base URL used in email links.
   - `SCHEDULER_TICK_CRON`: How often the app checks which users are due for a scan or digest. Default is every 5 minutes.
   - `PLAYWRIGHT_SCRAPER_ENABLED=true`: Enables the in-app browser scraper.
   - `PLAYWRIGHT_HEADLESS`, `PLAYWRIGHT_TIMEOUT_MS`, `PLAYWRIGHT_MAX_POSTS_PER_TERM`: Runtime controls for the browser worker.
   - `X_SCRAPER_LOGIN`, `X_SCRAPER_USERNAME`, and `X_SCRAPER_PASSWORD`: X login for the browser scraper. `X_SCRAPER_LOGIN` can be the email or phone used on the first step, while `X_SCRAPER_USERNAME` handles X's extra username challenge when needed.
   - `LINKEDIN_SCRAPER_EMAIL` and `LINKEDIN_SCRAPER_PASSWORD`: Optional LinkedIn login for the browser scraper.
   - `X_SCRAPER_STORAGE_STATE` and `LINKEDIN_SCRAPER_STORAGE_STATE`: Optional Playwright session files for cookie reuse.
   - `RAPIDAPI_KEY`: Optional shared RapidAPI key for scrapers.
   - `LINKEDIN_RAPIDAPI_KEY`: Recommended if you want LinkedIn enabled while X stays on the free fallback.
   - `X_RAPIDAPI_HOST` and `X_RAPIDAPI_URL`: Optional if you want to point X at a different RapidAPI scraper provider.
   - If the configured X RapidAPI endpoint is missing or unsubscribed, the app falls back to public search results.
   - If the configured LinkedIn RapidAPI endpoint is missing or unsubscribed, the app falls back to public search results.

3. **Initialize Database**:
   ```bash
   npm run prisma:push
   ```

4. **Run the App**:
   ```bash
   # Development
   npm run dev

   # Production
   npm run build
   npm start
   ```

## Local Development
- The app runs a dashboard at `http://localhost:3000`.
- Register a user at `http://localhost:3000/register` before using the dashboard.
- Each user configures their own scan and email schedule in the dashboard.
- You can trigger a manual scan from the dashboard.
- To use the in-app scraper locally, install the browser binary once with `npx playwright install chromium`.

## Browser Scraper Notes
- The Playwright scraper is designed for always-on Node hosting, not Vercel serverless.
- X browser scraping generally needs a logged-in session to avoid the public anti-bot wall.
- LinkedIn browser scraping is much more reliable with a logged-in session.
- The current implementation tries Playwright first only when `PLAYWRIGHT_SCRAPER_ENABLED=true`, then falls back to the existing RapidAPI or public-search providers.

## How to Test Email Output
1. Set your `RESEND_API_KEY` and `EMAIL_FROM` in `.env`.
2. Find or create a post that matches your keywords (or use the mock data triggered by a manual scan).
3. Check your recipient email for the "Journo Request Digest".

## Adding More Platforms
To add a new platform (e.g., Threads or Mastodon):
1. Create a new connector in `src/connectors/BrandNameConnector.ts` extending `PlatformConnector`.
2. Implement the `fetchPosts` method.
3. Add the connector to the `MonitorService` constructor in `src/services/MonitorService.ts`.

## Compliance Note
This app uses third-party APIs and public search-result fallbacks. Review the relevant platform and provider Terms of Service before running it in production.

## Deployment Note
On always-on Node hosting, `SCHEDULER_TICK_CRON` handles automatic scans and digests. On serverless platforms such as Vercel, you need an external cron or platform cron that calls `/api/cron` often enough for the per-user schedules you configure. Production should use a persistent PostgreSQL `DATABASE_URL`, not a local file database.

## Playwright Deployment
- Use an always-on host for the in-app scraper. This repo now includes `Dockerfile` and `render.yaml` for Render-style deployment.
- Set `PLAYWRIGHT_SCRAPER_ENABLED=true` and provide the X and LinkedIn scraper credentials in the host environment.
- Keep `/api/cron` running on a schedule so per-user scans and digests continue in production.
- The Docker startup on Render now runs `prisma db push` before starting the app, so a fresh Render Postgres database can bootstrap automatically.

## Resend Domain Verification
If you want to send to real recipients from `easy-ai.co.uk`, verify that domain inside Resend first. Until the domain is verified, Resend only allows sandbox/test sending and will reject normal delivery.
