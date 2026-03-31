/**
 * Omada Controller API client (v2 + Open API v1).
 *
 * Uses TWO auth mechanisms:
 *   - v2 API (session-based): for getClients, getDevices, unauthorize, health
 *   - Open API v1 (OAuth2 token): for hotspot client authorization
 *
 * The Open API hotspot/clients/{mac}/auth endpoint is the proper way to
 * authorize captive-portal clients. The v2 extPortal/auth sets auth temporarily
 * but reverts after ~10 seconds.
 *
 * Open API token format (client_credentials mode):
 *   POST /openapi/authorize/token?grant_type=client_credentials
 *   Body: { omadacId, client_id, client_secret }
 *   Response header format: Authorization: AccessToken=<token>
 *
 * Required env:
 *   OMADA_URL           — e.g. https://localhost:8043
 *   OMADA_USER          — admin username (for v2 API)
 *   OMADA_PASS          — admin password (for v2 API)
 *   OMADA_SITE_ID       — site ID
 *   OMADA_CLIENT_ID     — Open API client ID
 *   OMADA_CLIENT_SECRET — Open API client secret
 */

class OmadaClient {
    private host: string;
    private omadacId: string = '';
    private siteId: string = '';
    private csrfToken: string = '';
    private sessionCookie: string = '';
    private retrying: boolean = false;

    // Open API token state
    private openApiToken: string = '';
    private openApiTokenExpiry: number = 0;
    private openApiRefreshToken: string = '';

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

    /** Common headers for authenticated requests */
    private authHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Csrf-Token': this.csrfToken,
            'Cookie': this.sessionCookie,
        };
    }

    // ── Open API v1 (OAuth2) ────────────────────────────────────────

    /** Get a valid Open API access token, refreshing or re-acquiring as needed */
    private async ensureOpenApiToken(): Promise<void> {
        if (!this.omadacId) await this.init();

        // Token still valid (with 60s buffer)
        if (this.openApiToken && Date.now() < this.openApiTokenExpiry - 60_000) {
            return;
        }

        // Try refresh first
        if (this.openApiRefreshToken) {
            try {
                await this.refreshOpenApiToken();
                return;
            } catch {
                console.warn('[Omada] Refresh token failed, re-acquiring...');
            }
        }

        // Acquire new token via client_credentials
        await this.acquireOpenApiToken();
    }

    /** Acquire a new Open API token using client_credentials */
    private async acquireOpenApiToken(): Promise<void> {
        const url = `${this.host}/openapi/authorize/token?grant_type=client_credentials`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                omadacId: this.omadacId,
                client_id: process.env.OMADA_CLIENT_ID,
                client_secret: process.env.OMADA_CLIENT_SECRET,
            }),
            // @ts-expect-error — Bun-specific TLS option
            tls: { rejectUnauthorized: false },
        });

        const data = await res.json() as {
            errorCode: number;
            msg?: string;
            result?: { accessToken: string; expiresIn: number; refreshToken: string };
        };

        if (data.errorCode !== 0 || !data.result?.accessToken) {
            throw new Error(`[Omada] Open API token failed: errorCode=${data.errorCode}, msg=${data.msg}`);
        }

        this.openApiToken = data.result.accessToken;
        this.openApiRefreshToken = data.result.refreshToken;
        this.openApiTokenExpiry = Date.now() + data.result.expiresIn * 1000;
        console.log(`[Omada] Open API token acquired (expires in ${data.result.expiresIn}s)`);
    }

    /** Refresh the Open API token */
    private async refreshOpenApiToken(): Promise<void> {
        const url = `${this.host}/openapi/authorize/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(this.openApiRefreshToken)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: process.env.OMADA_CLIENT_ID,
                client_secret: process.env.OMADA_CLIENT_SECRET,
            }),
            // @ts-expect-error — Bun-specific TLS option
            tls: { rejectUnauthorized: false },
        });

        const data = await res.json() as {
            errorCode: number;
            result?: { accessToken: string; expiresIn: number; refreshToken: string };
        };

        if (data.errorCode !== 0 || !data.result?.accessToken) {
            this.openApiToken = '';
            this.openApiRefreshToken = '';
            throw new Error(`[Omada] Open API refresh failed: errorCode=${data.errorCode}`);
        }

        this.openApiToken = data.result.accessToken;
        this.openApiRefreshToken = data.result.refreshToken;
        this.openApiTokenExpiry = Date.now() + data.result.expiresIn * 1000;
        console.log('[Omada] Open API token refreshed');
    }

    /** Headers for Open API requests */
    private openApiHeaders(): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `AccessToken=${this.openApiToken}`,
        };
    }

    // ── Client Authorization (Open API) ─────────────────────────────

    /**
     * Authorize a WiFi client via the Open API hotspot endpoint.
     * This is the proper way to authorize captive-portal clients —
     * the v2 extPortal/auth sets auth temporarily but reverts after ~10s.
     */
    async authorizeClient(
        clientMac: string,
        _apMac?: string,
        _ssid?: string,
        _radioId?: number,
        _minutes?: number
    ): Promise<{ success: boolean; errorCode: number; data?: unknown }> {
        try {
            await this.ensureOpenApiToken();

            const url = `${this.host}/openapi/v1/${this.omadacId}/sites/${this.siteId}/hotspot/clients/${encodeURIComponent(clientMac)}/auth`;
            const res = await fetch(url, {
                method: 'POST',
                headers: this.openApiHeaders(),
                // @ts-expect-error — Bun-specific TLS option
                tls: { rejectUnauthorized: false },
            });

            const data = await res.json() as { errorCode: number; msg?: string; result?: unknown };

            if (data.errorCode === 0) {
                console.log(`[Omada] Client authorized via Open API: ${clientMac}`);
                return { success: true, errorCode: 0, data: data.result };
            }

            // Token expired — retry once
            if ((data.errorCode === -44112 || data.errorCode === -44113) && !this.retrying) {
                console.warn(`[Omada] Open API token expired, re-acquiring...`);
                this.retrying = true;
                this.openApiToken = '';
                this.openApiRefreshToken = '';
                const result = await this.authorizeClient(clientMac);
                this.retrying = false;
                return result;
            }

            console.error(`[Omada] Open API auth failed: errorCode=${data.errorCode}, msg=${data.msg}`);
            return { success: false, errorCode: data.errorCode, data: data.msg };
        } catch (err) {
            console.error('[Omada] Open API auth error:', err);
            return { success: false, errorCode: -1, data: String(err) };
        }
    }

    /**
     * Unauthorize a WiFi client via the Open API hotspot endpoint.
     */
    async unauthorizeClient(clientMac: string): Promise<{ success: boolean; errorCode: number }> {
        try {
            await this.ensureOpenApiToken();

            const url = `${this.host}/openapi/v1/${this.omadacId}/sites/${this.siteId}/hotspot/clients/${encodeURIComponent(clientMac)}/unauth`;
            const res = await fetch(url, {
                method: 'POST',
                headers: this.openApiHeaders(),
                // @ts-expect-error — Bun-specific TLS option
                tls: { rejectUnauthorized: false },
            });

            const data = await res.json() as { errorCode: number; msg?: string };
            if (data.errorCode === 0) {
                console.log(`[Omada] Client unauthorized via Open API: ${clientMac}`);
            } else {
                console.error(`[Omada] Open API unauth failed: errorCode=${data.errorCode}, msg=${data.msg}`);
            }
            return { success: data.errorCode === 0, errorCode: data.errorCode };
        } catch (err) {
            console.error('[Omada] Open API unauth error:', err);
            return { success: false, errorCode: -1 };
        }
    }

    // ── v2 API helpers (for getClients, getDevices, health) ─────────

    /** Generic authenticated GET request to the site-scoped Omada v2 API */
    private async siteGet(path: string): Promise<{ success: boolean; errorCode: number; data?: unknown }> {
        await this.ensureSession();

        const sep = path.includes('?') ? '&' : '?';
        const url = `${this.host}/${this.omadacId}/api/v2/sites/${this.siteId}${path}${sep}token=${encodeURIComponent(this.csrfToken)}`;
        const res = await fetch(url, {
            headers: this.authHeaders(),
            // @ts-expect-error — Bun-specific TLS option
            tls: { rejectUnauthorized: false },
        });

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
            // Session expired — re-login once
            if (!this.retrying) {
                this.retrying = true;
                this.csrfToken = '';
                this.sessionCookie = '';
                const result = await this.siteGet(path);
                this.retrying = false;
                return result;
            }
            this.retrying = false;
            return { success: false, errorCode: -1, data: 'Session expired (HTML response)' };
        }

        const data = await res.json() as { errorCode: number; result?: unknown };
        return { success: data.errorCode === 0, errorCode: data.errorCode, data: data.result };
    }

    /** Generic authenticated POST request to the site-scoped Omada API */
    private async sitePost(path: string, body: unknown = {}): Promise<{ success: boolean; errorCode: number; data?: unknown }> {
        await this.ensureSession();

        const sep = path.includes('?') ? '&' : '?';
        const url = `${this.host}/${this.omadacId}/api/v2/sites/${this.siteId}${path}${sep}token=${encodeURIComponent(this.csrfToken)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify(body),
            // @ts-expect-error — Bun-specific TLS option
            tls: { rejectUnauthorized: false },
        });

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
            if (!this.retrying) {
                this.retrying = true;
                this.csrfToken = '';
                this.sessionCookie = '';
                const result = await this.sitePost(path, body);
                this.retrying = false;
                return result;
            }
            this.retrying = false;
            return { success: false, errorCode: -1, data: 'Session expired (HTML response)' };
        }

        const data = await res.json() as { errorCode: number; result?: unknown };
        return { success: data.errorCode === 0, errorCode: data.errorCode, data: data.result };
    }

    /** Get list of connected WiFi clients */
    async getClients(): Promise<{ success: boolean; clients: unknown[] }> {
        const result = await this.siteGet('/clients?currentPage=1&currentPageSize=500&filters.active=true');
        if (!result.success) {
            console.error(`[Omada] Failed to get clients: errorCode=${result.errorCode}`);
            return { success: false, clients: [] };
        }
        const data = result.data as { data?: unknown[] } | undefined;
        return { success: true, clients: data?.data || [] };
    }

    /** Get list of managed devices (APs, switches, gateways) */
    async getDevices(): Promise<{ success: boolean; devices: unknown[] }> {
        const result = await this.siteGet('/devices?currentPage=1&currentPageSize=100');
        if (!result.success) {
            console.error(`[Omada] Failed to get devices: errorCode=${result.errorCode}`);
            return { success: false, devices: [] };
        }
        const data = result.data as { data?: unknown[] } | undefined;
        return { success: true, devices: data?.data || [] };
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
