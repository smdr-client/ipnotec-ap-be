/**
 * Omada Controller API v2 client.
 *
 * Handles the 3-step authentication flow and external portal client authorization.
 *
 * Auth flow (from omada-api-toolkit docs):
 *   1. GET  /api/info                         → get omadacId (controller ID)
 *   2. POST /{omadacId}/api/v2/login           → get CSRF token + session cookie
 *   3. GET  /{omadacId}/api/v2/sites           → get siteId
 *   4. Every request needs: Csrf-Token header + ?token= URL param + session cookie
 *
 * Auth endpoint (extPortal/auth) does NOT use siteId in the URL.
 * Other site-scoped endpoints use: /{omadacId}/api/v2/sites/{siteId}/...
 *
 * CRITICAL PITFALL: CSRF token must be in BOTH the header AND the URL param.
 * Missing either causes a silent redirect to the login page (returns HTML, not JSON).
 *
 * Required env:
 *   OMADA_URL      — e.g. https://localhost:8043 (same VM)
 *   OMADA_USER     — admin username
 *   OMADA_PASS     — admin password
 *   OMADA_SITE_ID  — (optional) site ID, auto-discovered if not set
 */

class OmadaClient {
    private host: string;
    private omadacId: string = '';
    private siteId: string = '';
    private csrfToken: string = '';
    private sessionCookie: string = '';
    private retrying: boolean = false;

    constructor() {
        this.host = process.env.OMADA_URL || '';
        this.siteId = process.env.OMADA_SITE_ID || '';
    }

    /** Step 1: Fetch the controller ID from /api/info */
    async init(): Promise<void> {
        if (!this.host) {
            throw new Error('[Omada] OMADA_URL not configured');
        }

        const res = await fetch(`${this.host}/api/info`, {
            // @ts-expect-error — Bun-specific TLS option for self-signed certs
            tls: { rejectUnauthorized: false },
        });

        const data = await res.json() as { errorCode: number; result: { omadacId: string } };
        if (!data.result?.omadacId) {
            throw new Error('[Omada] Failed to get controller ID from /api/info');
        }

        this.omadacId = data.result.omadacId;
        console.log(`[Omada] Controller ID: ${this.omadacId}`);
    }

    /** Step 2: Login and obtain CSRF token + session cookie */
    async login(): Promise<void> {
        if (!this.omadacId) await this.init();

        const url = `${this.host}/${this.omadacId}/api/v2/login`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: process.env.OMADA_USER,
                password: process.env.OMADA_PASS,
            }),
            // @ts-expect-error — Bun-specific TLS option
            tls: { rejectUnauthorized: false },
        });

        // Extract session cookie
        const setCookie = res.headers.get('set-cookie') || '';
        const match = setCookie.match(/TPOMADA_SESSIONID=[^;]+/);
        this.sessionCookie = match ? match[0] : setCookie.split(';')[0];

        const data = await res.json() as { errorCode: number; result?: { token: string } };
        if (data.errorCode !== 0 || !data.result?.token) {
            throw new Error(`[Omada] Login failed: errorCode=${data.errorCode}`);
        }

        this.csrfToken = data.result.token;
        console.log('[Omada] Login successful, CSRF token obtained');

        // Step 3: Discover siteId if not configured
        if (!this.siteId) {
            await this.discoverSiteId();
        }
    }

    /** Step 3: Discover the siteId from the controller */
    private async discoverSiteId(): Promise<void> {
        const url = `${this.host}/${this.omadacId}/api/v2/sites?currentPage=1&currentPageSize=100&token=${encodeURIComponent(this.csrfToken)}`;
        const res = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                'Csrf-Token': this.csrfToken,
                'Cookie': this.sessionCookie,
            },
            // @ts-expect-error — Bun-specific TLS option
            tls: { rejectUnauthorized: false },
        });

        const data = await res.json() as { errorCode: number; result?: { data?: Array<{ id: string; name: string }> } };
        const sites = data.result?.data;
        if (!sites || sites.length === 0) {
            console.warn('[Omada] No sites found — siteId will be empty');
            return;
        }

        this.siteId = sites[0].id;
        console.log(`[Omada] Site discovered: "${sites[0].name}" (${this.siteId})`);
    }

    /** Ensure we have a valid session (login if needed) */
    private async ensureSession(): Promise<void> {
        if (!this.csrfToken) {
            await this.login();
        }
    }

    /**
     * Authorize a WiFi client via the external portal auth endpoint.
     *
     * POST /{omadacId}/api/v2/hotspot/extPortal/auth
     *
     * @param clientMac  — client device MAC (e.g. "AA-BB-CC-DD-EE-FF")
     * @param apMac      — access point MAC
     * @param ssid       — network SSID
     * @param radioId    — radio band ID (0 = 2.4GHz, 1 = 5GHz)
     * @param minutes    — session duration in minutes (default: 1440 = 24 hours)
     */
    async authorizeClient(
        clientMac: string,
        apMac: string,
        ssid: string,
        radioId: number = 0,
        minutes: number = 1440
    ): Promise<{ success: boolean; errorCode: number; data?: unknown }> {
        await this.ensureSession();

        // CRITICAL: token must be in BOTH the URL param AND the header
        const url = `${this.host}/${this.omadacId}/api/v2/hotspot/extPortal/auth?token=${encodeURIComponent(this.csrfToken)}`;

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Csrf-Token': this.csrfToken,
                    'Cookie': this.sessionCookie,
                },
                body: JSON.stringify({
                    clientMac,
                    apMac,
                    ssid,
                    radioId,
                    time: minutes,
                    authType: 4,
                }),
                // @ts-expect-error — Bun-specific TLS option
                tls: { rejectUnauthorized: false },
            });

            // Check if we got HTML back (means session expired / token invalid)
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('text/html')) {
                if (!this.retrying) {
                    console.warn('[Omada] Got HTML response — session expired, re-authenticating...');
                    this.retrying = true;
                    this.csrfToken = '';
                    this.sessionCookie = '';
                    const result = await this.authorizeClient(clientMac, apMac, ssid, radioId, minutes);
                    this.retrying = false;
                    return result;
                }
                this.retrying = false;
                return { success: false, errorCode: -1, data: 'Re-authentication failed' };
            }

            const data = await res.json() as { errorCode: number; msg?: string; result?: unknown };

            if (data.errorCode === 0) {
                console.log(`[Omada] Client authorized: ${clientMac} for ${minutes} min`);
                return { success: true, errorCode: 0, data: data.result };
            }

            // Non-zero error — try re-login once
            if (!this.retrying) {
                console.warn(`[Omada] Auth failed (errorCode=${data.errorCode}), retrying...`);
                this.retrying = true;
                this.csrfToken = '';
                this.sessionCookie = '';
                const result = await this.authorizeClient(clientMac, apMac, ssid, radioId, minutes);
                this.retrying = false;
                return result;
            }

            this.retrying = false;
            console.error(`[Omada] Auth failed after retry: ${data.msg || JSON.stringify(data)}`);
            return { success: false, errorCode: data.errorCode, data };
        } catch (err) {
            console.error('[Omada] Network error during auth:', err);
            return { success: false, errorCode: -1, data: String(err) };
        }
    }
    /**
     * Check Omada connectivity and return diagnostic info.
     * Used by the /health/omada endpoint.
     */
    async healthCheck(): Promise<{
        reachable: boolean;
        loggedIn: boolean;
        controllerVersion?: string;
        siteId?: string;
        siteName?: string;
        portalEnabled?: boolean;
        error?: string;
    }> {
        try {
            // Step 1: Check reachability
            const infoRes = await fetch(`${this.host}/api/info`, {
                // @ts-expect-error — Bun-specific TLS option
                tls: { rejectUnauthorized: false },
            });
            const info = await infoRes.json() as { errorCode: number; result?: { controllerVer: string; omadacId: string } };
            if (info.errorCode !== 0 || !info.result?.omadacId) {
                return { reachable: false, loggedIn: false, error: 'Cannot reach /api/info' };
            }

            // Step 2: Try login
            await this.login();

            // Step 3: Get site + portal info
            const headers = {
                'Content-Type': 'application/json',
                'Csrf-Token': this.csrfToken,
                'Cookie': this.sessionCookie,
            };
            const fetchOpts = { headers, tls: { rejectUnauthorized: false } } as RequestInit;

            // Get sites
            const sitesUrl = `${this.host}/${this.omadacId}/api/v2/sites?currentPage=1&currentPageSize=100&token=${encodeURIComponent(this.csrfToken)}`;
            // @ts-expect-error — Bun TLS
            const sitesRes = await fetch(sitesUrl, fetchOpts);
            const sitesData = await sitesRes.json() as { result?: { data?: Array<{ id: string; name: string }> } };
            const site = sitesData.result?.data?.[0];

            // Get portal config
            let portalEnabled = false;
            if (site) {
                const portalUrl = `${this.host}/${this.omadacId}/api/v2/sites/${site.id}/setting/portals?currentPage=1&currentPageSize=100&token=${encodeURIComponent(this.csrfToken)}`;
                // @ts-expect-error — Bun TLS
                const portalRes = await fetch(portalUrl, fetchOpts);
                const portalData = await portalRes.json() as { result?: Array<{ enable: boolean; pageType: number }> };
                const portal = portalData.result?.[0];
                portalEnabled = portal?.enable === true;
            }

            return {
                reachable: true,
                loggedIn: true,
                controllerVersion: info.result.controllerVer,
                siteId: site?.id,
                siteName: site?.name,
                portalEnabled,
            };
        } catch (err) {
            return { reachable: false, loggedIn: false, error: String(err) };
        }
    }
}

export const omada = new OmadaClient();
