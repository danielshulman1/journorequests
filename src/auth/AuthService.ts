import crypto from "node:crypto";
import type { Request, Response } from "express";
import { prisma } from "../db/prisma.js";

const SESSION_COOKIE = "jr_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SCRYPT_KEYLEN = 64;

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
};

export class AuthService {
  async hashPassword(password: string) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derivedKey = await this.scrypt(password, salt);
    return `${salt}:${derivedKey}`;
  }

  async verifyPassword(password: string, storedHash: string) {
    const [salt, existingHash] = storedHash.split(":");
    if (!salt || !existingHash) {
      return false;
    }

    const derivedKey = await this.scrypt(password, salt);
    return crypto.timingSafeEqual(Buffer.from(existingHash, "hex"), Buffer.from(derivedKey, "hex"));
  }

  async createSession(userId: string) {
    const token = crypto.randomBytes(32).toString("hex");
    await prisma.session.create({
      data: {
        userId,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return token;
  }

  async getUserFromRequest(req: Request): Promise<AuthUser | null> {
    const cookies = this.parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) {
      return null;
    }

    const session = await prisma.session.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: true },
    });

    if (!session) {
      return null;
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }

    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    };
  }

  async destroySession(req: Request) {
    const cookies = this.parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) {
      return;
    }

    await prisma.session.deleteMany({
      where: { tokenHash: this.hashToken(token) },
    });
  }

  setSessionCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL_MS,
      path: "/",
    });
  }

  clearSessionCookie(res: Response) {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  }

  private hashToken(token: string) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private parseCookies(cookieHeader?: string) {
    const cookies: Record<string, string> = {};
    if (!cookieHeader) {
      return cookies;
    }

    for (const part of cookieHeader.split(";")) {
      const [key, ...valueParts] = part.trim().split("=");
      if (!key) continue;
      cookies[key] = decodeURIComponent(valueParts.join("="));
    }

    return cookies;
  }

  private scrypt(password: string, salt: string) {
    return new Promise<string>((resolve, reject) => {
      crypto.scrypt(password, salt, SCRYPT_KEYLEN, (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey.toString("hex"));
      });
    });
  }
}
