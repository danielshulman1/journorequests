import type { NormalizedPost, Priority } from "../types/index.js";
import { nicheKeywords, urgencyPhrases, journalistKeywords } from "../config/keywords.js";

export class RelevanceScorer {
  static score(post: any, terms: string[], keywords: string[]): NormalizedPost {
    const textLower = post.text.toLowerCase();
    const authorLower = post.authorName.toLowerCase() + " " + (post.authorBio?.toLowerCase() || "");

    let score = 0;
    const matchedKeywords: string[] = [];
    const matchedTerms: string[] = [];

    // 1. Matched Search Terms
    terms.forEach(term => {
      if (this.containsToken(textLower, term)) {
        matchedTerms.push(term);
        score += 10;
      }
    });

    // 2. Niche Relevance (High weight)
    keywords.forEach(keyword => {
      if (this.containsToken(textLower, keyword)) {
        matchedKeywords.push(keyword);
        score += 20;
      }
    });

    // 3. Urgency
    let isUrgent = false;
    let hasDeadline = false;
    urgencyPhrases.forEach(phrase => {
      if (textLower.includes(phrase.toLowerCase())) {
        isUrgent = true;
        score += 15;
      }
    });
    if (textLower.includes("deadline")) {
      hasDeadline = true;
      score += 10;
    }

    // 4. Recency (Last 24 hours handled by caller generally, but we can boost)
    const hotness = (Date.now() - new Date(post.postedAt).getTime()) / (1000 * 60 * 60); // hours
    if (hotness < 6) score += 15;
    else if (hotness < 24) score += 10;

    // 5. Journalist Check
    let isJournalist = false;
    journalistKeywords.forEach(jk => {
      if (this.containsToken(authorLower, jk)) {
        isJournalist = true;
        score += 20;
      }
    });

    // 6. Contact Details boost
    if (textLower.includes("email") || textLower.includes("@") || textLower.includes("dm me")) {
      score += 10;
    }

    // Max score cap at 100
    const finalScore = Math.min(score, 100);

    // Determine priority
    let priority: Priority = "Low";
    if (finalScore >= 75 || isUrgent) priority = "High";
    else if (finalScore >= 45) priority = "Medium";

    return {
      externalId: post.id || post.externalId,
      platform: post.platform,
      authorName: post.authorName,
      authorUrl: post.authorUrl,
      text: post.text,
      postUrl: post.postUrl,
      postedAt: new Date(post.postedAt),
      engagement: post.engagement,
      matchedTerms,
      matchedKeywords,
      relevanceScore: finalScore,
      priority,
      isUrgent,
      hasDeadline,
      isJournalist,
    };
  }

  private static containsToken(haystack: string, needle: string) {
    const normalizedNeedle = needle.toLowerCase().trim();
    if (!normalizedNeedle) {
      return false;
    }

    if (/^[a-z0-9]+(?:\s+[a-z0-9]+)*$/i.test(normalizedNeedle)) {
      const pattern = new RegExp(`\\b${this.escapeRegExp(normalizedNeedle).replace(/\s+/g, "\\s+")}\\b`, "i");
      return pattern.test(haystack);
    }

    return haystack.includes(normalizedNeedle);
  }

  private static escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
