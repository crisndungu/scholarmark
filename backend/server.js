/**
 * server.js — ScholarMark Backend
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
const FATAL_ENV = ["ANTHROPIC_API_KEY", "SESSION_SECRET"];
for (const key of FATAL_ENV) {
  if (!process.env[key] || process.env[key].includes("XXXXXXX") || process.env[key].includes("CHANGE_THIS")) {
    console.error(`[FATAL] Missing or placeholder env var: ${key}`);
    process.exit(1);
  }
}
const WARN_ENV = ["PAYSTACK_SECRET_KEY", "PAYSTACK_PUBLIC_KEY"];
for (const key of WARN_ENV) {
  if (!process.env[key] || process.env[key].includes("XXXXXXX")) {
    console.warn(`[WARN]  ${key} is not set — payment features will be unavailable.`);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// ─── TRUST PROXY ──────────────────────────────────────────────────
app.set("trust proxy", 1);

// ─── SECURITY MIDDLEWARE ───────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "https://js.paystack.co",
        "https://checkout.paystack.com",
        "'unsafe-inline'",
        "'unsafe-eval'",
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
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

// ─── CORS ─────────────────────────────────────────────────────────
const allowedOrigins = [
  "https://scholarmark.vercel.app",
  "https://scholarmark.onrender.com",
  process.env.FRONTEND_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (
      allowedOrigins.includes(origin) ||
      /^https:\/\/scholarmark.*\.vercel\.app$/.test(origin) ||
      /^https:\/\/.*\.onrender\.com$/.test(origin)
    ) {
      return cb(null, true);
    }
    console.log(`[CORS BLOCKED] ${origin}`);
    cb(new Error("CORS: origin not allowed"));
  },
  credentials: true,
}));

// ─── RATE LIMITERS ────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again shortly." },
});

const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Submission limit reached. Please try again in an hour." },
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: "Payment request limit reached. Please try again later." },
});

app.use("/api", generalLimiter);

// ─── RAW BODY for Webhook ─────────────────────────────────────────
app.use("/api/webhook/paystack", express.raw({ type: "application/json" }));

// ─── BODY PARSING ─────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ─── FILE UPLOAD ──────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
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

// ─── HELPERS ──────────────────────────────────────────────────────
function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket.remoteAddress ||
    "127.0.0.1"
  );
}

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

app.get("/api/pubkey", (req, res) => {
  res.json({ key: process.env.PAYSTACK_PUBLIC_KEY });
});

app.post("/api/location", async (req, res) => {
  try {
    const ip = getClientIP(req);
    let countryCode = "US";
    const geo = geoip.lookup(ip);
    if (geo?.country) countryCode = geo.country;
    if (req.body?.countryCode) countryCode = req.body.countryCode;

    const currency = pricing.getCurrencyForCountry(countryCode);
    const prices = await pricing.getPricingForCurrency(currency);
    res.json({ success: true, country: countryCode, currency, prices });
  } catch (err) {
    console.error("[Location]", err);
    const prices = await pricing.getPricingForCurrency("USD");
    res.json({ success: true, country: "US", currency: "USD", prices });
  }
});

app.post("/api/submission", submissionLimiter, upload.array("files", 10), async (req, res) => {
  try {
    const { name, email, level, currency } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: "Name is required." });
    if (!email?.includes("@")) return res.status(400).json({ error: "Valid email is required." });
    if (!level || !["Level 7", "Level 8", "Level 9", "Level 10"].includes(level))
      return res.status(400).json({ error: "Invalid academic level." });
    if (!req.files?.length) return res.status(400).json({ error: "At least one file is required." });

    const validCurrencies = Object.keys(pricing.CURRENCY_CONFIG);
    const useCurrency = validCurrencies.includes(currency) ? currency : "USD";

    const prices = await pricing.getPricingForCurrency(useCurrency);
    const priceData = prices[level];
    if (!priceData) return res.status(400).json({ error: "Invalid level/currency." });

    const ip = getClientIP(req);
    const geo = geoip.lookup(ip);

    const submissionId = uuidv4();
    await db.createSubmission({
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

    fileTextCache.set(submissionId, {
      texts: req.files.map(f => ({
        name: f.originalname,
        text: f.buffer.toString("utf8").slice(0, 15000),
      })),
      created: Date.now(),
    });

    res.json({ success: true, submissionId, price: priceData, currency: useCurrency });
  } catch (err) {
    console.error("[Submission]", err);
    res.status(500).json({ error: "Submission failed. Please try again." });
  }
});

// In-memory file cache — cleared after review or 2 hours
const fileTextCache = new Map();
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, val] of fileTextCache) {
    if (val.created < cutoff) fileTextCache.delete(key);
  }
}, 30 * 60 * 1000);

app.post("/api/payment/init", paymentLimiter, async (req, res) => {
  try {
    const { submissionId } = req.body;
    if (!submissionId) return res.status(400).json({ error: "submissionId required." });

    const submission = await db.getSubmissionById(submissionId);
    if (!submission) return res.status(404).json({ error: "Submission not found." });

    if (await db.hasSuccessfulPayment(submissionId))
      return res.status(400).json({ error: "This submission has already been paid for." });

    const ref = `sm_${uuidv4().replace(/-/g, "").slice(0, 16)}`;

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
      return res.status(502).json({ error: `Payment initialization failed: ${paystackRes.message || "Please try again."}` });
    }

    await db.createTransaction({
      id: uuidv4(),
      submission_id: submissionId,
      paystack_ref: ref,
      amount: submission.amount,
      currency: submission.currency,
    });

    res.json({ success: true, access_code: paystackRes.data.access_code, reference: ref });
  } catch (err) {
    console.error("[Payment/Init]", err);
    res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
});

app.post("/api/payment/verify", async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: "Reference required." });

    const transaction = await db.getTransactionByRef(reference);
    if (!transaction) return res.status(404).json({ error: "Transaction not found." });

    if (transaction.status === "success") {
      const sub = await db.getSubmissionById(transaction.submission_id);
      if (sub) {
        const reviewRes = await db.db.execute({
          sql: "SELECT token FROM reviews WHERE submission_id = ?",
          args: [sub.id],
        });
        const review = reviewRes.rows[0];
        if (review) return res.json({ success: true, reviewToken: review.token });
      }
      return res.json({ success: true, status: "paid_awaiting_review" });
    }

    const verification = await paystackRequest("GET", `/transaction/verify/${reference}`);

    if (!verification.status || verification.data?.status !== "success") {
      await db.updateTransactionFailed(reference);
      return res.status(402).json({ error: "Payment was not successful." });
    }

    if (verification.data.amount !== transaction.amount) {
      console.error(`[FRAUD] Amount mismatch for ref ${reference}: expected ${transaction.amount}, got ${verification.data.amount}`);
      await db.updateTransactionFailed(reference);
      return res.status(402).json({ error: "Payment amount mismatch. Please contact support." });
    }

    await db.updateTransactionSuccess(reference, verification.data);
    const reviewToken = await triggerReview(transaction);
    res.json({ success: true, reviewToken });
  } catch (err) {
    console.error("[Payment/Verify]", err);
    res.status(500).json({ error: "Verification failed. Please contact support with your reference." });
  }
});

app.post("/api/webhook/paystack", async (req, res) => {
  res.sendStatus(200);
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const signature = req.headers["x-paystack-signature"];
    const computed = crypto.createHmac("sha512", secret).update(req.body).digest("hex");
    if (computed !== signature) { console.warn("[Webhook] HMAC verification failed"); return; }

    const event = JSON.parse(req.body.toString());
    if (event.event !== "charge.success") return;

    const ref = event.data?.reference;
    if (!ref) return;

    const transaction = await db.getTransactionByRef(ref);
    if (!transaction || transaction.status === "success") return;

    if (event.data.amount !== transaction.amount) {
      console.error(`[Webhook/FRAUD] Amount mismatch ref ${ref}`);
      return;
    }

    await db.updateTransactionSuccess(ref, event.data);
    await triggerReview(transaction);
  } catch (err) {
    console.error("[Webhook] Error:", err);
  }
});

async function triggerReview(transaction) {
  const submission = await db.getSubmissionById(transaction.submission_id);
  if (!submission) throw new Error("Submission not found for review");

  const cached = fileTextCache.get(submission.id);
  const files = cached?.texts || [];

  const docContext = files.length
    ? files.map((f, i) => {
      const role = i === 0 ? "MAIN DOCUMENT" : "SUPPORTING MATERIAL";
      return `--- ${role}: ${f.name} ---\n${f.text}`;
    }).join("\n\n")
    : "[Document text unavailable — files may have expired from cache]";

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

  const reviewToken = crypto.randomBytes(48).toString("hex");
  await db.createReview({
    id: uuidv4(),
    submission_id: submission.id,
    transaction_id: transaction.id,
    result_json: JSON.stringify(result),
    token: reviewToken,
  });

  fileTextCache.delete(submission.id);
  console.log(`[Review] Completed for submission ${submission.id}`);
  return reviewToken;
}

app.get("/api/review/:token", async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length < 96) return res.status(400).json({ error: "Invalid token." });

    const review = await db.getReviewByToken(token);
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