import axios from "axios";
import { PlatformConnector } from "./BaseConnector.js";

export class LinkedInConnector extends PlatformConnector {
  platform = "LinkedIn";

  constructor() {
    super();
  }

  async fetchPosts(terms: string[]): Promise<any[]> {
    const apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) {
      console.warn("LinkedIn Scraper: RAPIDAPI_KEY not found. Skipping LinkedIn scan.");
      return [];
    }

    console.info(`LinkedIn Scraper: Searching for ${terms.length} terms...`);
    
    let allPosts: any[] = [];

    for (const term of terms) {
      try {
        const options = {
          method: 'GET',
          url: 'https://linkedin-api-all-endpoints.p.rapidapi.com/post-search',
          params: {
            keywords: term,
            start: '0'
          },
          headers: {
            'x-rapidapi-key': apiKey,
            'x-rapidapi-host': 'linkedin-api-all-endpoints.p.rapidapi.com'
          }
        };

        const response = await axios.request(options);
        // The new API typically returns results in an array under 'items' or directly
        const posts = response.data?.items || response.data || [];
        
        console.info(`LinkedIn Scraper: Found ${posts.length} results for "${term}"`);

        const normalized = posts.map((post: any) => ({
          id: post.post_id || post.urn,
          text: post.text || "",
          authorName: post.author_name || post.author_title || "LinkedIn User",
          authorUrl: post.author_profile_url || "",
          postUrl: post.post_url || `https://www.linkedin.com/feed/update/${post.urn}`,
          postedAt: post.posted_at ? new Date(post.posted_at).toISOString() : new Date().toISOString(),
          platform: "LinkedIn",
          engagement: { 
            likes: post.num_reactions || 0, 
            comments: post.num_comments || 0 
          },
        }));

        allPosts = [...allPosts, ...normalized];
      } catch (error: any) {
        console.error(`LinkedIn Scraper Error for term "${term}":`, error.response?.data || error.message);
      }
    }

    return allPosts;
  }
}
