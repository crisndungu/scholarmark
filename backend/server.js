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

app.set("trust proxy", 1);

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://js.paystack.co", "'unsafe-inline'", "'unsafe-eval'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'", "https://paystack.com", "https://checkout.paystack.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://paystack.com"],
      connectSrc: [
        "'self'",
        "https://scholarmark.onrender.com",
        "https://scholarmark.vercel.app",
        "https://scholarmark.co.ke",
        "https://www.scholarmark.co.ke",
        "https://api.paystack.co",
        "https://checkout.paystack.com",
        "https://standard.paystack.co",
      ],
      frameSrc: ["https://checkout.paystack.com", "https://paystack.com", "https://standard.paystack.co"],
      imgSrc: ["'self'", "data:", "https://*.paystack.co", "https://paystack.com", "https://checkout.paystack.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://scholarmark.onrender.com",
  "https://scholarmark.vercel.app",
  "https://scholarmark.co.ke",
  "https://www.scholarmark.co.ke",
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];

app.use(cors({
  origin: (origin, cb) => {
    console.log(`[CORS] Received Origin: ${origin}`);
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return cb(null, true);
    if (/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin)) return cb(null, true);
    console.warn(`[CORS] Blocked Origin: ${origin}`);
    cb(new Error("CORS: origin not allowed"));
  },
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  exposedHeaders: ["Content-Range", "X-Content-Range"],
}));

// ─── RATE LIMITERS ────────────────────────────────────────────────
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests. Please try again shortly." } });
const submissionLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: "Submission limit reached. Please try again in an hour." } });
const paymentLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: "Payment request limit reached. Please try again later." } });

app.use("/api", generalLimiter);

// ─── RAW BODY for Webhook (MUST be before express.json) ───────────
app.use("/api/webhook/paystack", express.raw({ type: "application/json" }));

// ─── BODY PARSING ─────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ─── FILE UPLOAD ──────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (!/\.(pdf|doc|docx|txt)$/i.test(file.originalname)) return cb(new Error(`File type not allowed: ${file.originalname}`));
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
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.headers["x-real-ip"] || req.socket.remoteAddress || "127.0.0.1";
}

async function paystackRequest(method, endpoint, body) {
  const res = await fetch(`https://api.paystack.co${endpoint}`, {
    method,
    headers: { "Authorization": `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function extractText(buffer) {
  try {
    // Basic text extraction: try UTF-8 first
    // In a production environment, you'd use pdf-parse or mammoth.js here.
    const txt = buffer.toString("utf8");
    // Filter out non-printable characters but keep common whitespace
    return txt.replace(/[^\x20-\x7E\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  } catch (err) {
    console.error("[Extract] Failed to extract text:", err.message);
    return "[Error extracting text from this file]";
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────
app.get("/api/pubkey", (req, res) => {
  res.json({ key: process.env.PAYSTACK_PUBLIC_KEY });
});

app.post("/api/location", async (req, res) => {
  try {
    const ip = getClientIP(req);
    let countryCode = "KE";
    const geo = geoip.lookup(ip);
    if (geo?.country) countryCode = geo.country;
    if (req.body?.countryCode) countryCode = req.body.countryCode;
    const currency = pricing.getCurrencyForCountry(countryCode);
    const prices = await pricing.getPricingForCurrency(currency);
    res.json({ success: true, country: countryCode, currency, prices });
  } catch (err) {
    console.error("[Location]", err);
    const prices = await pricing.getPricingForCurrency("KES");
    res.json({ success: true, country: "KE", currency: "KES", prices });
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
    const useCurrency = "KES";
    const prices = await pricing.getPricingForCurrency(useCurrency);
    const priceData = prices[level];
    if (!priceData) return res.status(400).json({ error: "Invalid level." });
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
      extracted_text: req.files.map((f, i) => `--- ${i === 0 ? "MAIN DOCUMENT" : "SUPPORTING MATERIAL"}: ${f.originalname} ---\n${extractText(f.buffer)}`).join("\n\n"),
    });
    console.log(`[Submission] Created ${submissionId} — ${level} — ${priceData.formatted}`);
    res.json({ success: true, submissionId, price: priceData, currency: useCurrency });
  } catch (err) {
    console.error("[Submission] CRITICAL ERROR:", err);
    res.status(500).json({
      error: "Submission failed. This is usually due to a database sync issue. Please try again or contact support.",
      details: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
});

app.post("/api/payment/init", paymentLimiter, async (req, res) => {
  try {
    const { submissionId, callback_url } = req.body;
    if (!submissionId) return res.status(400).json({ error: "submissionId required." });
    const submission = await db.getSubmissionById(submissionId);
    if (!submission) return res.status(404).json({ error: "Submission not found." });
    console.log(`[Payment/Init] Submission: id=${submission.id} amount=${submission.amount} email=${submission.email}`);

    if (await db.hasSuccessfulPayment(submissionId)) {
      const existingReview = await db.getReviewBySubmissionId(submissionId);
      if (existingReview) {
        return res.json({ success: true, alreadyPaid: true, reviewToken: existingReview.token });
      }
      return res.status(400).json({ error: "Already paid. Contact support if your review is missing." });
    }

    const ref = `sm_${uuidv4().replace(/-/g, "").slice(0, 16)}`;

    // ── callback_url tells Paystack where to redirect after payment ──
    // It appends ?reference=<ref>&trxref=<ref> to the URL automatically
    const frontendUrl = process.env.FRONTEND_URL || "https://scholarmark.vercel.app";

    const paystackPayload = {
      email: submission.email,
      amount: submission.amount,
      currency: "KES",
      reference: ref,
      callback_url: callback_url || frontendUrl,   // ← Use dynamically sent URL if available
      metadata: {
        submission_id: submissionId,
        level: submission.level,
        name: submission.name,
        file_count: submission.file_count,
      },
      channels: ["card", "mobile_money", "bank_transfer"],
    };
    console.log("[Payment/Init] Paystack payload:", JSON.stringify(paystackPayload));

    const paystackRes = await paystackRequest("POST", "/transaction/initialize", paystackPayload);
    if (!paystackRes.status) {
      console.error("[Payment/Init] Paystack error:", JSON.stringify(paystackRes));
      return res.status(502).json({ error: `Payment initialization failed: ${paystackRes.message || "Unknown error"}` });
    }

    const finalRef = paystackRes.data.reference || ref;

    await db.createTransaction({
      id: uuidv4(),
      submission_id: submissionId,
      paystack_ref: finalRef,
      amount: submission.amount,
      currency: submission.currency,
    });

    console.log(`[Payment/Init] Success — ref: ${finalRef}, access_code: ${paystackRes.data.access_code}`);
    res.json({
      success: true,
      access_code: paystackRes.data.access_code,
      reference: finalRef,
      authorization_url: paystackRes.data.authorization_url,
    });
  } catch (err) {
    console.error("[Payment/Init] Exception:", err);
    res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
});

app.post("/api/payment/verify", async (req, res) => {
  try {
    const { reference, submissionId } = req.body;
    if (!reference && !submissionId) return res.status(400).json({ error: "Reference or Submission ID required." });

    console.log(`[Verify/Start] Received ref: ${reference}, subId: ${submissionId}`);

    let transaction = await db.getTransactionByRef(reference);
    if (!transaction && submissionId) {
      console.log(`[Verify/Fallback] Ref not found, trying fallback subId: ${submissionId}`);
      transaction = await db.getTransactionBySubmission(submissionId);
    }

    if (!transaction) {
      console.error("[Verify/Error] Transaction not found for ref/subId");
      return res.status(404).json({ error: "Transaction not found." });
    }

    const finalRef = transaction.paystack_ref;
    console.log(`[Verify/Status] Using transaction ${transaction.id}, ref: ${finalRef}, status: ${transaction.status}`);

    if (transaction.status === "success") {
      const existingReview = await db.getReviewBySubmissionId(transaction.submission_id);
      const submission = await db.getSubmissionById(transaction.submission_id);
      return res.json({
        success: true,
        reviewToken: existingReview?.token || null,
        status: existingReview ? "reviewed" : "paid_awaiting_review",
        submission: submission ? {
          name: submission.name,
          email: submission.email,
          level: submission.level,
          fileCount: submission.file_count
        } : null
      });
    }
    const verification = await paystackRequest("GET", `/transaction/verify/${finalRef}`);
    if (!verification.status || verification.data?.status !== "success") {
      await db.updateTransactionFailed(finalRef);
      return res.status(402).json({ error: "Payment was not successful." });
    }
    if (verification.data.amount !== transaction.amount) {
      console.warn(`[Amount] Mismatch ref ${finalRef}: expected ${transaction.amount}, got ${verification.data.amount}`);
      if (process.env.NODE_ENV === "production") {
        await db.updateTransactionFailed(finalRef);
        return res.status(402).json({ error: "Payment amount mismatch. Please contact support." });
      }
      console.warn("[Amount] Continuing in non-production mode despite mismatch");
    }
    await db.updateTransactionSuccess(finalRef, verification.data);
    const reviewToken = await triggerReview(transaction);
    const submission = await db.getSubmissionById(transaction.submission_id);
    res.json({
      success: true,
      reviewToken,
      submission: submission ? {
        name: submission.name,
        email: submission.email,
        level: submission.level,
        fileCount: submission.file_count
      } : null
    });
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
    if (computed !== signature) { console.warn("[Webhook] HMAC failed"); return; }
    const event = JSON.parse(req.body.toString());
    if (event.event !== "charge.success") return;
    const ref = event.data?.reference;
    if (!ref) return;
    const transaction = await db.getTransactionByRef(ref);
    if (!transaction || transaction.status === "success") return;
    if (event.data.amount !== transaction.amount) { console.error(`[Webhook/FRAUD] Amount mismatch ref ${ref}`); return; }
    await db.updateTransactionSuccess(ref, event.data);
    await triggerReview(transaction);
  } catch (err) {
    console.error("[Webhook] Error:", err);
  }
});

async function triggerReview(transaction) {
  const submission = await db.getSubmissionById(transaction.submission_id);
  if (!submission) throw new Error("Submission not found for review");
  const docContext = submission.extracted_text || "[Document text unavailable. Please contact support.]";
  const levelCriteria = {
    "Level 7": ["Critical Analysis", "Research Methodology", "Theoretical Frameworks", "Academic Writing", "Argument Coherence"],
    "Level 8": ["Original Contribution", "Research Design Rigour", "Literature Synthesis", "Theoretical Innovation", "Scholarly Impact"],
    "Level 9": ["Field-Leading Insight", "Interdisciplinary Synthesis", "Publication Readiness", "Grant Narrative", "Methodological Mastery"],
    "Level 10": ["Paradigm Contribution", "Global Scholarly Relevance", "Policy Implications", "Pedagogical Value", "Legacy Impact"],
  };
  const criteria = levelCriteria[submission.level] || levelCriteria["Level 7"];
  const prompt = `You are a senior academic examiner assessing ${submission.level} work.
The candidate has submitted ${submission.file_count} document(s). The first is their main submission. Any additional documents are supporting materials such as marking guidelines or rubrics.
Read all documents carefully and provide an honest, rigorous, specific review. Reference the actual content directly — do not give generic feedback.
Return ONLY valid JSON with no markdown, no code fences, no preamble.

{
  "overallScore": <integer 0-100>,
  "grade": "<Distinction|Merit|Pass|Fail>",
  "executiveSummary": "<2-3 precise sentences directly referencing the work>",
  "strengths": ["<specific strength referencing actual content>", "<strength 2>", "<strength 3>"],
  "criticalWeaknesses": ["<specific weakness referencing actual content>", "<weakness 2>", "<weakness 3>"],
  "criteriaScores": {
    ${criteria.map(c => `"${c}": { "score": <0-100>, "feedback": "<one specific sentence referencing actual content>" }`).join(",\n    ")}
  },
  "improvementPlan": [
    { "priority": "High",   "area": "<area>", "action": "<concrete actionable step>", "rationale": "<why this matters>" },
    { "priority": "High",   "area": "<area>", "action": "<concrete actionable step>", "rationale": "<why this matters>" },
    { "priority": "Medium", "area": "<area>", "action": "<concrete actionable step>", "rationale": "<why this matters>" },
    { "priority": "Medium", "area": "<area>", "action": "<concrete actionable step>", "rationale": "<why this matters>" },
    { "priority": "Low",    "area": "<area>", "action": "<concrete actionable step>", "rationale": "<why this matters>" }
  ],
  "recommendedResources": ["<specific book, journal, or tool>", "<resource 2>", "<resource 3>"],
  "resubmissionReadiness": "<Ready for Submission|Minor Revisions Required|Major Revisions Required|Not Ready for Submission>",
  "reviewerNotes": "<One honest paragraph of final commentary directly referencing the work>"
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
      model: "claude-3-5-sonnet-20241022",
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

  let result;
  try {
    result = JSON.parse(raw);
  } catch (parseErr) {
    console.error("[Review] JSON parse failed. Raw output:", raw.slice(0, 500));
    throw new Error("AI review returned invalid JSON");
  }

  const reviewToken = crypto.randomBytes(48).toString("hex");
  await db.createReview({
    id: uuidv4(),
    submission_id: submission.id,
    transaction_id: transaction.id,
    result_json: JSON.stringify(result),
    token: reviewToken,
  });

  console.log(`[Review] Completed for submission ${submission.id} — score: ${result.overallScore}`);
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

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "File too large. Maximum 10MB per file." });
  if (err.code === "LIMIT_FILE_COUNT") return res.status(400).json({ error: "Maximum 10 files per submission." });
  console.error("[Unhandled]", err);
  res.status(500).json({ error: "An unexpected error occurred." });
});

app.listen(PORT, () => {
  console.log(`\n┌─────────────────────────────────────┐`);
  console.log(`  │  ScholarMark running on port ${PORT}   │`);
  console.log(`  │  ENV: ${process.env.NODE_ENV || "development"}                   │`);
  console.log(`  └─────────────────────────────────────┘\n`);
});

module.exports = app;