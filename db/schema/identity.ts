import {
  pgSchema,
  text,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const core = pgSchema("core");

export const appuser = core.table(
  "appuser",
  {
    // Property is `id` (not `userId`) because Better-Auth's adapter hardcodes
    // lookups of a literal `id` field for every model (um03-spec §3.7); the
    // physical column stays `user_id` to satisfy the snake_case DB convention.
    id: text("user_id").primaryKey(),
    userName: text("user_name").notNull(),
    userEmail: text("user_email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    userPhonenum: text("user_phonenum"),
    authMethod: text("auth_method").notNull(),
    status: text("status").notNull().default("PENDING"),
    forcePasswordChange: boolean("force_password_change")
      .notNull()
      .default(false),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", {
      withTimezone: true,
      mode: "date",
    }),
    lastLoginDatetime: timestamp("last_login_datetime", {
      withTimezone: true,
      mode: "date",
    }),
    createdDatetime: timestamp("created_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    lastModifiedDatetime: timestamp("last_modified_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("appuser_email_unique")
      .on(t.userEmail)
      .where(sql`status <> 'DELETED'`),
    check("appuser_auth_method_check", sql`auth_method IN ('SSO','LOCAL')`),
    check(
      "appuser_status_check",
      sql`status IN ('PENDING','ACTIVE','DISABLED','DELETED')`,
    ),
  ],
);

export const account = core.table(
  "account",
  {
    id: text("account_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => appuser.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    scope: text("scope"),
    createdDatetime: timestamp("created_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    lastModifiedDatetime: timestamp("last_modified_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("account_provider_unique").on(
      t.providerId,
      t.providerAccountId,
    ),
    index("account_user_id_idx").on(t.userId),
    check(
      "account_provider_id_check",
      sql`provider_id IN ('credential','microsoft')`,
    ),
  ],
);

export const session = core.table(
  "session",
  {
    id: text("session_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => appuser.id, { onDelete: "cascade" }),
    sessionToken: text("session_token").notNull().unique(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdDatetime: timestamp("created_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    lastModifiedDatetime: timestamp("last_modified_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("session_user_id_idx").on(t.userId),
    index("session_expires_at_idx").on(t.expiresAt),
  ],
);

export const verification = core.table(
  "verification",
  {
    id: text("verification_id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdDatetime: timestamp("created_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    lastModifiedDatetime: timestamp("last_modified_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export type AppUser = typeof appuser.$inferSelect;
export type AppUserInsert = typeof appuser.$inferInsert;
export type Account = typeof account.$inferSelect;
export type AccountInsert = typeof account.$inferInsert;
export type Session = typeof session.$inferSelect;
export type SessionInsert = typeof session.$inferInsert;
export type Verification = typeof verification.$inferSelect;
export type VerificationInsert = typeof verification.$inferInsert;
