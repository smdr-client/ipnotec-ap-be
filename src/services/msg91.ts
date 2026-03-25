/**
 * MSG91 OTP SMS service.
 * Sends OTP via MSG91 HTTP API.
 *
 * Required env:
 *   MSG91_AUTH_KEY    — your MSG91 auth key
 *   MSG91_TEMPLATE_ID — OTP template ID configured in MSG91
 */

const MSG91_OTP_URL = 'https://api.msg91.com/api/v5/otp';

export async function sendOTP(phone: string, otp: string): Promise<{ success: boolean; message: string }> {
    const authKey = process.env.MSG91_AUTH_KEY;
    const templateId = process.env.MSG91_TEMPLATE_ID;

    if (!authKey || !templateId) {
        console.warn('[MSG91] AUTH_KEY or TEMPLATE_ID not configured — OTP not sent');
        return { success: false, message: 'SMS service not configured' };
    }

    try {
        const res = await fetch(MSG91_OTP_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'authkey': authKey,
            },
            body: JSON.stringify({
                template_id: templateId,
                mobile: phone,
                otp,
            }),
        });

        const data = await res.json() as { type?: string; message?: string; request_id?: string };

        if (data.type === 'success') {
            console.log(`[MSG91] OTP sent to ${phone.slice(0, 4)}****`);
            return { success: true, message: 'OTP sent successfully' };
        }

        console.error('[MSG91] Failed to send OTP:', data.message || JSON.stringify(data));
        return { success: false, message: data.message || 'Failed to send OTP' };
    } catch (err) {
        console.error('[MSG91] Network error:', err);
        return { success: false, message: 'SMS service unavailable' };
    }
}
