/**
 * Email notification service via SMTP (nodemailer).
 *
 * Required env:
 *   SMTP_HOST     — SMTP server host (e.g. smtp.gmail.com)
 *   SMTP_PORT     — SMTP port (587 for TLS, 465 for SSL)
 *   SMTP_USER     — SMTP username (e.g. your Gmail address)
 *   SMTP_PASS     — SMTP password (e.g. Gmail App Password)
 *   SMTP_FROM     — sender address (e.g. "Clubicles <you@gmail.com>")
 *   NOTIFY_EMAIL  — admin email to receive new-registration alerts
 */

import nodemailer from 'nodemailer';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
    if (transporter) return transporter;

    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
        console.warn('[Email] SMTP not configured — emails will not be sent');
        return null;
    }

    transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
    });

    return transporter;
}

/**
 * Send a notification email to the admin when a new user registers.
 */
export async function sendNewRegistrationNotification(user: {
    name: string;
    email: string;
    phone: string;
    clientMac: string;
}): Promise<{ success: boolean; message: string }> {
    const smtp = getTransporter();
    const notifyEmail = process.env.NOTIFY_EMAIL || 'girishcodes@gmail.com';
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'Clubicles';

    if (!smtp) {
        return { success: false, message: 'SMTP not configured' };
    }

    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    try {
        await smtp.sendMail({
            from,
            to: notifyEmail,
            subject: `🆕 New Clubicles WiFi Registration — ${user.name}`,
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; background: #111; color: #fff; border-radius: 12px; overflow: hidden;">
                    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 24px; text-align: center;">
                        <h1 style="margin: 0; font-size: 1.5rem; color: #fff;">New Registration</h1>
                        <p style="margin: 4px 0 0; color: rgba(255,255,255,0.8); font-size: 0.85rem;">Clubicles WiFi Portal</p>
                    </div>
                    <div style="padding: 24px;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 10px 0; color: #888; font-size: 0.85rem;">Name</td>
                                <td style="padding: 10px 0; color: #fff; font-weight: 600; text-align: right;">${user.name}</td>
                            </tr>
                            <tr style="border-top: 1px solid #333;">
                                <td style="padding: 10px 0; color: #888; font-size: 0.85rem;">Phone</td>
                                <td style="padding: 10px 0; color: #39FF14; font-weight: 600; text-align: right;">+${user.phone}</td>
                            </tr>
                            <tr style="border-top: 1px solid #333;">
                                <td style="padding: 10px 0; color: #888; font-size: 0.85rem;">Email</td>
                                <td style="padding: 10px 0; color: #fff; text-align: right;">${user.email}</td>
                            </tr>
                            <tr style="border-top: 1px solid #333;">
                                <td style="padding: 10px 0; color: #888; font-size: 0.85rem;">MAC</td>
                                <td style="padding: 10px 0; color: #aaa; font-family: monospace; text-align: right;">${user.clientMac}</td>
                            </tr>
                            <tr style="border-top: 1px solid #333;">
                                <td style="padding: 10px 0; color: #888; font-size: 0.85rem;">Time</td>
                                <td style="padding: 10px 0; color: #aaa; text-align: right;">${now}</td>
                            </tr>
                        </table>
                    </div>
                </div>
            `,
        });

        console.log(`[Email] New registration notification sent for ${user.phone}`);
        return { success: true, message: 'Notification sent' };
    } catch (err) {
        console.error('[Email] Failed to send notification:', err);
        return { success: false, message: String(err) };
    }
}

/**
 * Send SMS usage alert email to admin(s) at every 10% milestone.
 */
export async function sendUsageAlertEmail(usage: {
    sent: number;
    agreedLimit: number;
    hardCap: number;
    pct: number;
}): Promise<{ success: boolean; message: string }> {
    const smtp = getTransporter();
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'Clubicles';

    if (!smtp) {
        return { success: false, message: 'SMTP not configured' };
    }

    // Send to both admins
    const recipients = ['girishcodes@gmail.com', 'bharath.bholey@ipnotec.com'];
    const remaining = usage.hardCap - usage.sent;
    const isWarning = usage.pct >= 80;
    const isCritical = usage.pct >= 100;

    const statusColor = isCritical ? '#ff4444' : isWarning ? '#ffaa00' : '#39FF14';
    const statusLabel = isCritical ? 'OVER AGREED LIMIT' : isWarning ? 'APPROACHING LIMIT' : 'ON TRACK';

    const overCount = isCritical ? usage.sent - usage.agreedLimit : 0;
    const subject = isCritical
        ? `⚠️ SMS OVER LIMIT — ${usage.sent}/${usage.agreedLimit} used (${overCount} over agreed limit)`
        : `📊 SMS Usage ${usage.pct}% — ${usage.sent}/${usage.agreedLimit} used`;

    const overLimitNote = isCritical
        ? `<div style="background:#ff444422;border:1px solid #ff4444;border-radius:8px;padding:12px;margin-bottom:16px;text-align:center;">
            <div style="font-size:1.1rem;font-weight:700;color:#ff4444;">⚠️ OVER AGREED LIMIT</div>
            <div style="font-size:.8rem;color:#ff8888;margin-top:4px;">${overCount} SMS sent beyond the agreed ${usage.agreedLimit} limit. Hard cap is ${usage.hardCap}.</div>
           </div>`
        : '';

    try {
        await smtp.sendMail({
            from,
            to: recipients.join(', '),
            subject,
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; background: #111; color: #fff; border-radius: 12px; overflow: hidden;">
                    <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 24px; text-align: center;">
                        <h1 style="margin: 0; font-size: 1.5rem; color: #fff;">SMS Usage Alert</h1>
                        <p style="margin: 4px 0 0; color: rgba(255,255,255,0.8); font-size: 0.85rem;">Clubicles WiFi Portal</p>
                    </div>
                    <div style="padding: 24px;">
                        ${overLimitNote}
                        <!-- Progress bar -->
                        <div style="background: #222; border-radius: 8px; height: 24px; overflow: hidden; margin-bottom: 20px; position: relative;">
                            <div style="background: ${statusColor}; height: 100%; width: ${Math.min(usage.pct, 100)}%; border-radius: 8px; transition: width 0.3s;"></div>
                            <span style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 0.75rem; font-weight: 700; color: #fff;">${usage.pct}%</span>
                        </div>
                        <div style="text-align: center; margin-bottom: 20px;">
                            <span style="display: inline-block; background: ${statusColor}22; color: ${statusColor}; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: 600;">${statusLabel}</span>
                        </div>
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 10px 0; color: #888; font-size: 0.85rem;">SMS Sent</td>
                                <td style="padding: 10px 0; color: #fff; font-weight: 600; text-align: right; font-size: 1.1rem;">${usage.sent}</td>
                            </tr>
                            <tr style="border-top: 1px solid #333;">
                                <td style="padding: 10px 0; color: #888; font-size: 0.85rem;">Agreed Limit</td>
                                <td style="padding: 10px 0; color: #aaa; text-align: right;">${usage.agreedLimit}</td>
                            </tr>
                            <tr style="border-top: 1px solid #333;">
                                <td style="padding: 10px 0; color: #888; font-size: 0.85rem;">Hard Cap</td>
                                <td style="padding: 10px 0; color: #aaa; text-align: right;">${usage.hardCap}</td>
                            </tr>
                            <tr style="border-top: 1px solid #333;">
                                <td style="padding: 10px 0; color: #888; font-size: 0.85rem;">Remaining</td>
                                <td style="padding: 10px 0; color: ${remaining <= 20 ? '#ff4444' : '#39FF14'}; font-weight: 600; text-align: right;">${remaining}</td>
                            </tr>
                        </table>
                    </div>
                </div>
            `,
        });

        console.log(`[Email] SMS usage alert sent (${usage.pct}% — ${usage.sent}/${usage.agreedLimit})`);
        return { success: true, message: 'Usage alert sent' };
    } catch (err) {
        console.error('[Email] Failed to send usage alert:', err);
        return { success: false, message: String(err) };
    }
}
