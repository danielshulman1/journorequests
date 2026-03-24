import axios from "axios";
import nodemailer from "nodemailer";
import ejs from "ejs";
import path from "path";
import type { NormalizedPost } from "../types/index.js";

type DigestPayload = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
};

export class EmailService {
  private readonly resendApiKey;
  private readonly host;
  private readonly port;
  private readonly user;
  private readonly pass;
  private readonly secure;
  private readonly tlsServerName;

  constructor() {
    this.resendApiKey = (process.env.RESEND_API_KEY || "").trim();
    this.host = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
    this.port = Number(process.env.SMTP_PORT) || 587;
    this.user = (process.env.SMTP_USER || "").trim();
    this.pass = (process.env.SMTP_PASS || "").trim();
    this.secure = this.port === 465;
    this.tlsServerName = (process.env.SMTP_TLS_SERVERNAME || this.host).trim();
  }

  async sendDigest(posts: NormalizedPost[], recipientEmail: string) {
    if (posts.length === 0) {
      console.info("No posts to email.");
      return;
    }

    const sortedPosts = [...posts].sort((left, right) => {
      if (left.priority !== right.priority) {
        const order = { High: 0, Medium: 1, Low: 2 };
        return order[left.priority] - order[right.priority];
      }

      return right.relevanceScore - left.relevanceScore;
    });

    const templatePath = path.join(process.cwd(), "src", "email", "templates", "digest.ejs");
    const dashboardUrl = process.env.APP_URL || "http://localhost:3000";
    const html = await ejs.renderFile(templatePath, {
      posts: sortedPosts,
      totalCount: sortedPosts.length,
      date: new Date().toLocaleDateString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      dashboardUrl,
    });

    const payload: DigestPayload = {
      from: this.getFromAddress(),
      to: recipientEmail,
      subject: `Journo Request Digest - ${sortedPosts.length} new request${sortedPosts.length === 1 ? "" : "s"}`,
      html,
      text: this.buildPlainTextDigest(sortedPosts, dashboardUrl),
    };

    if (this.resendApiKey) {
      return this.sendViaResend(payload);
    }

    return this.sendViaSmtp(payload);
  }

  private buildPlainTextDigest(posts: NormalizedPost[], dashboardUrl: string) {
    const lines = posts.map((post, index) => {
      const summary = post.text.replace(/\s+/g, " ").trim();
      return [
        `${index + 1}. [${post.priority}] ${post.platform}`,
        `Author: ${post.authorName}`,
        `Posted: ${post.postedAt.toLocaleString()}`,
        `Request: ${summary}`,
        `Link: ${post.postUrl}`,
      ].join("\n");
    });

    return [
      "Journo Request Digest",
      `${posts.length} new request${posts.length === 1 ? "" : "s"} found.`,
      "",
      ...lines,
      "",
      `Manage your keywords: ${dashboardUrl}`,
    ].join("\n");
  }

  private getFromAddress() {
    if ((process.env.RESEND_TEST_MODE || "").trim() === "true") {
      return "Journo Request Monitor <onboarding@resend.dev>";
    }

    return (process.env.EMAIL_FROM || "Journo Request Monitor <onboarding@resend.dev>").trim();
  }

  private async sendViaResend(payload: DigestPayload) {
    try {
      const response = await axios.post(
        "https://api.resend.com/emails",
        payload,
        {
          headers: {
            Authorization: `Bearer ${this.resendApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        },
      );

      console.info("Email sent via Resend:", response.data?.id);
      return response.data;
    } catch (error) {
      const message = this.extractResendError(error);
      console.error("Resend send failure:", message);
      throw new Error(message);
    }
  }

  private async sendViaSmtp(payload: DigestPayload) {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const transporter = this.createTransporter();

      try {
        const info = await transporter.sendMail(payload);
        console.info("Email sent via SMTP:", info.messageId);
        return info;
      } catch (error) {
        lastError = error;
        console.error(`SMTP send attempt ${attempt} failed:`, error);

        if (!this.isTransientMailError(error) || attempt === maxAttempts) {
          throw error;
        }

        await this.delay(attempt * 750);
      }
    }

    throw lastError;
  }

  private createTransporter() {
    return nodemailer.createTransport({
      host: this.host,
      port: this.port,
      secure: this.secure,
      auth: {
        user: this.user,
        pass: this.pass,
      },
      tls: {
        servername: this.tlsServerName,
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }

  private extractResendError(error: unknown) {
    if (axios.isAxiosError(error)) {
      const apiMessage =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message;

      if (typeof apiMessage === "string" && apiMessage.trim()) {
        return apiMessage.trim();
      }
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Resend email failed";
  }

  private isTransientMailError(error: unknown) {
    if (!(error instanceof Error)) {
      return false;
    }

    const code = "code" in error ? String((error as { code?: unknown }).code || "") : "";
    const message = error.message || "";

    return [
      "EBUSY",
      "EAI_AGAIN",
      "ECONNRESET",
      "ETIMEDOUT",
      "ESOCKET",
    ].includes(code) || message.includes("getaddrinfo");
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
