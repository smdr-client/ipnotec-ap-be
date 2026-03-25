import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text('name').notNull(),
    email: text('email').notNull(),
    phone: text('phone').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const sessions = sqliteTable('sessions', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id').notNull().references(() => users.id),
    macAddress: text('mac_address').notNull(),
    apMac: text('ap_mac'),
    ssid: text('ssid'),
    redirectUrl: text('redirect_url'),
    loginAt: integer('login_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    status: text('status', { enum: ['active', 'expired', 'revoked'] }).notNull().default('active'),
});

export const otpRequests = sqliteTable('otp_requests', {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    phone: text('phone').notNull(),
    otpHash: text('otp_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    verified: integer('verified').notNull().default(0),
});
