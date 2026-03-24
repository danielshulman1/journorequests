import { createHash } from "node:crypto";
import axios from "axios";
import { PlatformConnector } from "./BaseConnector.js";
import { isRecentDate } from "../utils/postFreshness.js";
import { PlaywrightScraperService } from "../services/PlaywrightScraperService.js";

const SEARCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const FALLBACK_POST_AGE_HOURS = 25;
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
};

export class LinkedInConnector extends PlatformConnector {
  platform = "LinkedIn";
  private browserScraper = new PlaywrightScraperService();
  private apiKey: string | undefined;

  constructor() {
    super();
    this.apiKey = process.env.LINKEDIN_RAPIDAPI_KEY || process.env.RAPIDAPI_KEY;
  }

  async fetchPosts(terms: string[]): Promise<any[]> {
    const termsToSearch = terms.slice(0, 5);
    console.info(`LinkedIn Scraper: Searching for ${termsToSearch.length} terms...`);

    if (this.browserScraper.isEnabled()) {
      try {
        const posts = await this.browserScraper.scrapeLinkedIn(termsToSearch);
        if (posts.length > 0) {
          console.info(`LinkedIn Scraper: Found ${posts.length} Playwright results.`);
          return this.sortNewestFirst(posts);
        }

        console.info("LinkedIn Scraper: Playwright returned no recent results. Falling back.");
      } catch (error: any) {
        console.error("LinkedIn Scraper Playwright error:", error.message);
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
    if (this.apiKey) {
      try {
        return await this.fetchPostsFromRapidApi(term);
      } catch (error: any) {
        const status = error.response?.status;
        console.error(`LinkedIn Scraper Error for term "${term}":`, error.response?.data || error.message);
        if (!this.shouldFallbackToSearch(status)) {
          return [];
        }
        console.info(`LinkedIn Scraper: Falling back to search results for "${term}"`);
      }
    } else {
      console.warn(`LinkedIn Scraper: LINKEDIN_RAPIDAPI_KEY not found. Using search fallback for "${term}".`);
    }

    try {
      return await this.fetchPostsFromSearch(term);
    } catch (error: any) {
      console.error(`LinkedIn search fallback failed for term "${term}":`, error.message);
      return [];
    }
  }

  private async fetchPostsFromRapidApi(term: string): Promise<any[]> {
    const response = await axios.get("https://linkedin-api-all-endpoints.p.rapidapi.com/post-search", {
      params: {
        keywords: term,
        start: "0",
      },
      headers: {
        "x-rapidapi-key": this.apiKey,
        "x-rapidapi-host": "linkedin-api-all-endpoints.p.rapidapi.com",
      },
      timeout: 15000,
    });

    const posts = response.data?.items || response.data || [];
    console.info(`LinkedIn Scraper: Found ${Array.isArray(posts) ? posts.length : 0} RapidAPI results for "${term}"`);

    if (!Array.isArray(posts)) {
      return [];
    }

    return posts.map((post: any) => ({
      id: post.post_id || post.urn,
      text: post.text || "",
      authorName: post.author_name || post.author_title || "LinkedIn User",
      authorUrl: post.author_profile_url || "",
      postUrl: post.post_url || `https://www.linkedin.com/feed/update/${post.urn}`,
      postedAt: post.posted_at ? new Date(post.posted_at).toISOString() : new Date().toISOString(),
      platform: "LinkedIn",
      engagement: {
        likes: post.num_reactions || 0,
        comments: post.num_comments || 0,
      },
    }));
  }


  private async fetchPostsFromSearch(term: string): Promise<any[]> {
    const normalizedTerm = this.normalizeSearchTerm(term);
    const queries = [
      `site:linkedin.com/feed/update ${normalizedTerm}`,
      `site:linkedin.com/posts ${normalizedTerm}`,
    ];

    let allResults: SearchResult[] = [];

    for (const query of queries) {
      const response = await axios.get(this.buildJinaYahooUrl(query), {
        headers: {
          "User-Agent": SEARCH_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 20000,
      });

      const results = this.parseSearchResults(response.data);
      allResults = [...allResults, ...results];
    }

    const dedupedResults = Array.from(new Map(allResults.map((result) => [result.url, result])).values());
    console.info(`LinkedIn Scraper: Found ${dedupedResults.length} fallback search results for "${term}"`);

    return dedupedResults
      .map((result) => this.normalizeSearchResult(result))
      .filter(Boolean);
  }

  private parseSearchResults(html: string): SearchResult[] {
    return Array.from(
      html.matchAll(/\d+\.\s+\[\!\[Image[^\]]*\]\([^)]+\)\s+[^\]]*###\s+([^\]]+)\]\((https:\/\/www\.linkedin\.com\/[^)]+)\)\s+([\s\S]*?)(?=\n\d+\.\s+\[\!\[Image|\n1\.\s+\*\*1\*\*|\n\Z)/g)
    )
      .map((match) => ({
        title: this.cleanHtml(match[1] || ""),
        url: this.cleanHtml(match[2] || ""),
        snippet: this.cleanHtml((match[3] || "").replace(/\s+/g, " ").trim()),
      }))
      .filter((result) => result.url.includes("linkedin.com/"));
  }

  private normalizeSearchResult(result: SearchResult) {
    const postUrl = this.extractLinkedInPostUrl(result.url);
    if (!postUrl) {
      return null;
    }

    const postId = this.extractLinkedInPostId(postUrl);
    const authorName = this.extractAuthorName(result.title, result.snippet);
    const text = this.buildFallbackText(result.title, result.snippet, authorName);
    const engagement = this.extractEngagement(result.title, result.snippet);

    if (!text) {
      return null;
    }

    return {
      id: `linkedin_search_${postId}`,
      text,
      authorName,
      authorUrl: postUrl,
      postUrl,
      postedAt: new Date(Date.now() - FALLBACK_POST_AGE_HOURS * 60 * 60 * 1000).toISOString(),
      platform: "LinkedIn",
      engagement,
    };
  }

  private shouldFallbackToSearch(status?: number) {
    return !status || [401, 402, 403, 404, 429].includes(status);
  }

  private extractLinkedInPostUrl(url: string) {
    const match = url.match(
      /https?:\/\/(?:[\w-]+\.)?linkedin\.com\/(?:feed\/update\/urn:li:activity:\d+\/?|posts\/[^\s?#"]+)/i
    );
    return match?.[0] || null;
  }

  private extractLinkedInPostId(url: string) {
    const activityId = url.match(/activity[:/-](\d{8,})/i)?.[1];
    if (activityId) {
      return activityId;
    }

    return createHash("sha1").update(url).digest("hex").slice(0, 16);
  }

  private extractAuthorName(title: string, snippet: string) {
    const titleByPipe = title.match(/^[^|]+?\|\s*([^|]+?)\s*(?:\||- LinkedIn)/i)?.[1]?.trim();
    if (titleByPipe && !/^#/.test(titleByPipe)) {
      return titleByPipe;
    }

    const titleOnLinkedIn = title.match(/^(.+?)\s+on LinkedIn:/i)?.[1]?.trim();
    if (titleOnLinkedIn) {
      return titleOnLinkedIn;
    }

    const snippetLead = snippet.match(/^(.+?)\s+on LinkedIn\b/i)?.[1]?.trim();
    if (snippetLead && snippetLead.length < 80 && !snippetLead.includes("...")) {
      return snippetLead;
    }

    return "LinkedIn User";
  }

  private buildFallbackText(title: string, snippet: string, authorName: string) {
    const normalizedTitle = title
      .replace(/\|\s*\d+\s+comments?\s*-\s*LinkedIn$/i, "")
      .replace(/\s*-\s*LinkedIn$/i, "")
      .replace(/^.+?\s+on LinkedIn:\s*/i, "")
      .replace(/\s*##\s*Searches related to[\s\S]*$/i, "")
      .trim();

    let body = snippet
      .replace(/\|\s*\d+\s+comments?\s+on LinkedIn$/i, "")
      .replace(/\s+on LinkedIn$/i, "")
      .replace(/\s*##\s*Searches related to[\s\S]*$/i, "")
      .replace(/\b\d+\.\s*$/i, "")
      .trim();

    if (authorName !== "LinkedIn User") {
      body = body.replace(new RegExp(`^${this.escapeRegExp(authorName)}\\s*[:|-]?\\s*`, "i"), "").trim();
    }

    if (!body) {
      body = normalizedTitle;
    } else if (
      normalizedTitle &&
      !this.isNearDuplicate(normalizedTitle, body) &&
      !this.isMetadataStyleTitle(normalizedTitle, authorName)
    ) {
      body = `${normalizedTitle}. ${body}`;
    }

    return this.normalizeText(body);
  }

  private extractEngagement(title: string, snippet: string) {
    const source = `${title} ${snippet}`;
    const comments = Number(source.match(/(\d[\d,]*)\s+comments?/i)?.[1]?.replace(/,/g, "") || "0");
    return {
      likes: 0,
      comments,
    };
  }

  private isNearDuplicate(a: string, b: string) {
    const left = this.normalizeComparisonText(a);
    const right = this.normalizeComparisonText(b);
    return !left || !right ? false : left.includes(right) || right.includes(left);
  }

  private isMetadataStyleTitle(title: string, authorName: string) {
    if (!title || authorName === "LinkedIn User") {
      return false;
    }

    const normalizedTitle = this.normalizeComparisonText(title);
    const normalizedAuthor = this.normalizeComparisonText(authorName);
    return normalizedTitle.includes(normalizedAuthor) && /#\w+/.test(title);
  }

  private normalizeComparisonText(value: string) {
    return value
      .toLowerCase()
      .replace(/\.\.\./g, " ")
      .replace(/[^\w#@]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalizeText(value: string) {
    return value
      .replace(/\*\*/g, "")
      .replace(/\s*##\s*Searches related to[\s\S]*$/i, "")
      .replace(/([#@])\s+/g, "$1")
      .replace(/\b\d+\.\s+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private normalizeSearchTerm(value: string) {
    return value.replace(/#/g, "").trim();
  }

  private buildJinaYahooUrl(query: string) {
    return `https://r.jina.ai/http://search.yahoo.com/search?q=${encodeURIComponent(query)}`;
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

  private sortNewestFirst(posts: any[]) {
    return [...posts].sort((left, right) => {
      const leftTime = this.toTimestamp(left.postedAt);
      const rightTime = this.toTimestamp(right.postedAt);

      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }

      return String(right.id || "").localeCompare(String(left.id || ""));
    });
  }

  private toTimestamp(value: unknown) {
    const timestamp = new Date(String(value || "")).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
}
