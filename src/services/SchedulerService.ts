import cron from "node-cron";
import { MonitorService } from "./MonitorService.js";
import { EmailService } from "../email/EmailService.js";
import { prisma } from "../db/prisma.js";

export class SchedulerService {
  private monitor = new MonitorService();
  private emailer = new EmailService();

  start() {
    console.info("Scheduler started.");

    // Hourly Task
    cron.schedule(process.env.CRON_SCHEDULE || "0 * * * *", async () => {
      console.info("Running hourly monitor scan...");
      const newPosts = await this.monitor.run();

      // Check for High Priority - Instant Alert mode
      const highPriority = newPosts.filter(p => p.priority === "High");
      if (highPriority.length > 0) {
        console.info(`Found ${highPriority.length} high priority posts! Sending instant alert...`);
        await this.emailer.sendDigest(highPriority);
        // Mark these as sent
        // await this.monitor.markAsSent(highPriority.map(p => p.externalId)); // Wait, DB ID is needed
      }
    });

    // Daily Digest Task
    cron.schedule(process.env.DIGEST_SCHEDULE || "0 9 * * *", async () => {
      console.info("Running daily digest scan...");
      const pending = await prisma.post.findMany({
        where: { isSent: false },
        orderBy: { relevanceScore: "desc" }
      });

      if (pending.length > 0) {
        const normalized = pending.map((p) => ({
          ...p,
          postedAt: p.postedAt ? new Date(p.postedAt) : new Date(),
          matchedTerms: (p.matchedTerms || "").split(", "),
          matchedKeywords: (p.matchedKeywords || "").split(", "),
          priority: p.priority as any
        }));

        await this.emailer.sendDigest(normalized as any);
        await prisma.post.updateMany({
          where: { id: { in: pending.map(p => p.id) } },
          data: { isSent: true, sentAt: new Date() }
        });
      }
    });
  }

  async manualRun() {
    return await this.monitor.run(true);
  }
}
