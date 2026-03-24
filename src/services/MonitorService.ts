import { prisma } from "../db/prisma.js";
import { XConnector } from "../connectors/XConnector.js";
import { LinkedInConnector } from "../connectors/LinkedInConnector.js";
import { RelevanceScorer } from "./RelevanceScorer.js";
import type { NormalizedPost } from "../types/index.js";

export class MonitorService {
  private connectors = [new XConnector(), new LinkedInConnector()];

  async run(manual = false) {
    const startTime = new Date();
    let resultsFound = 0;
    let resultsEmailed = 0;
    let errorMessage: string | null = null;
    let newPosts: NormalizedPost[] = [];

    try {
      // 1. Get Active Terms and Keywords
      const termsFromDb = await prisma.searchTerm.findMany({ where: { isActive: true } });
      const keywordsFromDb = await prisma.nicheKeyword.findMany({ where: { isActive: true } });

      const terms = termsFromDb.map((t) => t.term);
      const keywords = keywordsFromDb.map((k) => k.keyword);

      // 2. Fetch from Connectors
      for (const connector of this.connectors) {
        console.info(`Monitoring ${connector.platform}...`);
        const rawPosts = await connector.fetchPosts(terms);

        for (const raw of rawPosts) {
          // Check if already seen
          const existing = await prisma.post.findUnique({
            where: { externalId: raw.id || raw.externalId },
          });

          if (existing) continue;

          // Score and Normalize
          const scored = RelevanceScorer.score(raw, terms, keywords);
          
          // CRITICAL: Only include post if it matched at least one of the user's Niche Keywords
          if (scored.matchedKeywords.length === 0) {
            console.debug(`Skipping post: No matching niche keywords found in "${scored.text.substring(0, 30)}..."`);
            continue;
          }

          // Optional: Filtering rules (e.g. skip if score too low)
          if (scored.relevanceScore < Number(process.env.RELEVANCE_THRESHOLD || 20)) continue;

          // Save to DB
          await prisma.post.create({
            data: {
              platform: scored.platform,
              externalId: scored.externalId,
              authorName: scored.authorName,
              authorUrl: scored.authorUrl,
              text: scored.text,
              postUrl: scored.postUrl,
              postedAt: scored.postedAt,
              engagement: JSON.stringify(scored.engagement),
              matchedTerms: scored.matchedTerms.join(", "),
              matchedKeywords: scored.matchedKeywords.join(", "),
              relevanceScore: scored.relevanceScore,
              priority: scored.priority,
              isUrgent: scored.isUrgent,
              hasDeadline: scored.hasDeadline,
              isJournalist: scored.isJournalist,
            },
          });

          newPosts.push(scored);
          resultsFound++;
        }
      }

      console.info(`Monitor run complete. ${resultsFound} new posts found.`);

    } catch (error: any) {
      console.error("Monitor Run Error:", error);
      errorMessage = error.message;
    } finally {
      // Log the run
      await prisma.runLog.create({
        data: {
          startTime,
          endTime: new Date(),
          status: errorMessage ? "FAILURE" : "SUCCESS",
          resultsFound,
          resultsEmailed: newPosts.length, // Placeholder if we email immediately
          errorMessage,
        },
      });
    }

    return newPosts;
  }

  async getPendingPosts() {
    return await prisma.post.findMany({
      where: { isSent: false },
      orderBy: { relevanceScore: "desc" },
    });
  }

  async markAsSent(postIds: string[]) {
    await prisma.post.updateMany({
      where: { id: { in: postIds } },
      data: { isSent: true, sentAt: new Date() },
    });
  }
}
