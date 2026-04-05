/**
 * SMS OTP service via Twilio.
 *
 * Required env:
 *   TWILIO_ACCOUNT_SID — Twilio account SID
 *   TWILIO_AUTH_TOKEN  — Twilio auth token
 *   TWILIO_FROM        — Twilio phone number (e.g. +16812972764)
 *
 * Tracks SMS usage via settings table.
 * Caps at sms_hard_cap (150). Alerts at every 10% of sms_agreed_limit (108).
 */

import { getSetting, setSetting } from './settings';
import { sendUsageAlertEmail } from './email';

/** Get current SMS usage stats */
export async function getSmsStats(): Promise<{
    sent: number;
    agreedLimit: number;
    hardCap: number;
    usagePct: number;
    remaining: number;
    capped: boolean;
}> {
    const sent = Number(await getSetting('sms_sent_count')) || 0;
    const agreedLimit = Number(await getSetting('sms_agreed_limit')) || 108;
    const hardCap = Number(await getSetting('sms_hard_cap')) || 150;
    const usagePct = agreedLimit > 0 ? Math.round((sent / agreedLimit) * 100) : 0;
    const remaining = Math.max(0, hardCap - sent);
    const capped = sent >= hardCap;
    return { sent, agreedLimit, hardCap, usagePct, remaining, capped };
}

export async function sendSmsOTP(phone: string, otp: string): Promise<{ success: boolean; message: string }> {
    // --- Check SMS cap ---
    const stats = await getSmsStats();
    if (stats.capped) {
        console.warn(`[SMS] Hard cap reached (${stats.sent}/${stats.hardCap}) — OTP not sent`);
        return { success: false, message: `SMS limit reached (${stats.hardCap}). Contact admin.` };
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;

    if (!accountSid || !authToken || !from) {
        console.warn('[SMS] Twilio not configured — OTP not sent');
        return { success: false, message: 'SMS service not configured' };
    }

    // Ensure phone has + prefix
    const to = phone.startsWith('+') ? phone : '+' + phone;

    try {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
        const body = new URLSearchParams({
            To: to,
            From: from,
            Body: `${otp} is your Clubicles WiFi verification code. Valid for 5 minutes.`,
        });

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': 'Basic ' + btoa(accountSid + ':' + authToken),
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: body.toString(),
        });

        const data = await res.json() as Record<string, unknown>;

        if (res.ok && data.sid) {
            console.log(`[SMS] OTP sent to ${to} — SID: ${data.sid}`);

            // --- Increment counter & check alerts ---
            const newCount = stats.sent + 1;
            await setSetting('sms_sent_count', String(newCount));

            // Check 10% milestones against agreed limit
            const agreedLimit = stats.agreedLimit;
            const lastAlertPct = Number(await getSetting('sms_last_alert_pct')) || 0;
            const currentPct = Math.floor((newCount / agreedLimit) * 100);
            const currentBucket = Math.floor(currentPct / 10) * 10; // 0, 10, 20, ... 100+

            if (currentBucket > lastAlertPct && currentBucket >= 50) {
                await setSetting('sms_last_alert_pct', String(currentBucket));
                // Fire-and-forget alert email
                sendUsageAlertEmail({
                    sent: newCount,
                    agreedLimit,
                    hardCap: stats.hardCap,
                    pct: currentBucket,
                }).catch((err) => console.error('[SMS] Usage alert email error:', err));
            }

            return { success: true, message: 'OTP sent via SMS' };
        } else {
            const errMsg = (data.message as string) || `HTTP ${res.status}`;
            console.error(`[SMS] Twilio error for ${to}: ${errMsg}`);
            return { success: false, message: errMsg };
        }
    } catch (err) {
        console.error('[SMS] Failed to send OTP:', err);
        return { success: false, message: String(err) };
    }
}
