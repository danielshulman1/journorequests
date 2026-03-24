import { PlatformConnector } from "./BaseConnector.js";
import axios from "axios";

export class XConnector extends PlatformConnector {
  platform = "X";
  private apiKey: string | undefined;

  constructor() {
    super();
    this.apiKey = process.env.X_BEARER_TOKEN;
  }

  async fetchPosts(terms: string[]): Promise<any[]> {
    if (!this.apiKey) {
      console.warn("X_BEARER_TOKEN NOT SET. Returning mock data for demonstration.");
      return this.getMockData(terms);
    }

    try {
      // Safely chunk terms to avoid exceeding Twitter's 512-character query limit for basic tier
      let safeQuery = "";
      for (const term of terms) {
        const nextPart = safeQuery ? ` OR "${term}"` : `"${term}"`;
        if (safeQuery.length + nextPart.length > 512) break;
        safeQuery += nextPart;
      }

      const response = await axios.get(`https://api.twitter.com/2/tweets/search/recent`, {
        params: {
          query: safeQuery,
          "tweet.fields": "created_at,author_id,public_metrics,entities",
          expansions: "author_id",
          "user.fields": "name,username,url",
          max_results: 10,
        },
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      const tweets = response.data.data;
      if (!tweets || tweets.length === 0) return [];

      const users = response.data.includes.users || [];
      const userMap = new Map();
      users.forEach((user: any) => {
        userMap.set(user.id, user);
      });

      return tweets.map((tweet: any) => {
        const author = userMap.get(tweet.author_id);
        const authorName = author ? author.name : "Unknown User";
        const authorUsername = author ? author.username : "unknown";
        const authorUrl = `https://x.com/${authorUsername}`;
        const postUrl = `https://x.com/${authorUsername}/status/${tweet.id}`;

        return {
          id: `x_${tweet.id}`,
          text: tweet.text,
          authorName: `${authorName} (@${authorUsername})`,
          authorUrl: authorUrl,
          postUrl: postUrl,
          postedAt: tweet.created_at || new Date().toISOString(),
          platform: "X",
          engagement: {
            likes: tweet.public_metrics?.like_count || 0,
            reposts: tweet.public_metrics?.retweet_count || 0,
            replies: tweet.public_metrics?.reply_count || 0,
            views: tweet.public_metrics?.impression_count || 0,
          },
        };
      });

    } catch (error: any) {
      console.error("X Fetch Error:", error.response?.data || error.message);
      return [];
    }
  }

  private getMockData(terms: string[]): any[] {
    // Generate some mock data for development
    return [
      {
        id: "x123",
        text: "Looking for expert comment on #AI and its impact on small business growth for an upcoming feature! #journorequest deadline today 5pm",
        authorName: "Sarah Journalist",
        authorUrl: "https://x.com/sarah_j",
        postUrl: "https://x.com/sarah_j/status/123",
        postedAt: new Date().toISOString(),
        platform: "X",
        engagement: { likes: 5, reposts: 2 },
      },
      {
        id: "x124",
        text: "Can any small business owners speak to their experience with automation tools? Seeking comment for a national daily. #journorequest",
        authorName: "Tech Reporter",
        authorUrl: "https://x.com/tech_rep",
        postUrl: "https://x.com/tech_rep/status/124",
        postedAt: new Date(Date.now() - 3600000).toISOString(),
        platform: "X",
        engagement: { likes: 10, reposts: 4 },
      },
    ];
  }
}
