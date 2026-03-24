import "dotenv/config";
import express from "express";
import path from "path";
import { prisma } from "./db/prisma.js";
import { SchedulerService } from "./services/SchedulerService.js";
import { searchTerms, nicheKeywords } from "./config/keywords.js";
import { MonitorService } from "./services/MonitorService.js";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const scheduler = new SchedulerService();
const monitor = new MonitorService();

const viewsPath = path.join(process.cwd(), "src", "views");
const publicPath = path.join(process.cwd(), "src", "public");

app.set("view engine", "ejs");
app.set("views", viewsPath);
app.use(express.static(publicPath));
app.use(express.urlencoded({ extended: true }));

// Seed Database with initial terms if empty
async function seed() {
  const termCount = await prisma.searchTerm.count();
  if (termCount === 0) {
    console.info("Seeding search terms...");
    await prisma.searchTerm.createMany({
      data: searchTerms.map(t => ({ term: t }))
    });
  }

  const kwCount = await prisma.nicheKeyword.count();
  if (kwCount === 0) {
    console.info("Seeding niche keywords...");
    await prisma.nicheKeyword.createMany({
      data: nicheKeywords.map(k => ({ keyword: k }))
    });
  }
}

// Routes
app.get("/", async (req, res) => {
  const posts = await prisma.post.findMany({
    orderBy: { discoveredAt: 'desc' },
    take: 50
  });

  const stats = {
    totalPosts: await prisma.post.count(),
    pendingPosts: await prisma.post.count({ where: { isSent: false } }),
    lastRun: await prisma.runLog.findFirst({ orderBy: { startTime: 'desc' } })
  };

  res.render("dashboard", { posts, stats, message: req.query.msg });
});

app.post("/trigger", async (req, res) => {
  try {
    console.info("Manual trigger received...");
    await monitor.run(true);
    res.redirect("/?msg=Manual+scan+completed+successfully");
  } catch (error) {
    console.error(error);
    res.redirect("/?msg=Manual+scan+failed");
  }
});

app.get("/config", async (req, res) => {
  const terms = await prisma.searchTerm.findMany();
  const keywords = await prisma.nicheKeyword.findMany();
  res.render("config", { terms, keywords, message: req.query.msg });
});

app.post("/config/add-term", async (req, res) => {
  const { term } = req.body;
  if (term) {
    await prisma.searchTerm.upsert({
      where: { term },
      update: { isActive: true },
      create: { term }
    });
  }
  res.redirect("/config?msg=Term+added");
});

app.post("/config/add-keyword", async (req, res) => {
  const { keyword } = req.body;
  if (keyword) {
    await prisma.nicheKeyword.upsert({
      where: { keyword },
      update: { isActive: true },
      create: { keyword }
    });
  }
  res.redirect("/config?msg=Keyword+added");
});

app.get("/history", async (req, res) => {
  const history = await prisma.runLog.findMany({
    orderBy: { startTime: 'desc' },
    take: 30
  });
  res.render("history", { history });
});

// Vercel Cron Endpoint
app.get("/api/cron", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send("Unauthorized");
  }
  try {
    console.info("Vercel Cron triggered scan...");
    await monitor.run();
    res.status(200).send("Scan complete");
  } catch (error) {
    res.status(500).send("Scan failed");
  }
});

// Start Server / Export for Vercel
async function main() {
  await seed();
  
  // Only start node-cron and app.listen if NOT on Vercel
  if (!process.env.VERCEL) {
    scheduler.start();
    app.listen(port, () => {
      console.info(`\n🚀 Journo Request Monitor is running at http://localhost:${port}`);
      console.info(`📊 Dashboard: http://localhost:${port}`);
      console.info(`🕒 Scheduled Scans: Every hour (${process.env.CRON_SCHEDULE || "0 * * * *"})`);
    });
  }
}

main().catch(console.error);

export default app;

