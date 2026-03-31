/**
 * Portal routes — the core captive portal user flow.
 *
 * GET  /           — Entry point (Omada redirect), serves HTML with injected params
 * POST /send-otp   — Validate user, generate OTP, send via Email (Resend), return otpToken
 * POST /verify-otp — Verify OTP, return authToken
 * POST /accept     — Accept T&C, authorize client via Omada, create session
 */

import { Hono } from 'hono';
import { eq, desc, and, gt } from 'drizzle-orm';
import { db } from '../db/index';
import { users, otpRequests, sessions } from '../db/schema';
import { generateOTP, hashOTP, verifyOTPHash } from '../utils/otp';
import { sendEmailOTP } from '../services/email';
import { omada } from '../services/omada';
import { calculateSessionExpiry, getOmadaAuthMinutes } from '../services/settings';
import {
    signOtpToken,
    signAuthToken,
    verifyOtpToken,
    authMiddleware,
} from '../middleware/auth';

const portal = new Hono();

// ────────────────────────────────────────────
// GET / — Entry point (Omada redirects here)
// ────────────────────────────────────────────
portal.get('/', async (c) => {
    const clientMac = c.req.query('clientMac') || '';
    const apMac = c.req.query('apMac') || '';
    // Omada sends "ssidName" not "ssid"
    const ssid = c.req.query('ssidName') || c.req.query('ssid') || '';
    const radioId = c.req.query('radioId') || '0';
    const redirectUrl = c.req.query('redirectUrl') || '';

    // --- Auto-reauth: if this MAC has an active session, re-authorize silently ---
    if (clientMac && clientMac !== 'DIRECT-ACCESS') {
        const now = new Date();
        const activeSession = await db
            .select()
            .from(sessions)
            .where(
                and(
                    eq(sessions.macAddress, clientMac),
                    eq(sessions.status, 'active'),
                    gt(sessions.expiresAt, now)
                )
            )
            .orderBy(desc(sessions.loginAt))
            .limit(1);

        if (activeSession.length > 0) {
            console.log(`[Portal] Auto-reauth for returning client ${clientMac}`);
            try {
                const authMinutes = await getOmadaAuthMinutes();
                const result = await omada.authorizeClient(
                    clientMac, apMac, ssid, Number(radioId), authMinutes
                );
                if (result.success) {
                    console.log(`[Portal] Auto-reauth successful for ${clientMac}`);
                    // Always serve the portal HTML with autoReauth flag
                    // Don't redirect — captive portal browsers need our page to dismiss
                    const htmlFile = Bun.file('./static/index.html');
                    let html = await htmlFile.text();
                    const script = `<script>
window.__PORTAL__ = {
  clientMac: ${JSON.stringify(clientMac)},
  apMac: ${JSON.stringify(apMac)},
  ssid: ${JSON.stringify(ssid)},
  radioId: ${JSON.stringify(Number(radioId))},
  redirectUrl: ${JSON.stringify(redirectUrl)},
  autoReauth: true
};
</script>`;
                    html = html.replace('</head>', `${script}\n</head>`);
                    return c.html(html);
                }
            } catch (err) {
                console.error('[Portal] Auto-reauth failed:', err);
                // Fall through to normal portal flow
            }
        }
    }

    // Read the static HTML file
    const htmlFile = Bun.file('./static/index.html');
    let html = await htmlFile.text();

    // Inject Omada params as a script block before </head>
    const portalScript = `<script>
window.__PORTAL__ = {
  clientMac: ${JSON.stringify(clientMac)},
  apMac: ${JSON.stringify(apMac)},
  ssid: ${JSON.stringify(ssid)},
  radioId: ${JSON.stringify(Number(radioId))},
  redirectUrl: ${JSON.stringify(redirectUrl)}
};
</script>`;

    html = html.replace('</head>', `${portalScript}\n</head>`);

    return c.html(html);
});

// ────────────────────────────────────────────
// POST /send-otp — Send OTP to user's phone
// ────────────────────────────────────────────
portal.post('/send-otp', async (c) => {
    const body = await c.req.json();
    const { name, email, phone, clientMac, apMac, ssid, radioId, redirectUrl } = body;

    // --- Validate ---
    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 100) {
        return c.json({ success: false, message: 'Name is required (1-100 characters)' }, 400);
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return c.json({ success: false, message: 'Valid email is required' }, 400);
    }
    if (!phone || typeof phone !== 'string' || !/^\d{10,12}$/.test(phone)) {
        return c.json({ success: false, message: 'Valid phone number is required (10-12 digits)' }, 400);
    }
    // clientMac is optional — may be empty when testing via browser directly
    const mac = (clientMac && typeof clientMac === 'string') ? clientMac : 'DIRECT-ACCESS';

    // --- Rate limit: no OTP sent for this phone in last 60 seconds ---
    const sixtySecondsAgo = new Date(Date.now() - 60_000);
    const recentOtp = await db
        .select()
        .from(otpRequests)
        .where(
            and(
                eq(otpRequests.phone, phone),
                gt(otpRequests.createdAt, sixtySecondsAgo),
                eq(otpRequests.verified, 0)
            )
        )
        .limit(1);

    if (recentOtp.length > 0) {
        return c.json({ success: false, message: 'OTP already sent. Please wait 60 seconds.' }, 429);
    }

    // --- Upsert user ---
    const existingUser = await db
        .select()
        .from(users)
        .where(eq(users.phone, phone))
        .limit(1);

    if (existingUser.length > 0) {
        await db
            .update(users)
            .set({ name: name.trim(), email: email.trim() })
            .where(eq(users.phone, phone));
    } else {
        await db.insert(users).values({
            name: name.trim(),
            email: email.trim(),
            phone,
        });
    }

    // --- Generate & store OTP ---
    // Test bypass: fixed OTP for test email, no email sent
    const isTestEmail = email.trim().toLowerCase() === 'girishcodes@gmail.com';
    const otp = isTestEmail ? '123456' : generateOTP();
    const otpHash = await hashOTP(otp);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await db.insert(otpRequests).values({
        phone,
        otpHash,
        expiresAt,
    });

    // --- Send OTP via Email (Resend) ---
    let emailResult = { success: true, message: 'Test OTP: 123456' };
    if (!isTestEmail) {
        if (process.env.NODE_ENV === 'development') {
            console.log(`[DEV] OTP for ${email}: ${otp}`);
        }
        emailResult = await sendEmailOTP(email.trim(), otp);
        if (!emailResult.success) {
            console.warn(`[Portal] Email OTP failed for ${email}: ${emailResult.message}`);
        }
    } else {
        console.log(`[Portal] Test email detected — OTP fixed to 123456, skipping email`);
    }

    // --- Sign OTP token ---
    const otpToken = await signOtpToken({
        phone,
        clientMac: mac,
        apMac: apMac || '',
        ssid: ssid || '',
        radioId: Number(radioId) || 0,
        redirectUrl: redirectUrl || '',
    });

    return c.json({
        success: true,
        message: emailResult.success ? 'OTP sent to your email' : 'OTP generated (email service not configured)',
        otpToken,
    });
});

// ────────────────────────────────────────────
// POST /verify-otp — Verify OTP entered by user
// ────────────────────────────────────────────
portal.post('/verify-otp', async (c) => {
    const body = await c.req.json();
    const { otp, otpToken } = body;

    if (!otp || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
        return c.json({ success: false, message: 'Valid 6-digit OTP is required' }, 400);
    }
    if (!otpToken || typeof otpToken !== 'string') {
        return c.json({ success: false, message: 'OTP token is required' }, 400);
    }

    // --- Decode OTP token ---
    let payload;
    try {
        payload = await verifyOtpToken(otpToken);
    } catch {
        return c.json({ success: false, message: 'Invalid or expired OTP token' }, 401);
    }

    const { phone, clientMac, apMac, ssid, radioId, redirectUrl } = payload;

    // --- Lookup latest unverified OTP for this phone ---
    const now = new Date();
    const otpRecord = await db
        .select()
        .from(otpRequests)
        .where(
            and(
                eq(otpRequests.phone, phone),
                eq(otpRequests.verified, 0),
                gt(otpRequests.expiresAt, now)
            )
        )
        .orderBy(desc(otpRequests.createdAt))
        .limit(1);

    if (otpRecord.length === 0) {
        return c.json({ success: false, message: 'No valid OTP found. Please request a new one.' }, 400);
    }

    // --- Compare hash ---
    const isValid = await verifyOTPHash(otp, otpRecord[0].otpHash);
    if (!isValid) {
        return c.json({ success: false, message: 'Invalid OTP' }, 400);
    }

    // --- Mark OTP as verified ---
    await db
        .update(otpRequests)
        .set({ verified: 1 })
        .where(eq(otpRequests.id, otpRecord[0].id));

    // --- Look up user to get userId ---
    const user = await db
        .select()
        .from(users)
        .where(eq(users.phone, phone))
        .limit(1);

    if (user.length === 0) {
        return c.json({ success: false, message: 'User not found' }, 400);
    }

    // --- Sign auth token ---
    const authToken = await signAuthToken({
        userId: user[0].id,
        phone,
        clientMac,
        apMac,
        ssid,
        radioId,
        redirectUrl,
    });

    return c.json({ success: true, authToken });
});

// ────────────────────────────────────────────
// POST /accept — Accept T&C, authorize WiFi via Omada
// ────────────────────────────────────────────
portal.post('/accept', authMiddleware, async (c) => {
    const jwtPayload = c.get('jwtPayload');
    const { userId, clientMac, apMac, ssid, radioId, redirectUrl } = jwtPayload;

    // --- Call Omada to authorize client ---
    const authMinutes = await getOmadaAuthMinutes();
    let omadaResult;
    try {
        omadaResult = await omada.authorizeClient(clientMac, apMac, ssid, radioId, authMinutes);
    } catch (err) {
        console.error('[Portal] Omada auth error:', err);
        omadaResult = { success: false, errorCode: -1 };
    }

    if (!omadaResult.success) {
        console.error('[Portal] Omada authorization failed:', omadaResult);
        // Still create the session record for tracking — Omada might be temporarily down
    }

    // --- Create session record (uses global cutoff or fixed duration) ---
    const expiresAt = await calculateSessionExpiry();

    await db.insert(sessions).values({
        userId,
        macAddress: clientMac,
        apMac: apMac || null,
        ssid: ssid || null,
        redirectUrl: redirectUrl || null,
        expiresAt,
        status: 'active',
    });

    return c.json({
        success: true,
        message: 'Connected! You now have internet access.',
        redirectUrl: redirectUrl || null,
        omadaAuthorized: omadaResult.success,
    });
});

export default portal;
