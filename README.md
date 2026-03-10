# ScholarMark — Full-Stack Academic Review Platform

A production-grade web application that accepts academic documents, processes payment in the user's local currency, and delivers a structured AI-powered review report.

---

## Quick Answer to Your Questions

**Do you need a database?**
Yes — and this app uses one. SQLite stores every submission, transaction, and completed review. This means:
- You have a permanent record of every payment
- You can look up any review by its secure token
- You can't accidentally charge someone twice
- You have an audit trail if Paystack disputes arise

SQLite is a file-based database — zero cost, zero setup, works perfectly for thousands of daily submissions. If you grow to millions of users, migrating to PostgreSQL takes one afternoon.

**Was it one file before?**
Yes — the previous version was a single HTML file. That means your Anthropic API key was visible in the browser source, payments were only verified client-side (easily spoofed), and there was no record of transactions. This version is a proper full-stack application.

**Is it secure now?**
Yes. See the Security section below.

---

## Project Structure

```
scholarmark/
│
├── backend/
│   ├── server.js        ← Express server, all routes, rate limiting
│   ├── database.js      ← SQLite schema + helper functions
│   └── pricing.js       ← Location-based currency detection + pricing
│
├── frontend/
│   ├── index.html       ← HTML structure (no logic here)
│   ├── css/
│   │   └── styles.css   ← All styles (Oxford blue design)
│   └── js/
│       └── app.js       ← All frontend logic (talks only to /api/*)
│
├── data/
│   └── scholarmark.db   ← SQLite database (auto-created on first run)
│
├── .env.example         ← Copy this to .env and fill in your keys
├── .gitignore
├── package.json
└── README.md
```

---

## Pricing

Base prices are set in GBP. All other currencies are converted in real time.

| Level   | Name                       | GBP   | USD (approx) |
|---------|----------------------------|-------|--------------|
| Level 7 | Master's Review            | £7    | ~$10         |
| Level 8 | Doctoral Review            | £12   | ~$15         |
| Level 9 | Post-Doctoral Review       | £18   | ~$23         |
| Level 10| Expert / Professorial      | £25   | ~$32         |

To change prices, edit `BASE_PRICES_GBP` in `backend/pricing.js`.

---

## Security Architecture

### What was wrong before (single-file HTML)
- ❌ Anthropic API key was in the HTML — visible to anyone who views source
- ❌ Paystack secret key was in the HTML
- ❌ Payment was only verified by the browser saying "success"
- ❌ Anyone could forge a payment callback and get a free review
- ❌ No record of transactions — no way to resolve disputes

### What this version does
- ✅ **API keys never leave the server** — Anthropic and Paystack secret keys are in `.env`, never sent to the browser
- ✅ **Paystack public key served from `/api/pubkey`** — even the public key isn't hardcoded in HTML
- ✅ **Server-side payment verification** — after Paystack popup reports success, our server calls `api.paystack.co/transaction/verify/:ref` independently, using the secret key
- ✅ **Amount verification** — we check that the amount Paystack reports matches what we expect (prevents price manipulation)
- ✅ **Webhook verification** — Paystack webhooks are verified with HMAC-SHA512 signature using your secret key
- ✅ **Rate limiting** — submissions: 5/hour, payments: 10/hour, general: 100/15min
- ✅ **Helmet.js** — sets secure HTTP headers (XSS protection, CSP, etc.)
- ✅ **CORS** — only your own frontend origin is allowed
- ✅ **Files never touch disk** — uploaded documents are held in memory only
- ✅ **Files deleted after review** — cleared from memory as soon as the report is generated
- ✅ **SQLite records** — every transaction stored; prevents double-charging
- ✅ **Secure review tokens** — 48-byte random hex token; reviews accessible only via token

---

## Setup Instructions

### 1. Prerequisites
- Node.js v18 or higher
- A Paystack account (free at paystack.com)
- An Anthropic API account (console.anthropic.com)

### 2. Install dependencies
```bash
cd scholarmark
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
```

Open `.env` and fill in:
```
ANTHROPIC_API_KEY=sk-ant-...        ← from console.anthropic.com
PAYSTACK_SECRET_KEY=sk_live_...     ← from dashboard.paystack.com
PAYSTACK_PUBLIC_KEY=pk_live_...     ← from dashboard.paystack.com
SESSION_SECRET=<64+ random chars>   ← generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 4. Run the server
```bash
# Development (with auto-restart on file changes)
npm run dev

# Production
npm start
```

The app will be available at: **http://localhost:3000**

### 5. Set up Paystack webhook (for production)
In your Paystack dashboard:
- Go to Settings → API Keys & Webhooks
- Set webhook URL to: `https://yourdomain.com/api/webhook/paystack`
- This is a backup: if a customer's browser closes before verification completes, the webhook catches it

---

## Database Schema

Three tables:

**submissions** — one row per upload attempt
```
id, name, email, level, currency, amount, file_count, file_names,
country_code, ip_address, status (pending→paid→reviewed)
```

**transactions** — payment records
```
id, submission_id, paystack_ref, amount, currency,
status (pending→success→failed), paystack_data (full JSON), verified_at
```

**reviews** — completed AI review results
```
id, submission_id, transaction_id, result_json, token, created_at
```

The database file is created automatically at `./data/scholarmark.db` on first run.

---

## How Location-Based Pricing Works

1. When a user loads the page, the frontend calls `POST /api/location`
2. The server looks up the user's IP address using `geoip-lite` (offline database — no external API call needed)
3. The country code maps to a currency (e.g. KE → KES, GB → GBP, US → USD)
4. The server converts the base GBP prices to the user's currency using live exchange rates (with a 1-hour cache)
5. Prices are returned to the frontend and displayed
6. **The server always recalculates the price at checkout** — the client price is never trusted

Supported currencies: GBP, USD, EUR, CAD, AUD, KES, UGX, TZS, NGN, GHS, ZAR, EGP, INR, AED, and more.

---

## API Endpoints

| Method | Endpoint                  | Description                                    |
|--------|---------------------------|------------------------------------------------|
| GET    | `/api/pubkey`             | Returns Paystack public key                    |
| POST   | `/api/location`           | Detect currency + return pricing               |
| POST   | `/api/submission`         | Upload files + create submission               |
| POST   | `/api/payment/init`       | Initialize Paystack transaction (server-side)  |
| POST   | `/api/payment/verify`     | Verify payment + trigger review                |
| POST   | `/api/webhook/paystack`   | Paystack webhook (HMAC verified)               |
| GET    | `/api/review/:token`      | Retrieve completed review by secure token      |

---

## Deployment (Production)

### Option A: VPS / Ubuntu server
```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone / upload your project
# cd into scholarmark/
npm install --production

# Use PM2 to keep it running
npm install -g pm2
pm2 start backend/server.js --name scholarmark
pm2 save
pm2 startup

# Use Nginx as a reverse proxy (recommended)
# Point Nginx to localhost:3000
# Add your SSL certificate (Let's Encrypt is free)
```

### Option B: Railway / Render / Fly.io (easier)
- Push to GitHub
- Connect to Railway or Render
- Set environment variables in their dashboard
- Deploy — done

**Important for production:**
- Set `NODE_ENV=production` in your env
- Set `FRONTEND_URL=https://yourdomain.com`
- Use HTTPS (SSL) — Paystack requires it for live keys

---

## Customisation

**Change prices:** Edit `BASE_PRICES_GBP` in `backend/pricing.js`

**Add a currency:** Add it to `COUNTRY_CURRENCY` and `CURRENCY_CONFIG` in `backend/pricing.js`

**Change colours:** Edit CSS variables at the top of `frontend/css/styles.css`

**Change review criteria:** Edit `levelCriteria` in `backend/server.js` → `triggerReview()`

---

## Support

If a payment goes through but the review fails, the transaction is recorded in the database with the Paystack reference. You can look it up and manually trigger a refund via the Paystack dashboard.

The review token is stored permanently — users can access their report at any time via `/api/review/:token`.
