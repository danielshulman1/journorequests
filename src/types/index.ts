export type Platform = "X" | "LinkedIn";

export type Priority = "High" | "Medium" | "Low";

export interface NormalizedPost {
  externalId: string;
  platform: Platform;
  authorName: string;
  authorUrl: string;
  text: string;
  postUrl: string;
  postedAt: Date;
  engagement?: {
    likes?: number;
    reposts?: number;
    replies?: number;
    views?: number;
  };
  matchedTerms: string[];
  matchedKeywords: string[];
  relevanceScore: number;
  priority: Priority;
  isUrgent: boolean;
  hasDeadline: boolean;
  isJournalist: boolean;
}

export interface SearchConfig {
  terms: string[];
  nicheKeywords: string[];
}
