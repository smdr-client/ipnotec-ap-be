/**
 * Admin routes — dashboard API for session management.
 *
 * POST   /login          — Authenticate admin, return JWT
 * GET    /sessions/today  — Today's sessions with user details
 * GET    /sessions/stats  — Daily (7d) and weekly (4w) aggregations
 * DELETE /sessions/:id    — Revoke a session
 */

import { Hono } from 'hono';
import { eq, sql, gte, and, lt, desc } from 'drizzle-orm';
import { db } from '../db/index';
import { users, sessions } from '../db/schema';
import { signAdminToken, adminMiddleware } from '../middleware/auth';

const admin = new Hono();

// ────────────────────────────────────────────
// POST /login — Admin authentication
// ────────────────────────────────────────────
admin.post('/login', async (c) => {
    const body = await c.req.json();
    const { username, password } = body;

    if (!username || !password) {
        return c.json({ success: false, message: 'Username and password are required' }, 400);
    }

    const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
    const expectedPassword = process.env.ADMIN_PASSWORD || '';

    if (username !== expectedUsername || password !== expectedPassword) {
        return c.json({ success: false, message: 'Invalid credentials' }, 401);
    }

    const token = await signAdminToken();

    return c.json({ success: true, token });
});

// ── All routes below require admin JWT ──────
admin.use('/sessions/*', adminMiddleware);

// ────────────────────────────────────────────
// GET /sessions/today — Today's sessions
// ────────────────────────────────────────────
admin.get('/sessions/today', async (c) => {
    // Midnight today (server timezone)
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const rows = await db
        .select({
            id: sessions.id,
            name: users.name,
            email: users.email,
            phone: users.phone,
            macAddress: sessions.macAddress,
            apMac: sessions.apMac,
            ssid: sessions.ssid,
            loginAt: sessions.loginAt,
            expiresAt: sessions.expiresAt,
            status: sessions.status,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(gte(sessions.loginAt, todayMidnight))
        .orderBy(desc(sessions.loginAt));

    const dateStr = `${todayMidnight.getFullYear()}-${String(todayMidnight.getMonth() + 1).padStart(2, '0')}-${String(todayMidnight.getDate()).padStart(2, '0')}`;

    return c.json({
        date: dateStr,
        count: rows.length,
        sessions: rows.map((r) => ({
            ...r,
            loginAt: r.loginAt instanceof Date ? r.loginAt.toISOString() : r.loginAt,
            expiresAt: r.expiresAt instanceof Date ? r.expiresAt.toISOString() : r.expiresAt,
        })),
    });
});

// ────────────────────────────────────────────
// GET /sessions/stats — Daily (7d) + Weekly (4w) aggregations
// ────────────────────────────────────────────
admin.get('/sessions/stats', async (c) => {
    const now = new Date();

    // --- Daily counts for last 7 days ---
    const daily: { date: string; count: number }[] = [];
    for (let i = 0; i < 7; i++) {
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);

        const result = await db
            .select({ count: sql<number>`count(*)` })
            .from(sessions)
            .where(and(gte(sessions.loginAt, dayStart), lt(sessions.loginAt, dayEnd)));

        daily.push({
            date: `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, '0')}-${String(dayStart.getDate()).padStart(2, '0')}`,
            count: result[0]?.count ?? 0,
        });
    }

    // --- Weekly counts for last 4 weeks ---
    const weekly: { weekStart: string; weekEnd: string; count: number }[] = [];
    for (let i = 0; i < 4; i++) {
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ...
        const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const weekStart = new Date(today.getTime() - (mondayOffset + i * 7) * 86400000);
        const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);

        const result = await db
            .select({ count: sql<number>`count(*)` })
            .from(sessions)
            .where(and(gte(sessions.loginAt, weekStart), lt(sessions.loginAt, weekEnd)));

        weekly.push({
            weekStart: `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`,
            weekEnd: `${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, '0')}-${String(weekEnd.getDate()).padStart(2, '0')}`,
            count: result[0]?.count ?? 0,
        });
    }

    return c.json({ daily, weekly });
});

// ────────────────────────────────────────────
// DELETE /sessions/:id — Revoke a session
// ────────────────────────────────────────────
admin.delete('/sessions/:id', adminMiddleware, async (c) => {
    const sessionId = c.req.param('id');

    const existing = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);

    if (existing.length === 0) {
        return c.json({ success: false, message: 'Session not found' }, 404);
    }

    await db
        .update(sessions)
        .set({ status: 'revoked' })
        .where(eq(sessions.id, sessionId));

    return c.json({ success: true, message: 'Session revoked' });
});

export default admin;
