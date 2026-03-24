import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "path";
import { prisma } from "./db/prisma.js";
import { SchedulerService } from "./services/SchedulerService.js";
import { MonitorService } from "./services/MonitorService.js";
import { fileURLToPath } from "url";
import { AuthService, type AuthUser } from "./auth/AuthService.js";
import { UserBootstrapService } from "./services/UserBootstrapService.js";
import {
  DEFAULT_EMAIL_INTERVAL_MINUTES,
  DEFAULT_SCAN_INTERVAL_MINUTES,
  emailIntervalOptions,
  parseScheduleInterval,
  scanIntervalOptions,
} from "./config/schedules.js";
import { buildRecentPostWhere, getMaxPostAgeHours } from "./utils/postFreshness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;
const scheduler = new SchedulerService();
const monitor = new MonitorService();
const authService = new AuthService();
const userBootstrapService = new UserBootstrapService();

const viewsPath = path.join(process.cwd(), "src", "views");
const publicPath = path.join(process.cwd(), "src", "public");

type AuthenticatedRequest = Request & {
  currentUser: AuthUser | null;
};

function isValidHttpUrl(value?: string | null) {
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeTextInput(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCheckbox(value: unknown) {
  return value === "on" || value === "true" || value === "1";
}

function getMessage(req: Request) {
  return typeof req.query.msg === "string" ? req.query.msg : undefined;
}

function toUserMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/\s+/g, " ").trim();
  }

  return fallback;
}

async function ensureUserDefaults(userId: string) {
  const [termCount, keywordCount] = await Promise.all([
    prisma.searchTerm.count({ where: { userId } }),
    prisma.nicheKeyword.count({ where: { userId } }),
  ]);

  if (termCount === 0 || keywordCount === 0) {
    await userBootstrapService.seedDefaults(userId);
  }
}

function getCurrentUser(req: Request) {
  return (req as AuthenticatedRequest).currentUser;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!getCurrentUser(req)) {
    res.redirect("/login");
    return;
  }

  next();
}

function requireGuest(req: Request, res: Response, next: NextFunction) {
  if (getCurrentUser(req)) {
    res.redirect("/");
    return;
  }

  next();
}

async function clearPending(req: Request, res: Response) {
  const currentUser = getCurrentUser(req);
  if (!currentUser) {
    res.redirect("/login");
    return;
  }

  await monitor.clearPendingPosts(currentUser.id);
  res.redirect("/?msg=Pending+posts+cleared");
}

app.set("view engine", "ejs");
app.set("views", viewsPath);
app.use(express.static(publicPath));
app.use(express.urlencoded({ extended: true }));

app.use(async (req, res, next) => {
  try {
    const currentUser = await authService.getUserFromRequest(req);
    (req as AuthenticatedRequest).currentUser = currentUser;
    res.locals.currentUser = currentUser;
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/login", requireGuest, (req, res) => {
  res.render("login", {
    error: undefined,
    email: "",
    message: getMessage(req),
  });
});

app.post("/login", requireGuest, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = normalizeTextInput(req.body.password);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await authService.verifyPassword(password, user.passwordHash))) {
    res.status(401).render("login", {
      error: "Invalid email or password.",
      email,
      message: undefined,
    });
    return;
  }

  await ensureUserDefaults(user.id);
  const token = await authService.createSession(user.id);
  authService.setSessionCookie(res, token);
  res.redirect("/");
});

app.get("/register", requireGuest, (req, res) => {
  res.render("register", {
    error: undefined,
    values: { name: "", email: "" },
    message: getMessage(req),
  });
});

app.post("/register", requireGuest, async (req, res) => {
  const name = normalizeTextInput(req.body.name);
  const email = normalizeEmail(req.body.email);
  const password = normalizeTextInput(req.body.password);
  const confirmPassword = normalizeTextInput(req.body.confirmPassword);

  if (!email || !password) {
    res.status(400).render("register", {
      error: "Email and password are required.",
      values: { name, email },
      message: undefined,
    });
    return;
  }

  if (password.length < 8) {
    res.status(400).render("register", {
      error: "Password must be at least 8 characters.",
      values: { name, email },
      message: undefined,
    });
    return;
  }

  if (password !== confirmPassword) {
    res.status(400).render("register", {
      error: "Passwords do not match.",
      values: { name, email },
      message: undefined,
    });
    return;
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    res.status(409).render("register", {
      error: "An account already exists for that email.",
      values: { name, email },
      message: undefined,
    });
    return;
  }

  const passwordHash = await authService.hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email,
      name: name || null,
      passwordHash,
    },
  });

  await userBootstrapService.seedDefaults(user.id);
  const token = await authService.createSession(user.id);
  authService.setSessionCookie(res, token);
  res.redirect("/");
});

app.post("/logout", requireAuth, async (req, res) => {
  await authService.destroySession(req);
  authService.clearSessionCookie(res);
  res.redirect("/login?msg=Logged+out");
});

app.get("/", requireAuth, async (req, res) => {
  const currentUser = getCurrentUser(req);
  if (!currentUser) {
    res.redirect("/login");
    return;
  }

  const requestedView = req.query.view === "all" ? "all" : "pending";
  const recentPostWhere = buildRecentPostWhere();
  const [totalPosts, pendingPosts, lastRun] = await Promise.all([
    prisma.post.count({ where: { userId: currentUser.id } }),
    prisma.post.count({
      where: {
        userId: currentUser.id,
        isSent: false,
        ...recentPostWhere,
      },
    }),
    prisma.runLog.findFirst({
      where: { userId: currentUser.id },
      orderBy: { startTime: "desc" },
    }),
  ]);

  const autoShowingAll = requestedView === "pending" && pendingPosts === 0 && totalPosts > 0;
  const view = autoShowingAll ? "all" : requestedView;
  const postWhere = view === "all"
    ? { userId: currentUser.id }
    : {
        userId: currentUser.id,
        isSent: false,
        ...recentPostWhere,
      };

  const rawPosts = await prisma.post.findMany({
    where: postWhere,
    orderBy: [
      { postedAt: "desc" },
      { discoveredAt: "desc" },
    ],
    take: 50,
  });

  const posts = rawPosts.map((post) => ({
    ...post,
    authorUrl: isValidHttpUrl(post.authorUrl) ? post.authorUrl : null,
    postUrl: isValidHttpUrl(post.postUrl) ? post.postUrl : null,
    displayDate: post.postedAt || post.discoveredAt,
  }));

  res.render("dashboard", {
    posts,
    stats: {
      totalPosts,
      pendingPosts,
      lastRun,
    },
    view,
    autoShowingAll,
    freshnessWindowHours: getMaxPostAgeHours(),
    message: getMessage(req),
    currentUser,
  });
});

app.post("/trigger", requireAuth, async (req, res) => {
  const currentUser = getCurrentUser(req);
  if (!currentUser) {
    res.redirect("/login");
    return;
  }

  try {
    console.info(`Manual trigger received for ${currentUser.email}...`);
    await scheduler.manualRun(currentUser.id);
    res.redirect("/?msg=Manual+scan+completed+successfully");
  } catch (error) {
    console.error(error);
    res.redirect("/?msg=Manual+scan+failed");
  }
});

app.post("/send-digest", requireAuth, async (req, res) => {
  const currentUser = getCurrentUser(req);
  if (!currentUser) {
    res.redirect("/login");
    return;
  }

  try {
    console.info(`Manual email trigger received for ${currentUser.email}...`);
    const result = await scheduler.manualEmail(currentUser.id);

    if (result.sentCount === 0) {
      res.redirect("/?msg=No+pending+posts+to+email");
      return;
    }

    res.redirect(`/?msg=Manual+email+sent+for+${result.sentCount}+post${result.sentCount === 1 ? "" : "s"}`);
  } catch (error) {
    console.error(error);
    res.redirect(`/?msg=${encodeURIComponent(toUserMessage(error, "Manual email failed"))}`);
  }
});

app.get("/clear-pending", requireAuth, clearPending);
app.post("/clear-pending", requireAuth, clearPending);

app.get("/config", requireAuth, async (req, res) => {
  const currentUser = getCurrentUser(req);
  if (!currentUser) {
    res.redirect("/login");
    return;
  }

  const [terms, keywords] = await Promise.all([
    prisma.searchTerm.findMany({
      where: { userId: currentUser.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.nicheKeyword.findMany({
      where: { userId: currentUser.id },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const settings = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: {
      email: true,
      scanEnabled: true,
      scanIntervalMinutes: true,
      emailEnabled: true,
      emailIntervalMinutes: true,
      lastScanRunAt: true,
      lastEmailRunAt: true,
    },
  });

  res.render("config", {
    terms,
    keywords,
    settings,
    scanIntervalOptions,
    emailIntervalOptions,
    message: getMessage(req),
    currentUser,
  });
});

app.post("/config/schedule", requireAuth, async (req, res) => {
  const currentUser = getCurrentUser(req);
  if (!currentUser) {
    res.redirect("/login");
    return;
  }

  const scanEnabled = normalizeCheckbox(req.body.scanEnabled);
  const emailEnabled = normalizeCheckbox(req.body.emailEnabled);
  const scanIntervalMinutes = parseScheduleInterval(
    req.body.scanIntervalMinutes,
    scanIntervalOptions.map((option) => option.value),
    DEFAULT_SCAN_INTERVAL_MINUTES,
  );
  const emailIntervalMinutes = parseScheduleInterval(
    req.body.emailIntervalMinutes,
    emailIntervalOptions.map((option) => option.value),
    DEFAULT_EMAIL_INTERVAL_MINUTES,
  );

  await prisma.user.update({
    where: { id: currentUser.id },
    data: {
      scanEnabled,
      emailEnabled,
      scanIntervalMinutes,
      emailIntervalMinutes,
    },
  });

  res.redirect("/config?msg=Schedule+updated");
});

app.post("/config/add-term", requireAuth, async (req, res) => {
  const currentUser = getCurrentUser(req);
  const term = normalizeTextInput(req.body.term);

  if (currentUser && term) {
    await prisma.searchTerm.upsert({
      where: {
        userId_term: {
          userId: currentUser.id,
          term,
        },
      },
      update: { isActive: true },
      create: {
        userId: currentUser.id,
        term,
      },
    });
  }

  res.redirect("/config?msg=Term+added");
});

app.post("/config/delete-term", requireAuth, async (req, res) => {
  const currentUser = getCurrentUser(req);
  const id = normalizeTextInput(req.body.id);

  if (currentUser && id) {
    await prisma.searchTerm.deleteMany({
      where: {
        id,
        userId: currentUser.id,
      },
    });
  }

  res.redirect("/config?msg=Term+deleted");
});

app.post("/config/add-keyword", requireAuth, async (req, res) => {
  const currentUser = getCurrentUser(req);
  const keyword = normalizeTextInput(req.body.keyword);

  if (currentUser && keyword) {
    await prisma.nicheKeyword.upsert({
      where: {
        userId_keyword: {
          userId: currentUser.id,
          keyword,
        },
      },
      update: { isActive: true },
      create: {
        userId: currentUser.id,
        keyword,
      },
    });
  }

  res.redirect("/config?msg=Keyword+added");
});

app.post("/config/delete-keyword", requireAuth, async (req, res) => {
  const currentUser = getCurrentUser(req);
  const id = normalizeTextInput(req.body.id);

  if (currentUser && id) {
    await prisma.nicheKeyword.deleteMany({
      where: {
        id,
        userId: currentUser.id,
      },
    });
  }

  res.redirect("/config?msg=Keyword+deleted");
});

app.get("/history", requireAuth, async (req, res) => {
  const currentUser = getCurrentUser(req);
  if (!currentUser) {
    res.redirect("/login");
    return;
  }

  const history = await prisma.runLog.findMany({
    where: { userId: currentUser.id },
    orderBy: { startTime: "desc" },
    take: 30,
  });

  res.render("history", {
    history,
    currentUser,
  });
});

app.get("/api/cron", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).send("Unauthorized");
    return;
  }

  try {
    console.info("Cron tick triggered scheduled user checks...");
    await scheduler.runScheduledWork();
    res.status(200).send("Scheduled checks complete");
  } catch (error) {
    console.error(error);
    res.status(500).send("Task failed");
  }
});

async function main() {
  if (!process.env.VERCEL) {
    scheduler.start();
    app.listen(port, () => {
      console.info(`Journo Request Monitor is running at http://localhost:${port}`);
      console.info(`Dashboard: http://localhost:${port}`);
      console.info(`Scheduler Tick: ${process.env.SCHEDULER_TICK_CRON || "*/5 * * * *"}`);
    });
  }
}

main().catch(console.error);

export default app;
