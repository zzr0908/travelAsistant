import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { DB } from "../../storage/database.js";
import type { User } from "../../shared/model.js";
import { AppError, ensure } from "../domain/validation.js";

export const credentials = z
  .object({
    username: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .regex(/^[\p{L}\p{N}_-]+$/u, "用户名只能包含文字、数字、横线或下划线")
      .transform((s) => s.toLowerCase()),
    password: z.string().min(8, "密码至少 8 位").max(128),
    name: z.string().trim().min(1).max(60).optional(),
  })
  .strict();
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
function passwordMatches(password: string, stored: string) {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const a = Buffer.from(key, "hex"),
    b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class Auth {
  constructor(public db: DB) {}
  needsSetup() {
    return !this.db.prepare("SELECT id FROM users LIMIT 1").get();
  }
  create(input: unknown, admin = false): User {
    const c = credentials.parse(input);
    ensure(
      !this.db.prepare("SELECT id FROM users WHERE username=?").get(c.username),
      "该用户名已使用，请换一个或登录已有账号",
      409,
    );
    const user = {
      id: randomUUID(),
      username: c.username,
      name: c.name || c.username,
      admin,
    };
    this.db
      .prepare(
        "INSERT INTO users(id,username,name,password,admin) VALUES(?,?,?,?,?)",
      )
      .run(user.id, user.username, user.name, passwordHash(c.password), +admin);
    return user;
  }
  login(input: unknown): User {
    const c = credentials.parse(input);
    const row = this.db
      .prepare("SELECT * FROM users WHERE username=?")
      .get(c.username) as
      (Omit<User, "admin"> & { password: string; admin: number }) | undefined;
    if (!row || !passwordMatches(c.password, row.password))
      throw new AppError(401, "用户名或密码不正确");
    return {
      id: row.id,
      username: row.username,
      name: row.name,
      admin: !!row.admin,
    };
  }
  session(user: User) {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions(token_hash,user_id,expires) VALUES(?,?,?)")
      .run(hash(token), user.id, Date.now() + 30 * 86400000);
    return token;
  }
  user(token?: string): User | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        "SELECT u.id,u.username,u.name,u.admin FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires>?",
      )
      .get(hash(token), Date.now()) as
      (Omit<User, "admin"> & { admin: number }) | undefined;
    return row ? { ...row, admin: !!row.admin } : null;
  }
  require(token?: string) {
    const user = this.user(token);
    if (!user) throw new AppError(401, "请先登录");
    return user;
  }
  logout(token?: string) {
    if (token)
      this.db
        .prepare("DELETE FROM sessions WHERE token_hash=?")
        .run(hash(token));
  }
}
