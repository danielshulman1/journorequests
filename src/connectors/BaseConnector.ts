import type { NormalizedPost } from "../types/index.js";

export abstract class PlatformConnector {
  abstract platform: string;
  abstract fetchPosts(terms: string[]): Promise<any[]>;
}
