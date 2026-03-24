import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

type ScrapedPost = {
  id: string;
  text: string;
  authorName: string;
  authorUrl: string;
  postUrl: string;
  postedAt: string;
  platform: "X" | "LinkedIn";
  engagement?: Record<string, number>;
};

export class PlaywrightScraperService {
  private browserPromise: Promise<Browser> | null = null;
  private readonly enabled;
  private readonly headless;
  private readonly timeoutMs;
  private readonly maxPostsPerTerm;

  constructor() {
    this.enabled = (process.env.PLAYWRIGHT_SCRAPER_ENABLED || "").trim() === "true";
    this.headless = (process.env.PLAYWRIGHT_HEADLESS || "true").trim() !== "false";
    this.timeoutMs = Number(process.env.PLAYWRIGHT_TIMEOUT_MS || 45000);
    this.maxPostsPerTerm = Number(process.env.PLAYWRIGHT_MAX_POSTS_PER_TERM || 10);
  }

  isEnabled() {
    return this.enabled;
  }

  async scrapeX(terms: string[]) {
    return this.withPage("x", async (page, context) => {
      const isLoggedIn = await this.ensureXLogin(page, context);
      if (!isLoggedIn) {
        return [];
      }
      const allPosts: ScrapedPost[] = [];

      for (const term of terms.slice(0, 5)) {
        const url = `https://x.com/search?q=${encodeURIComponent(term)}&src=typed_query&f=live`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
        await page.waitForTimeout(2500);
        await this.scrollPage(page, 3);

        const termPosts = await page.evaluate((limit) => {
          const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));

          return articles.slice(0, limit).map((article) => {
            const statusAnchor = article.querySelector<HTMLAnchorElement>('a[href*="/status/"]');
            const timeEl = article.querySelector<HTMLTimeElement>("time");
            const text = Array.from(article.querySelectorAll('[data-testid="tweetText"]')).map((node) => node.textContent || "").join(" ").trim();
            const userNameBlock = article.querySelector('div[data-testid="User-Name"]');
            const displayName = userNameBlock?.querySelector("span")?.textContent?.trim() || "X User";
            const statusPath = statusAnchor?.getAttribute("href") || "";
            const usernameMatch = statusPath.match(/^\/([^/]+)\/status\//);
            const username = usernameMatch?.[1] || "unknown";

            const metricValue = (testId: string) => {
              const metric = article.querySelector(`[data-testid="${testId}"]`);
              const raw = metric?.textContent?.replace(/[^\d.]/g, "") || "0";
              return Number(raw || "0");
            };

            return {
              id: statusPath.split("/status/")[1] || "",
              text,
              authorName: displayName,
              authorUrl: username === "unknown" ? "" : `https://x.com/${username}`,
              postUrl: statusPath ? `https://x.com${statusPath}` : "",
              postedAt: timeEl?.dateTime || "",
              platform: "X" as const,
              engagement: {
                replies: metricValue("reply"),
                reposts: metricValue("retweet"),
                likes: metricValue("like"),
              },
            };
          });
        }, this.maxPostsPerTerm);

        allPosts.push(...termPosts.filter((post) => post.id && post.text && post.postUrl && post.postedAt));
      }

      return this.dedupePosts(allPosts);
    });
  }

  async scrapeLinkedIn(terms: string[]) {
    return this.withPage("linkedin", async (page, context) => {
      const isLoggedIn = await this.ensureLinkedInLogin(page, context);
      if (!isLoggedIn) {
        return [];
      }
      const allPosts: ScrapedPost[] = [];

      for (const term of terms.slice(0, 5)) {
        const url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(term)}&sortBy=%22date_posted%22`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
        await page.waitForTimeout(3000);
        await this.scrollPage(page, 4);

        const termPosts = await page.evaluate((limit) => {
          const anchors = Array.from(
            document.querySelectorAll<HTMLAnchorElement>('a[href*="/posts/"], a[href*="/feed/update/urn:li:activity:"]')
          );

          const seen = new Set<string>();
          const posts = [];

          for (const anchor of anchors) {
            const href = anchor.href;
            if (!href || seen.has(href)) {
              continue;
            }

            seen.add(href);
            const container =
              anchor.closest("li") ||
              anchor.closest("div[data-chameleon-result-urn]") ||
              anchor.closest("div.search-result__info") ||
              anchor.parentElement;

            const containerText = container?.textContent?.replace(/\s+/g, " ").trim() || "";
            const postedAtMatch = containerText.match(/(\d+\s*(?:m|h|d|w|mo|yr)s?)/i);
            const authorAnchor = container?.querySelector<HTMLAnchorElement>('a[href*="/in/"], a[href*="/company/"]');
            const authorName = authorAnchor?.textContent?.replace(/\s+/g, " ").trim() || "LinkedIn User";

            posts.push({
              id: href.split("activity-")[1]?.split(/[?&]/)[0] || href,
              text: containerText,
              authorName,
              authorUrl: authorAnchor?.href || href,
              postUrl: href,
              postedAtLabel: postedAtMatch?.[1] || "",
              platform: "LinkedIn" as const,
            });

            if (posts.length >= limit) {
              break;
            }
          }

          return posts;
        }, this.maxPostsPerTerm);

        allPosts.push(
          ...termPosts
            .map((post) => ({
              ...post,
              postedAt: this.resolveRelativeTime(post.postedAtLabel)?.toISOString() || "",
              engagement: {},
            }))
            .filter((post) => post.id && post.text && post.postUrl && post.postedAt)
        );
      }

      return this.dedupePosts(allPosts);
    });
  }

  private async withPage(
    platform: "x" | "linkedin",
    callback: (page: Page, context: BrowserContext) => Promise<ScrapedPost[]>,
  ) {
    if (!this.enabled) {
      return [];
    }

    const browser = await this.getBrowser();
    const storageState = this.getStorageStatePath(platform);
    const contextOptions: Parameters<Browser["newContext"]>[0] = {
      viewport: { width: 1440, height: 1600 },
      locale: "en-GB",
      timezoneId: "Europe/London",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    };

    if (storageState && fs.existsSync(storageState)) {
      contextOptions.storageState = storageState;
    }

    const context = await browser.newContext(contextOptions);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      Object.defineProperty(navigator, "languages", { get: () => ["en-GB", "en"] });
    });

    try {
      const page = await context.newPage();
      page.setDefaultTimeout(this.timeoutMs);
      return await callback(page, context);
    } finally {
      if (storageState) {
        await this.saveStorageState(context, storageState);
      }

      await context.close();
    }
  }

  private async getBrowser() {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({
        headless: this.headless,
        args: ["--disable-blink-features=AutomationControlled"],
      });
    }

    return this.browserPromise;
  }

  private async ensureXLogin(page: Page, context: BrowserContext) {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: this.timeoutMs });

    if (this.isXAuthenticated(page)) {
      return true;
    }

    const login = ((process.env.X_SCRAPER_LOGIN || "").trim() || (process.env.X_SCRAPER_USERNAME || "").trim());
    const username = (process.env.X_SCRAPER_USERNAME || "").trim();
    const password = (process.env.X_SCRAPER_PASSWORD || "").trim();

    if (!login || !password) {
      return false;
    }

    await page.goto("https://x.com/i/flow/login", { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    const identifierInput = page.locator('input[autocomplete="username"], input[name="text"]');
    await identifierInput.first().waitFor({ state: "visible", timeout: this.timeoutMs });
    await identifierInput.first().fill(login);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);

    const challengeInput = page.locator('input[data-testid="ocfEnterTextTextInput"], input[name="text"]');
    if ((await challengeInput.count()) > 0 && username && login !== username) {
      await challengeInput.first().fill(username);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
    }

    const passwordInput = page.locator('input[name="password"]');
    if ((await passwordInput.count()) === 0) {
      return false;
    }

    await passwordInput.first().fill(password);
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded", { timeout: this.timeoutMs }).catch(() => undefined);
    await page.waitForTimeout(2500);

    if (!this.isXAuthenticated(page)) {
      return false;
    }

    await this.saveStorageState(context, this.getStorageStatePath("x"));
    return true;
  }

  private async ensureLinkedInLogin(page: Page, context: BrowserContext) {
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: this.timeoutMs });

    if (this.isLinkedInAuthenticated(page)) {
      return true;
    }

    const email = (process.env.LINKEDIN_SCRAPER_EMAIL || "").trim();
    const password = (process.env.LINKEDIN_SCRAPER_PASSWORD || "").trim();

    if (!email || !password) {
      return false;
    }

    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
    await page.locator('input[name="session_key"]').fill(email);
    await page.locator('input[name="session_password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForLoadState("domcontentloaded", { timeout: this.timeoutMs }).catch(() => undefined);
    await page.waitForTimeout(2500);

    if (!this.isLinkedInAuthenticated(page)) {
      return false;
    }

    await this.saveStorageState(context, this.getStorageStatePath("linkedin"));
    return true;
  }

  private async scrollPage(page: Page, iterations: number) {
    for (let index = 0; index < iterations; index += 1) {
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 1.5);
      });
      await page.waitForTimeout(1200);
    }
  }

  private resolveRelativeTime(label: string) {
    const match = label.trim().match(/^(\d+)\s*(m|h|d|w|mo|yr)s?$/i);
    if (!match) {
      return null;
    }

    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase() || "";
    const now = new Date();
    const multipliers: Record<string, number> = {
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
      mo: 30 * 24 * 60 * 60 * 1000,
      yr: 365 * 24 * 60 * 60 * 1000,
    };

    return new Date(now.getTime() - amount * (multipliers[unit] || 0));
  }

  private dedupePosts(posts: ScrapedPost[]) {
    return Array.from(new Map(posts.map((post) => [post.id, post])).values());
  }

  private getStorageStatePath(platform: "x" | "linkedin") {
    const rawPath = (platform === "x"
      ? process.env.X_SCRAPER_STORAGE_STATE
      : process.env.LINKEDIN_SCRAPER_STORAGE_STATE) || "";
    const trimmed = rawPath.trim();
    return trimmed ? path.resolve(trimmed) : "";
  }

  private async saveStorageState(context: BrowserContext, storageStatePath?: string) {
    if (!storageStatePath) {
      return;
    }

    fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
    await context.storageState({ path: storageStatePath });
  }

  private isXAuthenticated(page: Page) {
    const url = page.url();
    return !url.includes("/login") && !url.includes("/i/flow/login");
  }

  private isLinkedInAuthenticated(page: Page) {
    const url = page.url();
    return !url.includes("/login") && !url.includes("/checkpoint/");
  }
}
