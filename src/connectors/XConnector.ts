import { createHash } from "node:crypto";
import axios from "axios";
import { PlatformConnector } from "./BaseConnector.js";
import { isRecentDate } from "../utils/postFreshness.js";
import { PlaywrightScraperService } from "../services/PlaywrightScraperService.js";

const SEARCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const HTML_ENTITY_MAP: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: "-",
  mdash: "-",
  hellip: "...",
};

type SearchResult = {
  url: string;
  title: string;
  snippet: string;
  publishedAt?: string;
};

type SearchResultAuthor = {
  displayName: string;
  username: string;
};

export class XConnector extends PlatformConnector {
  platform = "X";
  private browserScraper = new PlaywrightScraperService();
  private rapidApiKey: string | undefined;
  private rapidApiHost: string;
  private rapidApiUrl: string;

  constructor() {
    super();
    this.rapidApiKey = process.env.RAPIDAPI_KEY;
    this.rapidApiHost = process.env.X_RAPIDAPI_HOST || "twitter-api47.p.rapidapi.com";
    this.rapidApiUrl = process.env.X_RAPIDAPI_URL || `https://${this.rapidApiHost}/v2/search`;
  }

  async fetchPosts(terms: string[]): Promise<any[]> {
    // Process terms in small batches to avoid rate limits
    const termsToSearch = terms.slice(0, 5); // Limit to 5 terms per scan to stay within free tier
    console.info(`X Connector: Searching for ${termsToSearch.length} terms...`);

    if (this.browserScraper.isEnabled()) {
      try {
        const posts = await this.browserScraper.scrapeX(termsToSearch);
        if (posts.length > 0) {
          console.info(`X Connector: Found ${posts.length} Playwright results.`);
          return this.sortNewestFirst(posts);
        }

        console.info("X Connector: Playwright returned no recent results. Falling back.");
      } catch (error: any) {
        console.error("X Connector Playwright error:", error.message);
      }
    }

    let allPosts: any[] = [];

    for (const term of termsToSearch) {
      const posts = await this.fetchPostsForTerm(term);
      allPosts = [...allPosts, ...posts];
    }

    return this.sortNewestFirst(
      Array.from(new Map(allPosts.map((post) => [post.id, post])).values())
    );
  }

  private async fetchPostsForTerm(term: string): Promise<any[]> {
    if (this.rapidApiKey) {
      try {
        return await this.fetchPostsFromRapidApi(term);
      } catch (error: any) {
        const status = error.response?.status;
        console.error(
          `X Connector Error for term "${term}":`,
          status,
          error.response?.data || error.message
        );

        if (!this.shouldFallbackToSearch(status)) {
          return [];
        }

        console.info(`X Connector: Falling back to search results for "${term}"`);
      }
    } else {
      console.warn(`X Connector: RAPIDAPI_KEY not set. Using search fallback for "${term}".`);
    }

    try {
      return await this.fetchPostsFromSearch(term);
    } catch (error: any) {
      console.error(`X search fallback failed for term "${term}":`, error.message);
      return [];
    }
  }

  private async fetchPostsFromRapidApi(term: string): Promise<any[]> {
    const response = await axios.get(this.rapidApiUrl, {
      params: {
        query: term,
        type: "Latest",
      },
      headers: {
        "x-rapidapi-key": this.rapidApiKey,
        "x-rapidapi-host": this.rapidApiHost,
      },
      timeout: 15000,
    });

    const tweets = response.data?.tweets || response.data?.data || [];
    console.info(`X Connector: Found ${Array.isArray(tweets) ? tweets.length : 0} RapidAPI results for "${term}"`);

    if (!Array.isArray(tweets)) {
      return [];
    }

    return tweets
      .map((tweet: any) => this.normalizeRapidApiTweet(tweet))
      .filter(Boolean);
  }

  private normalizeRapidApiTweet(tweet: any) {
    // RapidAPI providers return slightly different object shapes for the same search endpoint.
    const content = tweet.content || tweet;
    const tweetData = content.itemContent?.tweet_results?.result?.legacy || tweet;
    const userData = content.itemContent?.tweet_results?.result?.core?.user_results?.result?.legacy || {};

    const text = tweetData.full_text || tweetData.text || tweet.text || "";
    const authorName = userData.name || tweet.user?.name || tweet.author_name || "X User";
    const authorUsername = userData.screen_name || tweet.user?.screen_name || tweet.author_username || "unknown";
    const tweetId = tweetData.id_str || tweet.id_str || tweet.id || "";

    if (!text || !tweetId) {
      return null;
    }

    return {
      id: `x_${tweetId}`,
      text,
      authorName: `${authorName} (@${authorUsername})`,
      authorUrl: `https://x.com/${authorUsername}`,
      postUrl: `https://x.com/${authorUsername}/status/${tweetId}`,
      postedAt: tweetData.created_at
        ? new Date(tweetData.created_at).toISOString()
        : new Date().toISOString(),
      platform: "X",
      engagement: {
        likes: tweetData.favorite_count || tweet.favorite_count || 0,
        reposts: tweetData.retweet_count || tweet.retweet_count || 0,
        replies: tweetData.reply_count || tweet.reply_count || 0,
      },
    };
  }


  private async fetchPostsFromSearch(term: string): Promise<any[]> {
    const query = `site:x.com "${term}"`;
    const response = await axios.get("https://www.bing.com/search", {
      params: {
        q: query,
        format: "rss",
        setlang: "en-GB",
      },
      headers: {
        "User-Agent": SEARCH_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    const results = this.parseSearchResults(response.data);
    console.info(`X Connector: Found ${results.length} fallback search results for "${term}"`);

    return results
      .map((result) => this.normalizeSearchResult(result))
      .filter((result) => result && isRecentDate(result.postedAt))
      .filter(Boolean);
  }

  private parseSearchResults(html: string): SearchResult[] {
    return Array.from(html.matchAll(/<item>([\s\S]*?)<\/item>/gi))
      .map((match) => {
        const item = match[1] || "";
        return {
          title: this.cleanHtml(this.extractTagValue(item, "title")),
          url: this.cleanHtml(this.extractTagValue(item, "link")),
          snippet: this.cleanHtml(this.extractTagValue(item, "description")),
          publishedAt: this.cleanHtml(this.extractTagValue(item, "pubDate")),
        };
      })
      .filter((result) => result.url.includes("x.com/"));
  }

  private normalizeSearchResult(result: SearchResult) {
    const postUrl = this.extractTweetUrl(result.url);
    if (!postUrl) {
      return null;
    }

    const match = postUrl.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)\/status\/(\d+)/i);
    const authorUsername = match?.[1] || "unknown";
    const tweetId = match?.[2] || createHash("sha1").update(postUrl).digest("hex").slice(0, 16);
    const author = this.extractAuthorFromSnippet(result.snippet, authorUsername);
    const engagement = this.extractEngagementFromSnippet(result.snippet);
    const text = this.buildFallbackText(result.title, result.snippet, author);
    const publishedAt = this.parsePublishedAt(result.publishedAt);

    if (!text || !publishedAt) {
      return null;
    }

    return {
      id: `x_search_${tweetId}`,
      text,
      authorName: author.displayName,
      authorUrl: `https://x.com/${author.username}`,
      postUrl,
      postedAt: publishedAt.toISOString(),
      platform: "X",
      engagement,
    };
  }

  private shouldFallbackToSearch(status?: number) {
    return !status || [401, 402, 403, 404, 429].includes(status);
  }

  private extractTweetUrl(url: string) {
    const match = url.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/\s?#]+\/status\/\d+/i);
    return match?.[0] || null;
  }

  private extractAuthorFromSnippet(snippet: string, fallbackUsername: string): SearchResultAuthor {
    const authorMatch = snippet.match(/^(.+?)\s+\(@([A-Za-z0-9_]+)\)\./);

    if (authorMatch?.[1] && authorMatch?.[2]) {
      const display = authorMatch[1].trim();
      const username = authorMatch[2].trim();
      return {
        displayName: `${display} (@${username})`,
        username,
      };
    }

    return {
      displayName: `@${fallbackUsername}`,
      username: fallbackUsername,
    };
  }

  private extractEngagementFromSnippet(snippet: string) {
    const likes = Number(snippet.match(/(\d[\d,]*)\s+likes?/i)?.[1]?.replace(/,/g, "") || "0");
    const replies = Number(snippet.match(/(\d[\d,]*)\s+repl(?:y|ies)/i)?.[1]?.replace(/,/g, "") || "0");
    const views = Number(snippet.match(/(\d[\d,]*)\s+views?/i)?.[1]?.replace(/,/g, "") || "0");

    return {
      likes,
      reposts: 0,
      replies,
      views,
    };
  }

  private buildFallbackText(title: string, snippet: string, author: SearchResultAuthor) {
    let body = snippet
      .replace(new RegExp(`^${this.escapeRegExp(author.displayName)}\\.\\s*`, "i"), "")
      .replace(/^\d[\d,\s]*(?:likes?|repl(?:y|ies)|views?)(?:\s+\d[\d,\s]*(?:likes?|repl(?:y|ies)|views?))*\.\s*/i, "")
      .trim();

    let cleanedTitle = title
      .replace(/\s*\/\s*X$/i, "")
      .replace(/\s+on\s+X:\s*/i, ": ")
      .trim();

    if (!body) {
      body = cleanedTitle;
    } else if (cleanedTitle && !this.isNearDuplicate(cleanedTitle, body) && !this.isTitlePrefixOfBody(cleanedTitle, body)) {
      body = `${cleanedTitle}. ${body}`;
    }

    return this.normalizeSocialText(body);
  }

  private isNearDuplicate(a: string, b: string) {
    const left = this.normalizeComparisonText(a);
    const right = this.normalizeComparisonText(b);
    return !left || !right ? false : left.includes(right) || right.includes(left);
  }

  private isTitlePrefixOfBody(title: string, body: string) {
    const normalizedTitle = this.normalizeComparisonText(title);
    const normalizedBody = this.normalizeComparisonText(body);
    if (!normalizedTitle || !normalizedBody) {
      return false;
    }

    const titleWords = normalizedTitle.split(" ").filter(Boolean);
    const prefix = titleWords.slice(0, Math.min(titleWords.length, 6)).join(" ");
    return prefix.length >= 20 && normalizedBody.startsWith(prefix);
  }

  private normalizeComparisonText(value: string) {
    return value
      .toLowerCase()
      .replace(/\.\.\./g, " ")
      .replace(/[^\w#@]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalizeSocialText(value: string) {
    return value
      .replace(/\s*\.\.\.\s*/g, "... ")
      .replace(/([#@])\s+/g, "$1")
      .replace(/@\s+([A-Za-z0-9_]+)/g, "@$1")
      .replace(/\b([A-Za-z0-9]+)\s+_\s+([A-Za-z0-9]+)\b/g, "$1_$2")
      .replace(/\s+x$/i, "")
      .replace(/\s+\.\.\.$/, "...")
      .replace(/\s+/g, " ")
      .trim();
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private cleanHtml(value: string) {
    return value
      .replace(/<[^>]+>/g, " ")
      .replace(/&([a-z]+);/gi, (_, entity) => HTML_ENTITY_MAP[entity.toLowerCase()] || `&${entity};`)
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)))
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractTagValue(item: string, tag: string) {
    const match = item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return match?.[1] || "";
  }

  private parsePublishedAt(value?: string) {
    if (!value) {
      return null;
    }

    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  private sortNewestFirst(posts: any[]) {
    return [...posts].sort((left, right) => {
      const leftTime = this.toTimestamp(left.postedAt);
      const rightTime = this.toTimestamp(right.postedAt);

      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }

      return this.extractNumericId(right.id) - this.extractNumericId(left.id);
    });
  }

  private toTimestamp(value: unknown) {
    const timestamp = new Date(String(value || "")).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private extractNumericId(value: unknown) {
    const match = String(value || "").match(/(\d{6,})/);
    return match ? Number(match[1]) : 0;
  }
}
