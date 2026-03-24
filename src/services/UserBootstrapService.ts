import { prisma } from "../db/prisma.js";
import { nicheKeywords, searchTerms } from "../config/keywords.js";

export class UserBootstrapService {
  async seedDefaults(userId: string) {
    for (const term of searchTerms) {
      await prisma.searchTerm.upsert({
        where: {
          userId_term: {
            userId,
            term,
          },
        },
        update: { isActive: true },
        create: {
          userId,
          term,
        },
      });
    }

    for (const keyword of nicheKeywords) {
      await prisma.nicheKeyword.upsert({
        where: {
          userId_keyword: {
            userId,
            keyword,
          },
        },
        update: { isActive: true },
        create: {
          userId,
          keyword,
        },
      });
    }
  }
}
