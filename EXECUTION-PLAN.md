# Execution Plan — IPNotec Captive Portal Backend

**Stack:** Hono (Bun) · Drizzle ORM · bun:sqlite · MSG91 · Omada Controller API v2  
**Date:** March 25, 2026

---

## Project Structure (Final)

```
backend/
├── src/
│   ├── index.ts                  # Hono app entry — mounts routes, serves static
│   ├── routes/
│   │   ├── portal.ts             # /portal/* — user-facing captive portal flow
│   │   └── admin.ts              # /admin/* — admin dashboard API
│   ├── services/
│   │   ├── msg91.ts              # MSG91 OTP send/verify via HTTP
│   │   └── omada.ts              # Omada Controller API v2 client
│   ├── middleware/
│   │   └── auth.ts               # JWT sign/verify helpers + Hono middleware
│   └── db/
│       ├── schema.ts             # Drizzle table definitions
│       └── index.ts              # DB connection singleton
├── static/
│   └── index.html                # Captive portal UI (existing file)
├── data/                         # SQLite DB file lives here (gitignored)
├── drizzle/                      # Generated migrations (auto)
├── drizzle.config.ts             # Drizzle Kit config
├── package.json
├── tsconfig.json
├── .env                          # Secrets (gitignored)
├── .env.example                  # Template for .env
├── .gitignore
└── EXECUTION-PLAN.md             # This file
```

---

## Phase 1 — Project Scaffold & Database

### Step 1.1: Initialize Bun Project

```bash
cd /home/azureuser/backend
bun init -y
```

**Install dependencies:**
```bash
bun add hono drizzle-orm
bun add -d drizzle-kit @types/bun
```

**package.json scripts:**
```json
{
  "scripts": {
    "dev": "bun run --hot src/index.ts",
    "start": "bun run src/index.ts",
    "db:push": "bunx drizzle-kit push",
    "db:generate": "bunx drizzle-kit generate",
    "db:migrate": "bunx drizzle-kit migrate"
  }
}
```

### Step 1.2: Environment Variables

**`.env`** (all values from PRD §11):
```env
# Server
PORT=3000
NODE_ENV=development

# JWT
JWT_SECRET=<random-64-char-secret>
JWT_OTP_EXPIRY_SECONDS=300
JWT_AUTH_EXPIRY_SECONDS=600

# Database
DB_FILE_NAME=./data/portal.db

# MSG91
MSG91_AUTH_KEY=
MSG91_TEMPLATE_ID=
MSG91_SENDER_ID=IPNOTC

# Omada Controller (self-hosted v2 API)
OMADA_URL=https://4.240.95.225:8043
OMADA_USER=admin
OMADA_PASS=<omada-password>

# Admin
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<admin-password>
ADMIN_JWT_SECRET=<separate-64-char-secret>
```

**`.env.example`** — same file with empty values, committed to git.

**`.gitignore`:**
```
node_modules/
data/
.env
*.db
drizzle/
```

### Step 1.3: Drizzle Schema

**File: `src/db/schema.ts`**

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id:         text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name:       text('name').notNull(),
  email:      text('email').notNull(),
  phone:      text('phone').notNull().unique(),
  createdAt:  integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});

export const sessions = sqliteTable('sessions', {
  id:          text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId:      text('user_id').notNull().references(() => users.id),
  macAddress:  text('mac_address').notNull(),
  apMac:       text('ap_mac'),
  ssid:        text('ssid'),
  redirectUrl: text('redirect_url'),
  loginAt:     integer('login_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  expiresAt:   integer('expires_at', { mode: 'timestamp' }).notNull(),
  status:      text('status', { enum: ['active', 'expired', 'revoked'] }).notNull().default('active'),
});

export const otpRequests = sqliteTable('otp_requests', {
  id:        text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  phone:     text('phone').notNull(),
  otpHash:   text('otp_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  verified:  integer('verified').notNull().default(0),
});
```

### Step 1.4: DB Connection

**File: `src/db/index.ts`**

```ts
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './schema';

const sqlite = new Database(process.env.DB_FILE_NAME || './data/portal.db');
sqlite.exec('PRAGMA journal_mode = WAL;');  // better concurrent read perf

export const db = drizzle({ client: sqlite, schema });
```

### Step 1.5: Drizzle Config

**File: `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DB_FILE_NAME || './data/portal.db',
  },
});
```

**Verify:** `mkdir -p data && bun run db:push` — creates tables in SQLite.

---

## Phase 2 — Core Services

### Step 2.1: OTP Utilities (inside `src/middleware/auth.ts` or standalone)

```ts
// Generate 6-digit OTP
function generateOTP(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, '0');
}

// Hash OTP with SHA-256
async function hashOTP(otp: string): Promise<string> {
  const data = new TextEncoder().encode(otp);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
```

### Step 2.2: MSG91 Service

**File: `src/services/msg91.ts`**

MSG91 OTP API:
```
POST https://api.msg91.com/api/v5/otp
Headers: { "authkey": "<MSG91_AUTH_KEY>" }
Body: {
  "template_id": "<MSG91_TEMPLATE_ID>",
  "mobile": "91XXXXXXXXXX",
  "otp": "483920"
}
```

**Implementation:**
```ts
export async function sendOTP(phone: string, otp: string): Promise<boolean> {
  const res = await fetch('https://api.msg91.com/api/v5/otp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'authkey': process.env.MSG91_AUTH_KEY!,
    },
    body: JSON.stringify({
      template_id: process.env.MSG91_TEMPLATE_ID!,
      mobile: phone,   // format: "91XXXXXXXXXX"
      otp,
    }),
  });
  const data = await res.json();
  return data.type === 'success';
}
```

### Step 2.3: Omada Controller API v2 Service

**File: `src/services/omada.ts`**

The Omada Controller (self-hosted on the VPS) uses a **3-step authentication flow** and a specific
endpoint for external portal client authorization.

#### Omada Auth Flow (researched via Context7 — omada-api-toolkit)

```
Step 1: GET  https://{host}/api/info
        → returns { result: { omadacId: "..." } }  (controller ID)

Step 2: POST https://{host}/{omadacId}/api/v2/login
        Body: { "username": "admin", "password": "..." }
        → returns { result: { token: "csrf-token" } }
        → sets cookie: TPOMADA_SESSIONID=...

Step 3: Use token in BOTH places for every subsequent request:
        Header:  Csrf-Token: {token}
        URL param: ?token={token}
        Cookie:  TPOMADA_SESSIONID=...
```

#### External Portal Auth Endpoint

When Omada is configured with an **External Portal Server**, it redirects unauthenticated
WiFi clients to:
```
https://{portal-backend}/portal?clientMac={mac}&apMac={apMac}&ssid={ssid}&radioId={radioId}&redirectUrl={url}&t={timestamp}
```

After our backend verifies the user (OTP flow), we authorize the client by calling:
```
POST https://{host}/{omadacId}/api/v2/hotspot/extPortal/auth
Headers: {
  "Csrf-Token": "{token}",
  "Content-Type": "application/json",
  "Cookie": "TPOMADA_SESSIONID={sessionId}"
}
URL params: ?token={token}
Body: {
  "clientMac": "AA-BB-CC-DD-EE-FF",
  "apMac": "11-22-33-44-55-66",
  "ssid": "ipnotec",
  "radioId": 0,
  "time": 1440,              // session duration in minutes (1440 = 24 hours)
  "authType": 4              // external portal auth type
}
```

> **CRITICAL PITFALL (from omada-api-toolkit):** The CSRF token must be sent in **both**
> the `Csrf-Token` header AND as a `?token=` URL parameter. Missing either will cause
> a silent redirect to the login page (returns HTML instead of JSON).

#### Implementation Outline

```ts
class OmadaClient {
  private host: string;
  private omadacId: string = '';
  private csrfToken: string = '';
  private sessionCookie: string = '';

  constructor() {
    this.host = process.env.OMADA_URL!;
  }

  // Step 1: Get controller ID
  async init() {
    const res = await fetch(`${this.host}/api/info`, { tls: { rejectUnauthorized: false } });
    const data = await res.json();
    this.omadacId = data.result.omadacId;
  }

  // Step 2: Login
  async login() {
    if (!this.omadacId) await this.init();
    const res = await fetch(`${this.host}/${this.omadacId}/api/v2/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: process.env.OMADA_USER!,
        password: process.env.OMADA_PASS!,
      }),
      tls: { rejectUnauthorized: false },
    });
    const setCookie = res.headers.get('set-cookie') || '';
    this.sessionCookie = setCookie.split(';')[0];  // TPOMADA_SESSIONID=xxx
    const data = await res.json();
    this.csrfToken = data.result.token;
  }

  // Step 3: Authorize a WiFi client
  async authorizeClient(clientMac: string, apMac: string, ssid: string, minutes = 1440) {
    if (!this.csrfToken) await this.login();
    const url = `${this.host}/${this.omadacId}/api/v2/hotspot/extPortal/auth?token=${this.csrfToken}`;
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
        radioId: 0,
        time: minutes,
        authType: 4,
      }),
      tls: { rejectUnauthorized: false },
    });
    const data = await res.json();
    if (data.errorCode !== 0) {
      // Token expired — re-login and retry once
      await this.login();
      return this.authorizeClient(clientMac, apMac, ssid, minutes);
    }
    return data;
  }
}

export const omada = new OmadaClient();
```

> **Note on self-signed certs:** Bun's `fetch()` accepts `tls: { rejectUnauthorized: false }`
> to skip SSL verification for the self-signed cert on the Omada Controller.

---

## Phase 3 — JWT Auth Middleware

### Step 3.1: JWT Helpers & Middleware

**File: `src/middleware/auth.ts`**

Hono has JWT built-in — no extra package needed.

```ts
import { sign, verify } from 'hono/jwt';
import { jwt } from 'hono/jwt';
import type { JwtVariables } from 'hono/jwt';

// ----- Sign tokens -----

export async function signOtpToken(payload: {
  phone: string;
  clientMac: string;
  apMac: string;
  ssid: string;
  redirectUrl: string;
}): Promise<string> {
  return sign(
    { ...payload, exp: Math.floor(Date.now() / 1000) + Number(process.env.JWT_OTP_EXPIRY_SECONDS || 300) },
    process.env.JWT_SECRET!
  );
}

export async function signAuthToken(payload: {
  userId: string;
  phone: string;
  clientMac: string;
  apMac: string;
  ssid: string;
  redirectUrl: string;
}): Promise<string> {
  return sign(
    { ...payload, exp: Math.floor(Date.now() / 1000) + Number(process.env.JWT_AUTH_EXPIRY_SECONDS || 600) },
    process.env.JWT_SECRET!
  );
}

export async function signAdminToken(): Promise<string> {
  return sign(
    { role: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 },  // 24h
    process.env.ADMIN_JWT_SECRET!
  );
}

// ----- Middleware factories -----

// Protects routes requiring auth token (after OTP verified)
export const authMiddleware = (c, next) => {
  const mw = jwt({ secret: c.env?.JWT_SECRET || process.env.JWT_SECRET!, alg: 'HS256' });
  return mw(c, next);
};

// Protects admin routes
export const adminMiddleware = (c, next) => {
  const mw = jwt({ secret: c.env?.ADMIN_JWT_SECRET || process.env.ADMIN_JWT_SECRET!, alg: 'HS256' });
  return mw(c, next);
};
```

**JWT payload shapes:**

| Token | Fields | Expiry |
|---|---|---|
| `otpToken` | phone, clientMac, apMac, ssid, redirectUrl | 5 min |
| `authToken` | userId, phone, clientMac, apMac, ssid, redirectUrl | 10 min |
| `adminToken` | role: "admin" | 24 hr |

---

## Phase 4 — Portal Routes (User Flow)

### Step 4.1: GET /portal

**File: `src/routes/portal.ts`**

Entry point. Omada redirects unauthenticated WiFi clients here with query params.

```
GET /portal?clientMac=AA-BB-CC-DD-EE-FF&apMac=11-22-33-44-55-66&ssid=ipnotec&radioId=0&redirectUrl=http://google.com&t=1711360000
```

**Logic:**
1. Read query params: `clientMac`, `apMac`, `ssid`, `radioId`, `redirectUrl`
2. Read `static/index.html` file
3. Inject Omada params as a `<script>` block into the HTML before serving:
   ```js
   window.__PORTAL__ = { clientMac, apMac, ssid, radioId, redirectUrl };
   ```
4. Return HTML with `c.html()`

### Step 4.2: POST /portal/send-otp

**Request body:**
```json
{
  "name": "Raj Sharma",
  "email": "raj@example.com",
  "phone": "919876543210",
  "clientMac": "AA-BB-CC-DD-EE-FF",
  "apMac": "11-22-33-44-55-66",
  "ssid": "ipnotec",
  "redirectUrl": "http://google.com"
}
```

**Logic:**
1. **Validate** — name (1-100 chars), email (valid format), phone (10-12 digits), clientMac (present)
2. **Rate limit** — query `otp_requests` for this phone where `created_at > now - 60s` and `verified = 0`. If found → return `429 Too Many Requests`
3. **Upsert user** — find by phone; if exists update name/email, else insert new
4. **Generate OTP** — 6-digit via `crypto.getRandomValues`
5. **Hash & store** — SHA-256 hash → insert into `otp_requests` with `expires_at = now + 5 min`
6. **Send SMS** — call `msg91.sendOTP(phone, otp)`
7. **Sign JWT** — create `otpToken` with phone + clientMac + apMac + ssid + redirectUrl
8. **Return** `{ success: true, message: "OTP sent", otpToken }`

### Step 4.3: POST /portal/verify-otp

**Request body:**
```json
{
  "otp": "483920",
  "otpToken": "<jwt>"
}
```

**Logic:**
1. **Decode JWT** → extract phone, clientMac, apMac, ssid, redirectUrl
2. **Lookup OTP** — latest `otp_requests` row for phone where `verified = 0` and `expires_at > now`
3. **Compare hash** — `hashOTP(submittedOTP) === storedHash`
4. **If invalid** → `400 { success: false, message: "Invalid or expired OTP" }`
5. **If valid** → mark `verified = 1`, lookup user by phone to get `userId`
6. **Sign authToken** — JWT with userId + phone + clientMac + apMac + ssid + redirectUrl
7. **Return** `{ success: true, authToken }`

### Step 4.4: POST /portal/accept

**Headers:** `Authorization: Bearer <authToken>`

**Logic:**
1. **JWT middleware** verifies `authToken` → extract userId, clientMac, apMac, ssid, redirectUrl
2. **Call Omada** → `omada.authorizeClient(clientMac, apMac, ssid, 1440)` — 24hr session
3. **Create session** → insert into `sessions` table:
   - `userId`, `macAddress`, `apMac`, `ssid`, `redirectUrl`
   - `expiresAt = now + 24 hours`
   - `status = 'active'`
4. **Return** `{ success: true, redirectUrl }` (frontend handles the redirect)

---

## Phase 5 — Admin Routes

### Step 5.1: POST /admin/login

**Request body:**
```json
{
  "username": "admin",
  "password": "<from-env>"
}
```

**Logic:**
1. Compare with `process.env.ADMIN_USERNAME` and `process.env.ADMIN_PASSWORD`
2. If match → return `{ success: true, token: signAdminToken() }`
3. Else → `401 Unauthorized`

### Step 5.2: GET /admin/sessions/today

**Headers:** `Authorization: Bearer <adminToken>`

**Logic:**
1. Query `sessions` joined with `users` where `login_at >= today midnight`
2. Count total
3. Return:
```json
{
  "date": "2026-03-25",
  "count": 47,
  "sessions": [
    {
      "id": "uuid",
      "name": "Raj Sharma",
      "email": "raj@example.com",
      "phone": "919876...",
      "macAddress": "AA:BB:CC:DD:EE:FF",
      "loginAt": "2026-03-25T09:14:00Z",
      "expiresAt": "2026-03-26T09:14:00Z",
      "status": "active"
    }
  ]
}
```

### Step 5.3: GET /admin/sessions/stats

**Logic:**
- Count sessions per day for the last 7 days
- Count sessions per week for the last 4 weeks
- Return aggregated data

### Step 5.4: DELETE /admin/sessions/:id

**Logic:**
1. Find session by ID
2. Update `status = 'revoked'`
3. Return `{ success: true }`

---

## Phase 6 — App Entry & Static Files

### Step 6.1: Main Entry Point

**File: `src/index.ts`**

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import portal from './routes/portal';
import admin from './routes/admin';

const app = new Hono();

// CORS for dev
app.use('/*', cors());

// Static files
app.use('/static/*', serveStatic({ root: './' }));

// Routes
app.route('/portal', portal);
app.route('/admin', admin);

// Health check
app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
};
```

### Step 6.2: Move HTML

```bash
mkdir -p static
mv index.html static/index.html
```

---

## Phase 7 — Verification & Testing

### Manual Test Sequence

```bash
# 1. Start server
bun run dev

# 2. Health check
curl http://localhost:3000/health

# 3. Portal entry (simulates Omada redirect)
curl "http://localhost:3000/portal?clientMac=AA-BB-CC-DD-EE-FF&apMac=11-22-33-44-55-66&ssid=ipnotec&redirectUrl=http://google.com"

# 4. Send OTP
curl -X POST http://localhost:3000/portal/send-otp \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@test.com","phone":"919876543210","clientMac":"AA-BB-CC-DD-EE-FF","apMac":"11-22-33-44-55-66","ssid":"ipnotec","redirectUrl":"http://google.com"}'

# 5. Verify OTP (use OTP from MSG91 SMS or DB)
curl -X POST http://localhost:3000/portal/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"otp":"123456","otpToken":"<token-from-step-4>"}'

# 6. Accept terms & connect
curl -X POST http://localhost:3000/portal/accept \
  -H "Authorization: Bearer <authToken-from-step-5>"

# 7. Admin login
curl -X POST http://localhost:3000/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<admin-password>"}'

# 8. View today's sessions
curl http://localhost:3000/admin/sessions/today \
  -H "Authorization: Bearer <admin-token>"
```

### Checks

| # | Check | Expected |
|---|---|---|
| 1 | `bun run dev` starts | Server on :3000, no errors |
| 2 | GET `/health` | `{ "status": "ok" }` |
| 3 | GET `/portal?clientMac=...` | HTML with injected `__PORTAL__` params |
| 4 | POST `/portal/send-otp` | `{ success: true, otpToken: "..." }` |
| 5 | POST `/portal/send-otp` again within 60s | `429 Too Many Requests` |
| 6 | POST `/portal/verify-otp` with wrong OTP | `400 Invalid OTP` |
| 7 | POST `/portal/verify-otp` with correct OTP | `{ success: true, authToken: "..." }` |
| 8 | POST `/portal/accept` | `{ success: true, redirectUrl: "..." }` |
| 9 | GET `/admin/sessions/today` | Sessions array with count |
| 10 | DELETE `/admin/sessions/:id` | `{ success: true }` |
| 11 | SQLite DB `data/portal.db` | Contains `users`, `sessions`, `otp_requests` tables |

---

## Omada Controller Setup (Pre-Requisites)

Before the backend can authorize clients, the Omada Controller must be configured:

1. **Portal Authentication → External Portal Server**
   - Go to: Controller UI → Settings → Authentication → Portal
   - Create new portal, select the SSID (`ipnotec`)
   - Auth type: **External Portal Server**
   - External portal URL: `http://<VPS-IP>:3000/portal`
   - Landing page: Redirect to original URL

2. **Pre-Authentication Access**
   - Allow traffic to the backend server IP on port 3000 (so the captive portal page loads)
   - Allow traffic to `api.msg91.com` (so SMS can be sent if needed)

3. **Note the Omada redirect URL format:**
   ```
   http://<VPS-IP>:3000/portal?clientMac={clientMac}&apMac={apMac}&ssid={ssid}&radioId={radioId}&redirectUrl={redirectUrl}&t={timestamp}
   ```
   The backend captures these params and carries them through the OTP flow via JWT.

---

## Execution Order (Dependencies)

```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4 ──→ Phase 6 ──→ Phase 7
(scaffold)  (services)  (auth)      (routes)    (wire up)    (test)
                                       ↑
Phase 1 ─────────────────────────→ Phase 5
                                   (admin)
```

| Phase | Depends On | Can Parallel With |
|---|---|---|
| 1 (Scaffold) | Nothing | — |
| 2 (Services) | Phase 1 | — |
| 3 (Auth) | Phase 1 | Phase 2 |
| 4 (Portal Routes) | Phase 2 + 3 | Phase 5 |
| 5 (Admin Routes) | Phase 3 | Phase 4 |
| 6 (App Entry) | Phase 4 + 5 | — |
| 7 (Testing) | Phase 6 | — |

---

## Key Decisions

| Decision | Choice | Reason |
|---|---|---|
| Runtime | Bun | Native sqlite, fast, built-in TS |
| Database | bun:sqlite (file) | Single VPS, no separate DB service |
| ORM | Drizzle | Type-safe, lightweight, Bun adapter |
| JWT | hono/jwt (built-in) | No extra package needed |
| OTP Hash | SHA-256 via crypto.subtle | PRD security requirement |
| Omada API | Self-hosted v2 (not cloud Open API) | Controller runs on same VPS |
| Self-signed cert | `tls: { rejectUnauthorized: false }` | Omada uses self-signed HTTPS |
| Daily user limit | Track count, never block | Per user request |
| CSRF token | Send in BOTH header + URL param | Omada API v2 requirement (pitfall) |
| Session duration | 1440 minutes (24 hours) | PRD spec |
| Static HTML | Served from `static/` via Hono | Single page, params injected |
