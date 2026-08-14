import { nanoid } from "nanoid";
import type { Database } from "better-sqlite3";

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  role: "user" | "admin";
  assistantId: string;
  instanceId: string;
  displayName: string | null;
  mustChangePassword: 0 | 1;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

interface RawUserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  assistant_id: string;
  instance_id: string;
  display_name: string | null;
  must_change_password: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

function mapRow(row: RawUserRow): UserRow {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role === "admin" ? "admin" : "user",
    assistantId: row.assistant_id,
    instanceId: row.instance_id,
    displayName: row.display_name,
    mustChangePassword: row.must_change_password === 1 ? 1 : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at
  };
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  role?: "user" | "admin";
  assistantId: string;
  instanceId: string;
  displayName?: string;
  mustChangePassword?: boolean;
}

export class UserRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateUserInput): UserRow {
    const now = new Date().toISOString();
    const id = `usr_${nanoid(16)}`;
    this.db
      .prepare(
        `INSERT INTO users (
          id, username, password_hash, role, assistant_id, instance_id,
          display_name, must_change_password, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.username,
        input.passwordHash,
        input.role ?? "user",
        input.assistantId,
        input.instanceId,
        input.displayName ?? null,
        input.mustChangePassword ? 1 : 0,
        now,
        now
      );
    return this.getById(id)!;
  }

  getById(id: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as RawUserRow | undefined;
    return row ? mapRow(row) : null;
  }

  getByUsername(username: string): UserRow | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username) as RawUserRow | undefined;
    return row ? mapRow(row) : null;
  }

  updatePassword(userId: string, passwordHash: string, mustChangePassword: boolean): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?`
      )
      .run(passwordHash, mustChangePassword ? 1 : 0, now, userId);
  }

  markLogin(userId: string): void {
    this.db
      .prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
      .run(new Date().toISOString(), userId);
  }

  list(): UserRow[] {
    const rows = this.db
      .prepare("SELECT * FROM users ORDER BY created_at ASC")
      .all() as RawUserRow[];
    return rows.map(mapRow);
  }
}

export interface PasswordResetAuditRow {
  id: string;
  operatorId: string;
  operatorRole: string;
  targetUserId: string;
  targetUsername: string;
  temporaryPasswordSet: boolean;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
}

export class AuditRepository {
  constructor(private readonly db: Database) {}

  recordPasswordReset(input: {
    operatorId: string;
    operatorRole: string;
    targetUserId: string;
    targetUsername: string;
    temporaryPasswordSet: boolean;
    ip?: string;
    userAgent?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO password_reset_audit (
          id, operator_id, operator_role, target_user_id, target_username,
          temporary_password_set, created_at, ip, user_agent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `pra_${nanoid(16)}`,
        input.operatorId,
        input.operatorRole,
        input.targetUserId,
        input.targetUsername,
        input.temporaryPasswordSet ? 1 : 0,
        new Date().toISOString(),
        input.ip ?? null,
        input.userAgent ?? null
      );
  }

  recordPasswordChange(input: {
    userId: string;
    username: string;
    ip?: string;
    userAgent?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO password_change_audit (id, user_id, username, created_at, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        `pca_${nanoid(16)}`,
        input.userId,
        input.username,
        new Date().toISOString(),
        input.ip ?? null,
        input.userAgent ?? null
      );
  }

  recordAuthEvent(input: {
    userId?: string;
    username?: string;
    event: string;
    ip?: string;
    userAgent?: string;
    details?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO auth_events (id, user_id, username, event, created_at, ip, user_agent, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `ae_${nanoid(16)}`,
        input.userId ?? null,
        input.username ?? null,
        input.event,
        new Date().toISOString(),
        input.ip ?? null,
        input.userAgent ?? null,
        input.details ?? null
      );
  }
}
