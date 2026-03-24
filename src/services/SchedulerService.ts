import cron from "node-cron";
import { MonitorService } from "./MonitorService.js";
import { EmailService } from "../email/EmailService.js";
import { prisma } from "../db/prisma.js";

export class SchedulerService {
  private monitor = new MonitorService();
  private emailer = new EmailService();

  start() {
    console.info("Scheduler started.");

    cron.schedule(process.env.SCHEDULER_TICK_CRON || "*/5 * * * *", async () => {
      console.info("Running scheduled user checks...");
      await this.runScheduledWork();
    });
  }

  async runScheduledWork(now = new Date()) {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        scanEnabled: true,
        scanIntervalMinutes: true,
        lastScanRunAt: true,
        emailEnabled: true,
        emailIntervalMinutes: true,
        lastEmailRunAt: true,
      },
    });

    for (const user of users) {
      try {
        if (user.scanEnabled && this.isDue(user.lastScanRunAt, user.scanIntervalMinutes, now)) {
          console.info(`Running scheduled scan for ${user.email}...`);
          await this.monitor.runForUser(user.id);
          await prisma.user.update({
            where: { id: user.id },
            data: { lastScanRunAt: now },
          });
        }

        if (user.emailEnabled && this.isDue(user.lastEmailRunAt, user.emailIntervalMinutes, now)) {
          console.info(`Running scheduled email digest for ${user.email}...`);
          const pendingPosts = await this.monitor.getPendingPosts(user.id);

          if (pendingPosts.length > 0) {
            await this.emailer.sendDigest(this.monitor.normalizeStoredPosts(pendingPosts), user.email);
            await this.monitor.markAsSent(
              pendingPosts.map((post) => post.id),
              user.id,
            );
          }

          await prisma.user.update({
            where: { id: user.id },
            data: { lastEmailRunAt: now },
          });
        }
      } catch (error) {
        console.error(`Scheduled work failed for ${user.email}:`, error);
      }
    }
  }

  async manualRun(userId: string) {
    return this.monitor.runForUser(userId, true);
  }

  async manualEmail(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const pendingPosts = await this.monitor.getPendingPosts(userId);
    if (pendingPosts.length === 0) {
      return { sentCount: 0 };
    }

    await this.emailer.sendDigest(this.monitor.normalizeStoredPosts(pendingPosts), user.email);
    await this.monitor.markAsSent(
      pendingPosts.map((post) => post.id),
      userId,
    );
    await prisma.user.update({
      where: { id: userId },
      data: { lastEmailRunAt: new Date() },
    });

    return { sentCount: pendingPosts.length };
  }

  private isDue(lastRunAt: Date | null, intervalMinutes: number, now: Date) {
    if (!lastRunAt) {
      return true;
    }

    return now.getTime() - lastRunAt.getTime() >= intervalMinutes * 60 * 1000;
  }
}
