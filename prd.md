# PRD — Coworking Space WiFi Captive Portal Backend

**Project:** IPNotec Cowork WiFi Auth System  
**Stack:** Hono (Node.js/Bun), MSG91 (SMS OTP), Omada Controller API  
**Version:** 1.0  
**Date:** March 2026

---

## 1. Overview

A captive portal backend that intercepts WiFi users at the coworking space, collects their identity (name, email, phone), verifies them via SMS OTP, shows a welcome/terms page, and then grants internet access via the Omada Controller API. Built to be stable and scalable with no artificial user limits.

---

## 2. Goals

- Capture verified user identity before granting WiFi access
- Authenticate users via SMS OTP using MSG91
- Grant/revoke WiFi access programmatically via Omada API
- Store user session data for reporting and compliance
- Provide a simple admin view of logins

---

## 3. Non-Goals (v1.0)

- Payment or subscription management
- Multi-site support
- Mobile app
- User self-service portal

---

## 4. User Flow

```
User connects to "ipnotec" WiFi
        ↓
Opens any browser → Omada intercepts → Redirects to Portal Backend
        ↓
[Step 1] Registration Page
  → User enters: Name, Email, Phone Number
  → Clicks "Send OTP"
        ↓
[Step 2] Backend checks daily limit
  → If 100 users already logged in today → Show "Capacity Full" page
  → Otherwise → Send OTP via MSG91
        ↓
[Step 3] OTP Verification Page
  → User enters 6-digit OTP
  → Clicks "Verify"
        ↓
[Step 4] Welcome / Terms Page
  → Shows coworking name, T&C, usage policy
  → User clicks "Accept & Connect"
        ↓
[Step 5] Backend calls Omada API → Grants internet access
        ↓
User is online ✓
```

---

## 5. System Architecture

```
[EAP245 Access Point]
        ↓ (redirects unauthenticated clients)
[Omada Controller on VPS :8043]
        ↓ (external portal redirect)
[Hono Backend on VPS :3000]
        ↓              ↓
  [MSG91 API]     [SQLite / PostgreSQL DB]
        ↓
[Omada API] ← grants access after OTP verified
```

---

## 6. Tech Stack

| Layer | Technology |
|---|---|
| Backend Framework | Hono (Bun runtime recommended) |
| SMS OTP | MSG91 |
| Database | SQLite (dev) / PostgreSQL (prod) |
| ORM | Drizzle ORM |
| Auth tokens | JWT (Hono built-in middleware) |
| Environment config | `.env` via Hono c.env |
| Deployment | Same Azure VPS as Omada Controller |

---

## 7. Database Schema

### `users` table
| Column | Type | Notes |
|---|---|---|
| id | UUID | Primary key |
| name | VARCHAR(100) | Required |
| email | VARCHAR(150) | Required |
| phone | VARCHAR(20) | Required, used for OTP |
| created_at | TIMESTAMP | First registration |

### `sessions` table
| Column | Type | Notes |
|---|---|---|
| id | UUID | Primary key |
| user_id | UUID | FK → users |
| mac_address | VARCHAR(20) | Client MAC from Omada redirect |
| login_at | TIMESTAMP | When access was granted |
| expires_at | TIMESTAMP | Session expiry |
| status | ENUM | `active`, `expired`, `revoked` |

### `otp_requests` table
| Column | Type | Notes |
|---|---|---|
| id | UUID | Primary key |
| phone | VARCHAR(20) | |
| otp_code | VARCHAR(6) | Hashed before storing |
| created_at | TIMESTAMP | |
| expires_at | TIMESTAMP | OTP valid for 5 minutes |
| verified | BOOLEAN | Default false |

---

## 8. API Endpoints

### Public Routes (no auth required)

#### `GET /portal`
Entry point. Omada redirects users here with query params.

**Query params from Omada:**
- `clientMac` — MAC address of connecting device
- `apMac` — AP MAC address
- `ssid` — Network name
- `redirectUrl` — Where to send user after auth

**Response:** Renders registration HTML page

---

#### `POST /portal/send-otp`
Sends OTP to user's phone via MSG91.

**Request body:**
```json
{
  "name": "Raj Sharma",
  "email": "raj@example.com",
  "phone": "919876543210",
  "clientMac": "AA:BB:CC:DD:EE:FF"
}
```

**Logic:**
1. Validate all fields
2. Check if OTP already sent in last 60 seconds (prevent spam)
3. Create/update user record
4. Generate 6-digit OTP, store hashed in `otp_requests`
5. Call MSG91 API to send SMS
6. Return session token (short-lived JWT with phone + clientMac)

**Response:**
```json
{
  "success": true,
  "message": "OTP sent to your phone",
  "otpToken": "<short_lived_jwt>"
}
```

---

#### `POST /portal/verify-otp`
Verifies OTP entered by user.

**Request body:**
```json
{
  "otp": "483920",
  "otpToken": "<jwt_from_previous_step>"
}
```

**Logic:**
1. Decode JWT → extract phone + clientMac
2. Look up latest OTP for that phone
3. Check OTP is not expired (5 min window)
4. Compare hashed OTP
5. If valid → mark as verified, generate `authToken` JWT
6. Return authToken

**Response:**
```json
{
  "success": true,
  "authToken": "<jwt_for_welcome_page>"
}
```

---

#### `GET /portal/welcome`
Welcome and Terms page shown after OTP verified.

**Headers:** `Authorization: Bearer <authToken>`

**Response:** Renders welcome/T&C HTML page with "Accept & Connect" button

---

#### `POST /portal/accept`
Final step — user accepts T&C, backend grants WiFi access.

**Headers:** `Authorization: Bearer <authToken>`

**Logic:**
1. Validate authToken JWT
2. Extract clientMac from token
3. Call Omada Controller API to authorize the client MAC
4. Create session record in DB
5. Redirect user to `redirectUrl` (original destination)

**Response:** `302 Redirect` to original URL

---

### Admin Routes (JWT protected)

#### `GET /admin/sessions/today`
Returns list of all sessions created today.

**Response:**
```json
{
  "date": "2026-03-25",
  "count": 47,
  "limit": 100,
  "sessions": [
    {
      "name": "Raj Sharma",
      "email": "raj@example.com",
      "phone": "919876...",
      "login_at": "2026-03-25T09:14:00Z",
      "status": "active"
    }
  ]
}
```

#### `GET /admin/sessions/stats`
Weekly/monthly login stats.

#### `DELETE /admin/sessions/:id`
Revoke a specific session (kicks user off WiFi).

---

## 9. Omada API Integration

The backend needs to call the Omada Controller API to authorize a client MAC address after successful OTP verification.

**Required Omada API calls:**

1. **Login to Omada API** — get access token
   - `POST https://<vps-ip>:8043/<omadacId>/api/v2/hotspot/login`

2. **Authorize client** — grant WiFi access to MAC
   - `POST https://<vps-ip>:8043/<omadacId>/api/v2/hotspot/extPortal/auth`
   - Body includes: `clientMac`, `apMac`, `ssid`, `radioId`, `time` (session duration in minutes)

**Note:** Omada's external portal API expects the backend to respond within the session, so the `clientMac` and `redirectUrl` passed in the original redirect must be preserved through all steps.

---

## 10. MSG91 Integration

MSG91 is used to send the OTP SMS.

**Required config (`.env`):**
```
MSG91_AUTH_KEY=your_msg91_auth_key
MSG91_TEMPLATE_ID=your_otp_template_id
MSG91_SENDER_ID=IPNOTC
```

**API call:** MSG91 Send OTP endpoint  
`POST https://api.msg91.com/api/v5/otp`

**Body:**
```json
{
  "template_id": "<template_id>",
  "mobile": "91XXXXXXXXXX",
  "authkey": "<auth_key>",
  "otp": "483920"
}
```

---

## 11. Environment Variables

```env
# Server
PORT=3000
NODE_ENV=production

# JWT
JWT_SECRET=your_jwt_secret_here
JWT_OTP_EXPIRY=5m
JWT_AUTH_EXPIRY=10m

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/cowork_wifi

# MSG91
MSG91_AUTH_KEY=
MSG91_TEMPLATE_ID=
MSG91_SENDER_ID=IPNOTC

# Omada Controller
OMADA_HOST=https://4.240.95.225:8043
OMADA_ID=c21f969b5f03d33d43e04f8f136e7682
OMADA_USERNAME=admin
OMADA_PASSWORD=your_omada_password

# Admin
ADMIN_JWT_SECRET=separate_admin_secret
```

---

## 12. Hono Project Structure

```
cowork-portal/
├── src/
│   ├── index.ts              # App entry point
│   ├── routes/
│   │   ├── portal.ts         # /portal/* routes
│   │   └── admin.ts          # /admin/* routes
│   ├── services/
│   │   ├── otp.ts            # MSG91 OTP logic
│   │   ├── omada.ts          # Omada API client
│   │   └── session.ts        # Session management
│   ├── middleware/
│   │   ├── auth.ts           # JWT middleware
│   │   └── rateLimit.ts      # OTP spam protection
│   ├── db/
│   │   ├── schema.ts         # Drizzle schema
│   │   └── index.ts          # DB connection
│   ├── views/
│   │   ├── register.html     # Step 1 — registration form
│   │   ├── verify.html       # Step 2 — OTP entry
│   │   └── welcome.html      # Step 3 — T&C page
│   └── utils/
├── .env
├── package.json
└── README.md
```

---

## 13. Security Considerations

- OTPs are hashed (SHA-256) before storing in DB — never stored in plain text
- OTP tokens (JWT) expire in 5 minutes
- Auth tokens expire in 10 minutes — enough to complete the flow
- Rate limit: max 3 OTP requests per phone per hour
- Client MAC comes from Omada redirect params, not from user input
- Admin routes require separate long-lived JWT
- All Omada API calls use HTTPS (self-signed cert, skip verify in dev)
- `.env` never committed to version control

---

## 14. Out of Scope for v1.0

- Email OTP fallback
- WhatsApp OTP (can be added via MSG91 later)
- Bandwidth throttling per user (handled by Omada portal settings)
- Booking system integration (separate project)
- Multi-language support

---

## 15. Success Criteria

- User can connect, register, verify OTP, and get internet in under 2 minutes
- All user data is stored and accessible from admin route
- Zero manual intervention needed for normal daily operation
- System survives controller/VPS restart without losing active sessions