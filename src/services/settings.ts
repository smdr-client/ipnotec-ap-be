import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { settings } from '../db/schema';

/** Default settings values */
const DEFAULTS: Record<string, string> = {
    // Session cutoff time in HH:MM (24h format). Sessions expire at this time daily.
    // Empty string means use fixed duration instead.
    session_cutoff_time: '',
    // Fixed session duration in minutes (used when cutoff_time is empty)
    session_duration_minutes: '1440',
    // Omada auth duration in minutes (sent to controller)
    omada_auth_minutes: '1440',
};

/** Get a setting value. Returns default if not set. */
export async function getSetting(key: string): Promise<string> {
    const row = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (row.length > 0) return row[0].value;
    return DEFAULTS[key] ?? '';
}

/** Set a setting value (upsert). */
export async function setSetting(key: string, value: string): Promise<void> {
    const existing = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    if (existing.length > 0) {
        await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key));
    } else {
        await db.insert(settings).values({ key, value });
    }
}

/** Get all settings as an object. */
export async function getAllSettings(): Promise<Record<string, string>> {
    const rows = await db.select().from(settings);
    const result = { ...DEFAULTS };
    for (const row of rows) {
        result[row.key] = row.value;
    }
    return result;
}

/**
 * Calculate session expiry time based on settings.
 * If cutoff_time is set (e.g. "00:00"), session expires at that time today/tomorrow.
 * Otherwise uses fixed duration.
 */
export async function calculateSessionExpiry(): Promise<Date> {
    const cutoff = await getSetting('session_cutoff_time');
    const durationStr = await getSetting('session_duration_minutes');

    if (cutoff && /^\d{1,2}:\d{2}$/.test(cutoff)) {
        const [hours, minutes] = cutoff.split(':').map(Number);
        const now = new Date();
        const expiry = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);
        // If cutoff is already past today, set it for tomorrow
        if (expiry <= now) {
            expiry.setDate(expiry.getDate() + 1);
        }
        return expiry;
    }

    // Fixed duration
    const minutes = parseInt(durationStr) || 1440;
    return new Date(Date.now() + minutes * 60 * 1000);
}

/** Get Omada auth duration in minutes. */
export async function getOmadaAuthMinutes(): Promise<number> {
    const cutoff = await getSetting('session_cutoff_time');

    if (cutoff && /^\d{1,2}:\d{2}$/.test(cutoff)) {
        const [hours, mins] = cutoff.split(':').map(Number);
        const now = new Date();
        const expiry = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0);
        if (expiry <= now) expiry.setDate(expiry.getDate() + 1);
        const diffMs = expiry.getTime() - now.getTime();
        return Math.max(Math.ceil(diffMs / 60000), 1);
    }

    const str = await getSetting('omada_auth_minutes');
    return parseInt(str) || 1440;
}
