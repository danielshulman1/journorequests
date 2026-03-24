import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import fs from "fs";
import path from "path";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Correctly handle the URL and options object for Prisma 7 better-sqlite3 adapter
let dbPath = (process.env.DATABASE_URL || "dev.db").replace("file:", "");

// Special handling for Vercel's read-only filesystem
if (process.env.VERCEL) {
  const tmpPath = "/tmp/dev.db";
  if (!fs.existsSync(tmpPath)) {
    try {
      // Must use a fully resolved path to the included file
      fs.copyFileSync(path.join(process.cwd(), "init.db"), tmpPath);
    } catch (e) {
      console.error("Failed to copy init.db to /tmp:", e);
    }
  }
  dbPath = tmpPath;
}

const adapter = new PrismaBetterSqlite3({ url: dbPath });

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
