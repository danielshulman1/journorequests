# Journo Request Monitor

A production-ready Node.js application to monitor X/Twitter and LinkedIn for journalist request opportunities (e.g., #journorequest) and deliver relevant leads to your email.

## Features
- **Sources**: Monitors X (Twitter) and LinkedIn.
- **Scoring**: Ranks posts out of 100 based on niche keywords, urgency, and author expertise.
- **Priority Digest**: Groups leads into High, Medium, and Low priority.
- **Instant Alerts**: Sends immediate emails for high-priority matching leads.
- **Dashboard**: Simple admin panel to view history, captured leads, and manually trigger scans.
- **Deduplication**: Ensures you never receive the same lead twice.
- **Configurable**: Easily add/remove search terms and niche keywords via the dashboard.

## Tech Stack
- **Runtime**: Node.js (v20+) with TypeScript
- **Database**: SQLite (via Prisma 7)
- **Scheduling**: node-cron
- **Email**: Nodemailer (SMTP)
- **UI**: Express with EJS templates

## Setup Instructions

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   Copy `.env.example` to `.env` and fill in your details:
   - `SMTP_USER` & `SMTP_PASS`: Your email credentials (e.g., Gmail App Password).
   - `EMAIL_TO`: Where you want to receive digests.
   - `X_BEARER_TOKEN`: Official Twitter API Bearer Token (optional, falls back to mock data).

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
- Scans run automatically every hour.
- You can trigger a manual scan from the dashboard.

## How to Test Email Output
1. Set your `SMTP` details in `.env`.
2. Find or create a post that matches your keywords (or use the mock data triggered by a manual scan).
3. Check your recipient email for the "Journo Request Digest".

## Adding More Platforms
To add a new platform (e.g., Threads or Mastodon):
1. Create a new connector in `src/connectors/BrandNameConnector.ts` extending `PlatformConnector`.
2. Implement the `fetchPosts` method.
3. Add the connector to the `MonitorService` constructor in `src/services/MonitorService.ts`.

## Compliance Note
This app is designed to use official APIs. If you use scraping techniques, ensure compliance with the platform's Terms of Service.
