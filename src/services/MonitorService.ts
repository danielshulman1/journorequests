import type { Post } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { XConnector } from "../connectors/XConnector.js";
import { LinkedInConnector } from "../connectors/LinkedInConnector.js";
import { RelevanceScorer } from "./RelevanceScorer.js";
import type { NormalizedPost, Priority } from "../types/index.js";
import { buildRecentPostWhere, isRecentDate } from "../utils/postFreshness.js";

export class MonitorService {
  private connectors = [new XConnector(), new LinkedInConnector()];

  async runForUser(userId: string, manual = false) {
    const startTime = new Date();
    let resultsFound = 0;
    let errorMessage: string | null = null;
    const newPosts: NormalizedPost[] = [];

    try {
      const [termsFromDb, keywordsFromDb] = await Promise.all([
        prisma.searchTerm.findMany({ where: { userId, isActive: true } }),
        prisma.nicheKeyword.findMany({ where: { userId, isActive: true } }),
      ]);

      const terms = termsFromDb.map((term) => term.term);
      const keywords = keywordsFromDb.map((keyword) => keyword.keyword);

      if (terms.length === 0) {
        console.info(`Skipping scan for user ${userId}: no active search terms configured.`);
      } else {
        for (const connector of this.connectors) {
          console.info(`Monitoring ${connector.platform} for user ${userId}${manual ? " (manual)" : ""}...`);
          const rawPosts = await connector.fetchPosts(terms);

          for (const raw of rawPosts) {
            const externalId = raw.id || raw.externalId;
            if (!externalId) {
              continue;
            }

            const existing = await prisma.post.findUnique({
              where: {
                userId_externalId: {
                  userId,
                  externalId,
                },
              },
            });

            if (existing) {
              continue;
            }

            const scored = RelevanceScorer.score(raw, terms, keywords);

            if (!isRecentDate(scored.postedAt, startTime)) {
              continue;
            }

            if (scored.matchedKeywords.length === 0 && scored.matchedTerms.length === 0) {
              continue;
            }

            if (scored.relevanceScore < Number(process.env.RELEVANCE_THRESHOLD || 20)) {
              continue;
            }

            await prisma.post.create({
              data: {
                userId,
                platform: scored.platform,
                externalId: scored.externalId,
                authorName: scored.authorName,
                authorUrl: scored.authorUrl,
                text: scored.text,
                postUrl: scored.postUrl,
                postedAt: scored.postedAt,
                engagement: JSON.stringify(scored.engagement ?? {}),
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
            resultsFound += 1;
          }
        }
      }

      console.info(`Monitor run complete for user ${userId}. ${resultsFound} new posts found.`);
    } catch (error) {
      console.error("Monitor Run Error:", error);
      errorMessage = error instanceof Error ? error.message : "Unknown monitor error";
    } finally {
      await prisma.runLog.create({
        data: {
          userId,
          startTime,
          endTime: new Date(),
          status: errorMessage ? "FAILURE" : "SUCCESS",
          resultsFound,
          resultsEmailed: 0,
          errorMessage,
        },
      });
    }

    return newPosts;
  }

  async getPendingPosts(userId: string) {
    return prisma.post.findMany({
      where: {
        userId,
        isSent: false,
        ...buildRecentPostWhere(),
      },
      orderBy: [
        { postedAt: "desc" },
        { discoveredAt: "desc" },
        { relevanceScore: "desc" },
      ],
    });
  }

  async clearPendingPosts(userId: string) {
    return prisma.post.updateMany({
      where: { userId, isSent: false },
      data: { isSent: true, sentAt: new Date() },
    });
  }

  async markAsSent(postIds: string[], userId: string) {
    if (postIds.length === 0) {
      return;
    }

    await prisma.post.updateMany({
      where: {
        userId,
        id: { in: postIds },
      },
      data: { isSent: true, sentAt: new Date() },
    });
  }

  async markExternalIdsAsSent(userId: string, externalIds: string[]) {
    if (externalIds.length === 0) {
      return;
    }

    await prisma.post.updateMany({
      where: {
        userId,
        externalId: { in: externalIds },
      },
      data: { isSent: true, sentAt: new Date() },
    });
  }

  normalizeStoredPosts(posts: Post[]): NormalizedPost[] {
    return posts.map((post) => ({
      externalId: post.externalId,
      platform: post.platform as "X" | "LinkedIn",
      authorName: post.authorName || "Unknown author",
      authorUrl: post.authorUrl || "",
      text: post.text,
      postUrl: post.postUrl,
      postedAt: post.postedAt || post.discoveredAt,
      engagement: this.parseEngagement(post.engagement),
      matchedTerms: this.parseCsv(post.matchedTerms),
      matchedKeywords: this.parseCsv(post.matchedKeywords),
      relevanceScore: post.relevanceScore,
      priority: post.priority as Priority,
      isUrgent: post.isUrgent,
      hasDeadline: post.hasDeadline,
      isJournalist: post.isJournalist,
    }));
  }

  private parseCsv(value: string | null) {
    return (value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private parseEngagement(value: string | null): NonNullable<NormalizedPost["engagement"]> {
    if (!value) {
      return {};
    }

    try {
      return JSON.parse(value) as NonNullable<NormalizedPost["engagement"]>;
    } catch {
      return {};
    }
  }
}
