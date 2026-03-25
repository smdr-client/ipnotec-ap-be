/**
 * Email OTP service via Resend.
 *
 * Required env:
 *   RESEND_API_KEY  — your Resend API key
 *   RESEND_FROM     — sender email (e.g. otp@yourdomain.com)
 */

import { Resend } from 'resend';

export async function sendEmailOTP(email: string, otp: string): Promise<{ success: boolean; message: string }> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM || 'IPNOTEC <otp@ipnotec.in>';

    if (!apiKey) {
        console.warn('[Email] RESEND_API_KEY not configured — OTP not sent');
        return { success: false, message: 'Email service not configured' };
    }

    try {
        const resend = new Resend(apiKey);

        const { error } = await resend.emails.send({
            from,
            to: email,
            subject: `${otp} is your IPNOTEC WiFi verification code`,
            html: `
                <div style="font-family:monospace;background:#000;color:#39FF14;padding:40px;text-align:center;">
                    <h1 style="font-size:2rem;margin-bottom:10px;">IPNOTEC</h1>
                    <p style="color:#aaa;font-size:0.85rem;">Free WiFi Access · OTP Verification</p>
                    <div style="font-size:2.5rem;letter-spacing:0.5em;margin:30px 0;color:#39FF14;">
                        ${otp}
                    </div>
                    <p style="color:#888;font-size:0.8rem;">This code expires in 5 minutes.</p>
                    <p style="color:#555;font-size:0.7rem;margin-top:20px;">If you didn't request this, ignore this email.</p>
                </div>
            `,
        });

        if (error) {
            console.error('[Email] Resend error:', error);
            return { success: false, message: error.message || 'Failed to send email' };
        }

        console.log(`[Email] OTP sent to ${email}`);
        return { success: true, message: 'OTP sent to your email' };
    } catch (err) {
        console.error('[Email] Error:', err);
        return { success: false, message: 'Email service unavailable' };
    }
}
