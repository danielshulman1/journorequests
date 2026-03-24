import nodemailer from "nodemailer";
import ejs from "ejs";
import path from "path";
import type { NormalizedPost, Priority } from "../types/index.js";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class EmailService {
  private transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  async sendDigest(posts: NormalizedPost[]) {
    if (posts.length === 0) {
      console.info("No posts to email.");
      return;
    }

    // Group posts by priority
    const grouped: Record<Priority, NormalizedPost[]> = {
      High: posts.filter((p) => p.priority === "High"),
      Medium: posts.filter((p) => p.priority === "Medium"),
      Low: posts.filter((p) => p.priority === "Low"),
    };

    const templatePath = path.join(process.cwd(), "src", "email", "templates", "digest.ejs");
    const html = await ejs.renderFile(templatePath, {
      posts: grouped,
      totalCount: posts.length,
      date: new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    });

    const mailOptions = {
      from: process.env.EMAIL_FROM,
      to: process.env.EMAIL_TO,
      subject: `Journo Request Digest – ${new Date().toLocaleDateString()}`,
      html: html,
      text: `Journo Request Digest - ${posts.length} new requests found. View them at http://localhost:3000`,
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.info("Email sent:", info.messageId);
      return info;
    } catch (error) {
      console.error("Email send failure:", error);
      throw error;
    }
  }
}
