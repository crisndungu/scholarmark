/**
 * server.js — ScholarMark Backend
 *
 * Architecture:
 *   POST /api/location         → Detect country + return pricing
 *   POST /api/submission        → Accept files, create submission record
 *   POST /api/payment/init      → Initialize Paystack transaction (server-side)
 *   POST /api/payment/verify    → Verify payment + trigger review
 *   POST /api/webhook/paystack  → Paystack webhook (HMAC verified)
 *   GET  /api/review/:token     → Retrieve completed review
 *   GET  /api/pubkey            → Serve Paystack public key to frontend
 *
 * Security:
 *   - Helmet (security headers)
 *   - CORS (origin whitelist)
 *   - Rate limiting per route
 *   - HMAC webhook verification
 *   - Server-side Paystack verification (never trust client)
 *   - Files held in memory only — never written to disk
 *   - Anthropic key never exposed to browser
 */

require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const fetch = require("node-fetch");
const geoip = require("geoip-lite");

const db = require("./database");
const pricing = require("./pricing");

// ─── CONFIG VALIDATION ────────────────────────────────────────────
// Hard required — without these the core service cannot function at all
const FATAL_ENV = ["ANTHROPIC_API_KEY", "SESSION_SECRET"];
for (const key of FATAL_ENV) {
  if (!process.env[key] || process.env[key].includes("XXXXXXX") || process.env[key].includes("CHANGE_THIS")) {
    console.error(`[FATAL] Missing or placeholder env var: ${key}`);
    process.exit(1);
  }
}
// Warn only — server can start without these, but payments will not work
const WARN_ENV = ["PAYSTACK_SECRET_KEY", "PAYSTACK_PUBLIC_KEY"];
for (const key of WARN_ENV) {
  if (!process.env[key] || process.env[key].includes("XXXXXXX")) {
    console.warn(`[WARN]  ${key} is not set — payment features will be unavailable.`);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// ─── SECURITY MIDDLEWARE ───────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-eval' is required by Paystack's inline.js which uses eval() internally
      scriptSrc: [
        "'self'",
        "https://js.paystack.co",
        "https://checkout.paystack.com",
        "'unsafe-inline'",
        "'unsafe-eval'",
      ],
      scriptSrcAttr: ["'unsafe-inline'"],  // allow inline onclick/onkeydown handlers
      styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: [
        "'self'",
        "https://api.paystack.co",
        "https://checkout.paystack.com",
        "https://scholarmark.onrender.com",
      ],
      frameSrc: ["https://checkout.paystack.com"],
      imgSrc: ["'self'", "data:", "https://checkout.paystack.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ─── CORS — only allow your own frontend ──────────────────────────
const allowedOrigins = [
  "https://scholarmark.vercel.app",
  process.env.FRONTEND_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // ✅ Allow null origin (file://, Postman, curl)
    // ✅ Allow your listed origins
    if (!origin || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    console.log(`[CORS BLOCKED] ${origin}`); // Debug log
    cb(new Error("CORS: origin not allowed"));
  },
  credentials: true,
}));


// ─── RATE LIMITERS ────────────────────────────────────────────────

// General API: 100 req/15min per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again shortly." },
});

// Submission: 5 per hour per IP (prevent abuse)
const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Submission limit reached. Please try again in an hour." },
});

// Payment init: 10 per hour per IP
const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: "Payment request limit reached. Please try again later." },
});

app.use("/api", generalLimiter);

// ─── RAW BODY for Webhook (must be before express.json) ───────────
app.use("/api/webhook/paystack", express.raw({ type: "application/json" }));

// ─── BODY PARSING ─────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ─── FILE UPLOAD (memory only — never touches disk) ───────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,  // 10MB per file
    files: 10,                    // max 10 files
  },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(pdf|doc|docx|txt)$/i;
    if (!allowed.test(file.originalname)) {
      return cb(new Error(`File type not allowed: ${file.originalname}`));
    }
    cb(null, true);
  },
});

// ─── STATIC FILES ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../frontend"), {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
}));

// ─── HELPER: get client IP ────────────────────────────────────────
function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket.remoteAddress ||
    "127.0.0.1"
  );
}

// ─── HELPER: detect private/loopback IP ───────────────────────────
function isPrivateIP(ip) {
  return (
    !ip ||
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    ip.startsWith("172.16.") ||
    ip.startsWith("172.17.") ||
    ip.startsWith("172.18.") ||
    ip.startsWith("172.19.") ||
    ip.startsWith("172.2") ||
    ip.startsWith("172.30.") ||
    ip.startsWith("172.31.") ||
    ip.startsWith("::ffff:127.") ||
    ip.startsWith("::ffff:192.168.") ||
    ip.startsWith("::ffff:10.")
  );
}

// ─── HELPER: Paystack API call ────────────────────────────────────
async function paystackRequest(method, endpoint, body) {
  const res = await fetch(`https://api.paystack.co${endpoint}`, {
    method,
    headers: {
      "Authorization": `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ─── ROUTES ───────────────────────────────────────────────────────

/**
 * GET /api/pubkey
 * Returns the Paystack public key so the frontend never needs it hardcoded
 */
app.get("/api/pubkey", (req, res) => {
  res.json({ key: process.env.PAYSTACK_PUBLIC_KEY });
});

/**
 * POST /api/location
 * Detect country from IP → return currency + pricing
 */
app.post("/api/location", async (req, res) => {
  try {
    const ip = getClientIP(req);
    let countryCode = "US"; // fallback

    // Try GeoIP lookup
    const geo = geoip.lookup(ip);
    if (geo?.country) countryCode = geo.country;

    // Allow override from client (if they select a different currency)
    if (req.body?.countryCode) countryCode = req.body.countryCode;

    const currency = pricing.getCurrencyForCountry(countryCode);
    const prices = await pricing.getPricingForCurrency(currency);

    res.json({
      success: true,
      country: countryCode,
      currency,
      prices, // { "Level 7": { symbol, display, formatted, minor, ... }, ... }
    });
  } catch (err) {
    console.error("[Location]", err);
    // Fallback to USD
    const prices = await pricing.getPricingForCurrency("USD");
    res.json({ success: true, country: "US", currency: "USD", prices });
  }
});

/**
 * POST /api/submission
 * Accepts files + metadata, creates submission record
 * Returns submissionId for the payment step
 */
app.post("/api/submission", submissionLimiter, upload.array("files", 10), async (req, res) => {
  try {
    const { name, email, level, currency } = req.body;

    // Validate inputs
    if (!name?.trim()) return res.status(400).json({ error: "Name is required." });
    if (!email?.includes("@")) return res.status(400).json({ error: "Valid email is required." });
    if (!level || !["Level 7", "Level 8", "Level 9", "Level 10"].includes(level))
      return res.status(400).json({ error: "Invalid academic level." });
    if (!req.files?.length) return res.status(400).json({ error: "At least one file is required." });

    // Validate currency
    const validCurrencies = Object.keys(pricing.CURRENCY_CONFIG);
    const useCurrency = validCurrencies.includes(currency) ? currency : "USD";

    // Get authoritative price from server (never trust client-submitted price)
    const prices = await pricing.getPricingForCurrency(useCurrency);
    const priceData = prices[level];
    if (!priceData) return res.status(400).json({ error: "Invalid level/currency." });

    const ip = getClientIP(req);
    const geo = geoip.lookup(ip);

    // Store submission (no file content — files stay in memory for this request only)
    const submissionId = uuidv4();
    db.createSubmission({
      id: submissionId,
      name: name.trim().slice(0, 200),
      email: email.trim().toLowerCase().slice(0, 254),
      level,
      currency: useCurrency,
      amount: priceData.minor,
      file_count: req.files.length,
      file_names: JSON.stringify(req.files.map(f => f.originalname)),
      country_code: geo?.country || null,
      ip_address: ip,
    });

    // Store file texts in a temporary in-memory map (keyed by submissionId)
    // They'll be used when the review is triggered post-payment
    fileTextCache.set(submissionId, {
      texts: req.files.map(f => ({
        name: f.originalname,
        text: f.buffer.toString("utf8").slice(0, 15000),
      })),
      created: Date.now(),
    });

    res.json({
      success: true,
      submissionId,
      price: priceData,
      currency: useCurrency,
    });
  } catch (err) {
    console.error("[Submission]", err);
    res.status(500).json({ error: "Submission failed. Please try again." });
  }
});

// In-memory file text cache — files are cleared after review or after 2 hours
const fileTextCache = new Map();
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of fileTextCache) {
    if (val.created < cutoff) fileTextCache.delete(key);
  }
}, 30 * 60 * 1000);

/**
 * POST /api/payment/init
 * Initialize a Paystack transaction server-side (secret key never leaves server)
 * Returns access_code for the frontend popup
 */
app.post("/api/payment/init", paymentLimiter, async (req, res) => {
  try {
    const { submissionId } = req.body;
    if (!submissionId) return res.status(400).json({ error: "submissionId required." });

    const submission = db.getSubmissionById(submissionId);
    if (!submission) return res.status(404).json({ error: "Submission not found." });

    // Prevent double-charging
    if (db.hasSuccessfulPayment(submissionId))
      return res.status(400).json({ error: "This submission has already been paid for." });

    const ref = `sm_${uuidv4().replace(/-/g, "").slice(0, 16)}`;

    // Initialize with Paystack from the server
    const paystackRes = await paystackRequest("POST", "/transaction/initialize", {
      email: submission.email,
      amount: submission.amount,
      currency: submission.currency,
      reference: ref,
      metadata: {
        submission_id: submissionId,
        level: submission.level,
        name: submission.name,
        file_count: submission.file_count,
      },
      channels: ["card", "bank", "ussd", "qr", "mobile_money", "bank_transfer"],
    });

    if (!paystackRes.status) {
      console.error("[Payment/Init] Paystack error:", paystackRes);
      return res.status(502).json({ error: "Payment initialization failed. Please try again." });
    }

    // Store transaction record
    db.createTransaction({
      id: uuidv4(),
      submission_id: submissionId,
      paystack_ref: ref,
      amount: submission.amount,
      currency: submission.currency,
    });

    res.json({
      success: true,
      access_code: paystackRes.data.access_code,
      reference: ref,
    });
  } catch (err) {
    console.error("[Payment/Init]", err);
    res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
});

/**
 * POST /api/payment/verify
 * Called by frontend after Paystack popup reports success.
 * We verify server-side — never trust the client.
 * If verified, trigger the AI review.
 */
app.post("/api/payment/verify", async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: "Reference required." });

    const transaction = db.getTransactionByRef(reference);
    if (!transaction) return res.status(404).json({ error: "Transaction not found." });

    // Already verified?
    if (transaction.status === "success") {
      // Return existing review token if review exists
      const sub = db.getSubmissionById(transaction.submission_id);
      const review = sub ? db.db.prepare("SELECT token FROM reviews WHERE submission_id = ?").get(sub.id) : null;
      if (review) return res.json({ success: true, reviewToken: review.token });
      return res.json({ success: true, status: "paid_awaiting_review" });
    }

    // Verify with Paystack (server-to-server)
    const verification = await paystackRequest("GET", `/transaction/verify/${reference}`);

    if (!verification.status || verification.data?.status !== "success") {
      db.updateTransactionFailed(reference);
      return res.status(402).json({ error: "Payment was not successful." });
    }

    // Double-check the amount matches what we expect (prevents price tampering)
    if (verification.data.amount !== transaction.amount) {
      console.error(`[FRAUD] Amount mismatch for ref ${reference}: expected ${transaction.amount}, got ${verification.data.amount}`);
      db.updateTransactionFailed(reference);
      return res.status(402).json({ error: "Payment amount mismatch. Please contact support." });
    }

    // Mark transaction as paid
    db.updateTransactionSuccess(reference, verification.data);

    // Trigger AI review
    const reviewToken = await triggerReview(transaction);

    res.json({ success: true, reviewToken });
  } catch (err) {
    console.error("[Payment/Verify]", err);
    res.status(500).json({ error: "Verification failed. Please contact support with your reference." });
  }
});

/**
 * POST /api/webhook/paystack
 * Paystack webhook — HMAC SHA512 verified
 * Secondary insurance: if the client verification failed/missed, this catches it
 */
app.post("/api/webhook/paystack", async (req, res) => {
  // Immediately acknowledge
  res.sendStatus(200);

  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const signature = req.headers["x-paystack-signature"];
    const computed = crypto.createHmac("sha512", secret).update(req.body).digest("hex");

    if (computed !== signature) {
      console.warn("[Webhook] HMAC verification failed — ignoring");
      return;
    }

    const event = JSON.parse(req.body.toString());
    if (event.event !== "charge.success") return;

    const ref = event.data?.reference;
    if (!ref) return;

    const transaction = db.getTransactionByRef(ref);
    if (!transaction) return;
    if (transaction.status === "success") return; // already processed

    // Verify amount
    if (event.data.amount !== transaction.amount) {
      console.error(`[Webhook/FRAUD] Amount mismatch ref ${ref}`);
      return;
    }

    db.updateTransactionSuccess(ref, event.data);
    await triggerReview(transaction);
  } catch (err) {
    console.error("[Webhook] Error:", err);
  }
});

/**
 * triggerReview — calls Anthropic, stores result, returns token
 */
async function triggerReview(transaction) {
  const submission = db.getSubmissionById(transaction.submission_id);
  if (!submission) throw new Error("Submission not found for review");

  // Get file texts from cache
  const cached = fileTextCache.get(submission.id);
  const files = cached?.texts || [];

  // Build document context
  const docContext = files.length
    ? files.map((f, i) => {
      const role = i === 0 ? "MAIN DOCUMENT" : "SUPPORTING MATERIAL";
      return `--- ${role}: ${f.name} ---\n${f.text}`;
    }).join("\n\n")
    : "[Document text unavailable — files may have expired from cache]";

  // Level criteria
  const levelCriteria = {
    "Level 7": ["Critical Analysis", "Research Methodology", "Theoretical Frameworks", "Academic Writing", "Argument Coherence"],
    "Level 8": ["Original Contribution", "Research Design Rigour", "Literature Synthesis", "Theoretical Innovation", "Scholarly Impact"],
    "Level 9": ["Field-Leading Insight", "Interdisciplinary Synthesis", "Publication Readiness", "Grant Narrative", "Methodological Mastery"],
    "Level 10": ["Paradigm Contribution", "Global Scholarly Relevance", "Policy Implications", "Pedagogical Value", "Legacy Impact"],
  };
  const criteria = levelCriteria[submission.level] || levelCriteria["Level 7"];

  const prompt = `You are a senior academic examiner assessing ${submission.level} work.
The candidate has submitted ${submission.file_count} document(s). The first is their main submission. Any additional documents are supporting materials (guidelines, rubrics, marking briefs) that should inform your assessment criteria.

Read all documents and provide an honest, rigorous, specific review. Reference the actual content of the work directly.

Return ONLY valid JSON. No markdown, no preamble.

{
  "overallScore": <integer 0-100>,
  "grade": "<Distinction|Merit|Pass|Fail>",
  "executiveSummary": "<2-3 precise sentences directly referencing the work>",
  "strengths": ["<specific strength citing the document>","<strength 2>","<strength 3>"],
  "criticalWeaknesses": ["<specific weakness citing the document>","<weakness 2>","<weakness 3>"],
  "criteriaScores": {
    ${criteria.map(c => `"${c}": { "score": <0-100>, "feedback": "<one specific sentence citing the document>" }`).join(",\n    ")}
  },
  "improvementPlan": [
    { "priority": "High",   "area": "<area>", "action": "<specific actionable step>", "rationale": "<examiner rationale>" },
    { "priority": "High",   "area": "<area>", "action": "<specific actionable step>", "rationale": "<examiner rationale>" },
    { "priority": "Medium", "area": "<area>", "action": "<specific actionable step>", "rationale": "<examiner rationale>" },
    { "priority": "Medium", "area": "<area>", "action": "<specific actionable step>", "rationale": "<examiner rationale>" },
    { "priority": "Low",    "area": "<area>", "action": "<specific actionable step>", "rationale": "<examiner rationale>" }
  ],
  "recommendedResources": ["<specific textbook, journal or methodology guide>","<resource 2>","<resource 3>"],
  "resubmissionReadiness": "<Ready for Submission|Minor Revisions Required|Major Revisions Required|Not Ready for Submission>",
  "reviewerNotes": "<One honest paragraph of final commentary as an experienced examiner>"
}

SUBMITTED DOCUMENTS:
"""
${docContext}
"""`;

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!anthropicRes.ok) {
    const txt = await anthropicRes.text();
    throw new Error(`Anthropic API error ${anthropicRes.status}: ${txt}`);
  }

  const anthropicData = await anthropicRes.json();
  const raw = anthropicData.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  const result = JSON.parse(raw);

  // Generate secure one-time access token
  const reviewToken = crypto.randomBytes(48).toString("hex");

  db.createReview({
    id: uuidv4(),
    submission_id: submission.id,
    transaction_id: transaction.id,
    result_json: JSON.stringify(result),
    token: reviewToken,
  });

  // Clear cached files (privacy)
  fileTextCache.delete(submission.id);

  console.log(`[Review] Completed for submission ${submission.id}`);
  return reviewToken;
}

/**
 * GET /api/review/:token
 * Retrieve a completed review by its secure token
 */
app.get("/api/review/:token", (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length < 96) return res.status(400).json({ error: "Invalid token." });

    const review = db.getReviewByToken(token);
    if (!review) return res.status(404).json({ error: "Review not found. The link may have expired." });

    res.json({
      success: true,
      result: JSON.parse(review.result_json),
      name: review.name,
      level: review.level,
      fileNames: JSON.parse(review.file_names),
      createdAt: review.created_at,
    });
  } catch (err) {
    console.error("[Review/Get]", err);
    res.status(500).json({ error: "Could not retrieve review." });
  }
});

// ─── SPA FALLBACK ─────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ─── ERROR HANDLER ────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "File too large. Maximum 10MB per file." });
  if (err.code === "LIMIT_FILE_COUNT") return res.status(400).json({ error: "Maximum 10 files per submission." });
  console.error("[Unhandled]", err);
  res.status(500).json({ error: "An unexpected error occurred." });
});

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ┌─────────────────────────────────────┐`);
  console.log(`  │  ScholarMark running on port ${PORT}   │`);
  console.log(`  │  ENV: ${process.env.NODE_ENV || "development"}                   │`);
  console.log(`  └─────────────────────────────────────┘\n`);
});

module.exports = app;