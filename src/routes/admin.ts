/**
 * Admin routes — dashboard API for session management + Omada integration.
 *
 * POST   /login                     — Authenticate admin, return JWT
 * GET    /sessions/today            — Today's sessions with user details
 * GET    /sessions/stats            — Daily (7d) and weekly (4w) aggregations
 * DELETE /sessions/:id              — Revoke a session + kick from WiFi
 * GET    /settings                  — Get all settings
 * PUT    /settings                  — Update settings
 * GET    /clients/unified           — Unified client view (DB + Omada merged)
 * GET    /users                     — All users with connection counts
 * POST   /omada/clients/:mac/auth   — Authorize a client from admin
 * POST   /omada/clients/:mac/kick   — Kick a client
 * GET    /omada/clients             — Raw Omada clients
 * GET    /omada/devices             — Raw Omada devices
 */

import { Hono } from 'hono';
import { eq, sql, gte, and, lt, desc, count as countFn } from 'drizzle-orm';
import { db } from '../db/index';
import { users, sessions } from '../db/schema';
import { signAdminToken, adminMiddleware } from '../middleware/auth';
import { omada } from '../services/omada';
import { getAllSettings, setSetting, calculateSessionExpiry, getOmadaAuthMinutes } from '../services/settings';
import { getSmsStats } from '../services/sms';

const admin = new Hono();

// ────────────────────────────────────────────
// GET / — Serve admin dashboard HTML
// ────────────────────────────────────────────
admin.get('/', async (c) => {
    const htmlFile = Bun.file('./static/admin.html');
    const html = await htmlFile.text();
    return c.html(html);
});

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
// DELETE /sessions/:id — Revoke a session + kick from WiFi
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

    // Also revoke ALL active sessions for this MAC to prevent auto-reauth
    const mac = existing[0].macAddress;
    if (mac && mac !== 'DIRECT-ACCESS') {
        await db
            .update(sessions)
            .set({ status: 'revoked' })
            .where(
                and(
                    eq(sessions.macAddress, mac),
                    eq(sessions.status, 'active')
                )
            );
    }
    let kicked = false;
    if (mac && mac !== 'DIRECT-ACCESS') {
        try {
            const result = await omada.unauthorizeClient(mac);
            kicked = result.success;
        } catch (err) {
            console.error('[Admin] Failed to kick client from Omada:', err);
        }
    }

    return c.json({ success: true, message: 'Session revoked', kicked });
});

// ── Omada integration routes ────────────────
admin.use('/omada/*', adminMiddleware);
admin.use('/settings', adminMiddleware);
admin.use('/clients/*', adminMiddleware);
admin.use('/users', adminMiddleware);

// ────────────────────────────────────────────
// GET /sms/stats — SMS usage stats
// ────────────────────────────────────────────
admin.get('/sms/stats', adminMiddleware, async (c) => {
    const stats = await getSmsStats();
    return c.json({ success: true, ...stats });
});

// ────────────────────────────────────────────
// GET /settings — Get all admin settings
// ────────────────────────────────────────────
admin.get('/settings', async (c) => {
    const all = await getAllSettings();
    return c.json({ success: true, settings: all });
});

// ────────────────────────────────────────────
// PUT /settings — Update settings
// ────────────────────────────────────────────
admin.put('/settings', async (c) => {
    const body = await c.req.json();
    const allowed = ['session_cutoff_time', 'session_duration_minutes', 'omada_auth_minutes'];

    for (const key of allowed) {
        if (body[key] !== undefined) {
            await setSetting(key, String(body[key]));
        }
    }

    const all = await getAllSettings();
    return c.json({ success: true, settings: all });
});

// ────────────────────────────────────────────
// GET /users — Phone-centric view: users with nested devices
// Query params: ?q=phone_search_term
// ────────────────────────────────────────────
admin.get('/users', async (c) => {
    const q = c.req.query('q')?.trim() || '';

    // 1. Fetch users (optionally filtered by phone search)
    let userRows;
    if (q) {
        userRows = await db
            .select()
            .from(users)
            .where(sql`${users.phone} LIKE ${'%' + q + '%'}`)
            .orderBy(desc(users.createdAt));
    } else {
        userRows = await db
            .select()
            .from(users)
            .orderBy(desc(users.createdAt));
    }

    if (!userRows.length) {
        return c.json({ success: true, users: [] });
    }

    // 2. Get all sessions for these users, grouped by userId + MAC
    const userIds = userRows.map(u => u.id);
    const allSessions = await db
        .select({
            userId: sessions.userId,
            macAddress: sessions.macAddress,
            ssid: sessions.ssid,
            apMac: sessions.apMac,
            loginAt: sessions.loginAt,
            expiresAt: sessions.expiresAt,
            status: sessions.status,
            sessionId: sessions.id,
        })
        .from(sessions)
        .where(sql`${sessions.userId} IN (${sql.join(userIds.map(id => sql`${id}`), sql`,`)})`)
        .orderBy(desc(sessions.loginAt));

    // 3. Get Omada clients for enrichment
    let omadaClients: any[] = [];
    try {
        const result = await omada.getClients();
        omadaClients = result.clients || [];
    } catch { /* Omada offline */ }

    const omadaByMac = new Map<string, any>();
    for (const oc of omadaClients) {
        const mac = (oc.mac || '').toUpperCase().replace(/[:-]/g, '-');
        omadaByMac.set(mac, oc);
    }

    // 4. Build nested structure: user → devices (grouped by MAC)
    const result = userRows.map(user => {
        const userSessions = allSessions.filter(s => s.userId === user.id);

        // Group sessions by MAC address
        const macMap = new Map<string, typeof userSessions>();
        for (const s of userSessions) {
            const mac = (s.macAddress || '').toUpperCase().replace(/[:-]/g, '-');
            if (!macMap.has(mac)) macMap.set(mac, []);
            macMap.get(mac)!.push(s);
        }

        const devices = Array.from(macMap.entries()).map(([mac, devSessions]) => {
            const latest = devSessions[0]; // already sorted desc
            const oc = omadaByMac.get(mac);
            const isConnected = !!oc;
            const isActive = latest.status === 'active' && latest.expiresAt instanceof Date && latest.expiresAt > new Date();

            return {
                mac,
                sessionCount: devSessions.length,
                lastSsid: latest.ssid || oc?.ssid || oc?.ssidName || '',
                lastLogin: latest.loginAt instanceof Date ? latest.loginAt.toISOString() : latest.loginAt,
                expiresAt: latest.expiresAt instanceof Date ? latest.expiresAt.toISOString() : latest.expiresAt,
                status: isActive ? 'active' : latest.status,
                connected: isConnected,
                // Omada enrichment
                ip: oc?.ip || '',
                apName: oc?.apName || oc?.connectDevName || '',
                rssi: oc?.rssi || oc?.signalLevel || 0,
                upload: oc?.upload || oc?.upBytes || oc?.activity || 0,
                download: oc?.download || oc?.downBytes || oc?.trafficDown || 0,
                uptime: oc?.uptime || oc?.connectedTime || 0,
            };
        });

        // Sort devices: connected first, then by last login
        devices.sort((a, b) => (b.connected ? 1 : 0) - (a.connected ? 1 : 0) || new Date(b.lastLogin).getTime() - new Date(a.lastLogin).getTime());

        return {
            id: user.id,
            name: user.name,
            email: user.email,
            phone: user.phone,
            createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt,
            totalSessions: userSessions.length,
            deviceCount: macMap.size,
            devices,
        };
    });

    return c.json({ success: true, users: result });
});

// ────────────────────────────────────────────
// GET /clients/unified — Merged view: Omada clients + DB session data
// ────────────────────────────────────────────
admin.get('/clients/unified', async (c) => {
    // Fetch Omada clients and DB sessions in parallel
    let omadaClients: any[] = [];
    try {
        const result = await omada.getClients();
        omadaClients = result.clients || [];
    } catch { /* Omada offline */ }

    // Get all active sessions with user data
    const now = new Date();
    const activeSessions = await db
        .select({
            sessionId: sessions.id,
            userId: sessions.userId,
            name: users.name,
            email: users.email,
            phone: users.phone,
            macAddress: sessions.macAddress,
            ssid: sessions.ssid,
            loginAt: sessions.loginAt,
            expiresAt: sessions.expiresAt,
            status: sessions.status,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.status, 'active'))
        .orderBy(desc(sessions.loginAt));

    // Get connection counts per user
    const userCounts = await db
        .select({
            userId: sessions.userId,
            totalSessions: sql<number>`count(*)`,
        })
        .from(sessions)
        .groupBy(sessions.userId);

    const countMap = new Map(userCounts.map(r => [r.userId, r.totalSessions]));

    // Build MAC → session lookup
    const macToSession = new Map<string, typeof activeSessions[0]>();
    for (const s of activeSessions) {
        const mac = s.macAddress?.toUpperCase().replace(/[:-]/g, '-');
        if (mac) macToSession.set(mac, s);
    }

    // Merge: start with Omada clients, enrich with DB data
    const unified = omadaClients.map((oc: any) => {
        const mac = (oc.mac || '').toUpperCase().replace(/[:-]/g, '-');
        const session = macToSession.get(mac);
        macToSession.delete(mac); // remove matched

        return {
            // Omada data
            mac,
            ip: oc.ip || '',
            name: session?.name || oc.name || oc.hostName || oc.deviceName || '',
            ssid: oc.ssid || oc.ssidName || '',
            apName: oc.apName || oc.connectDevName || '',
            rssi: oc.rssi || oc.signalLevel || 0,
            upload: oc.upload || oc.upBytes || oc.activity || 0,
            download: oc.download || oc.downBytes || oc.trafficDown || 0,
            uptime: oc.uptime || oc.connectedTime || 0,
            // DB data
            email: session?.email || '',
            phone: session?.phone || '',
            loginAt: session?.loginAt instanceof Date ? session.loginAt.toISOString() : session?.loginAt || '',
            expiresAt: session?.expiresAt instanceof Date ? session.expiresAt.toISOString() : session?.expiresAt || '',
            sessionStatus: session?.status || '',
            totalConnections: session ? (countMap.get(session.userId) || 0) : 0,
            source: 'omada',
            authorized: !!session,
        };
    });

    // Add DB-only sessions (not in Omada — might be offline)
    for (const [mac, session] of macToSession) {
        unified.push({
            mac,
            ip: '',
            name: session.name,
            ssid: session.ssid || '',
            apName: '',
            rssi: 0,
            upload: 0,
            download: 0,
            uptime: 0,
            email: session.email,
            phone: session.phone,
            loginAt: session.loginAt instanceof Date ? session.loginAt.toISOString() : session.loginAt,
            expiresAt: session.expiresAt instanceof Date ? session.expiresAt.toISOString() : session.expiresAt,
            sessionStatus: session.status,
            totalConnections: countMap.get(session.userId) || 0,
            source: 'db-only',
            authorized: false,
        });
    }

    return c.json({ success: true, clients: unified });
});

// ────────────────────────────────────────────
// POST /omada/clients/:mac/auth — Authorize a pending client from admin
// ────────────────────────────────────────────
admin.post('/omada/clients/:mac/auth', adminMiddleware, async (c) => {
    const mac = c.req.param('mac');
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const apMac = (body.apMac as string) || '';
    const ssid = (body.ssid as string) || '';
    const radioId = Number(body.radioId) || 0;

    try {
        const authMinutes = await getOmadaAuthMinutes();
        const result = await omada.authorizeClient(mac, apMac, ssid, radioId, authMinutes);

        if (result.success) {
            // Create a session record if we have user info
            const userId = body.userId as string;
            if (userId) {
                const expiresAt = await calculateSessionExpiry();
                await db.insert(sessions).values({
                    userId,
                    macAddress: mac,
                    apMac: apMac || null,
                    ssid: ssid || null,
                    expiresAt,
                    status: 'active',
                });
            }
        }

        return c.json({ success: result.success, errorCode: result.errorCode });
    } catch (err) {
        return c.json({ success: false, message: String(err) }, 503);
    }
});

// ────────────────────────────────────────────
// GET /omada/clients — Connected WiFi clients from Omada
// ────────────────────────────────────────────
admin.get('/omada/clients', async (c) => {
    try {
        const result = await omada.getClients();
        return c.json({ success: result.success, clients: result.clients });
    } catch (err) {
        return c.json({ success: false, message: String(err), clients: [] }, 503);
    }
});

// ────────────────────────────────────────────
// GET /omada/devices — Managed devices (APs, switches, etc.)
// ────────────────────────────────────────────
admin.get('/omada/devices', async (c) => {
    try {
        const result = await omada.getDevices();
        return c.json({ success: result.success, devices: result.devices });
    } catch (err) {
        return c.json({ success: false, message: String(err), devices: [] }, 503);
    }
});

// ────────────────────────────────────────────
// POST /omada/clients/:mac/kick — Unauthorize/disconnect a client + revoke sessions
// ────────────────────────────────────────────
admin.post('/omada/clients/:mac/kick', adminMiddleware, async (c) => {
    const mac = c.req.param('mac');
    try {
        // Revoke all active DB sessions for this MAC so auto-reauth won't reconnect
        const normalizedMac = mac.toUpperCase().replace(/[:-]/g, '-');
        await db
            .update(sessions)
            .set({ status: 'revoked' })
            .where(
                and(
                    eq(sessions.macAddress, normalizedMac),
                    eq(sessions.status, 'active')
                )
            );
        // Also try original MAC format (lowercase, colons, etc.)
        if (normalizedMac !== mac) {
            await db
                .update(sessions)
                .set({ status: 'revoked' })
                .where(
                    and(
                        eq(sessions.macAddress, mac),
                        eq(sessions.status, 'active')
                    )
                );
        }

        const result = await omada.unauthorizeClient(mac);
        return c.json({ success: result.success, errorCode: result.errorCode });
    } catch (err) {
        return c.json({ success: false, message: String(err) }, 503);
    }
});

export default admin;
