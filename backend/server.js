/**
 * server.js — ScholarMark Backend
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
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
const { createClerkClient } = require("@clerk/clerk-sdk-node");
const db = require("./database");
const pricing = require("./pricing");

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

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
      connectSrc: ["'self'", "https://scholarmark.onrender.com", "https://scholarmark.vercel.app", "https://scholarmark.co.ke", "https://www.scholarmark.co.ke", "https://api.paystack.co", "https://checkout.paystack.com", "https://standard.paystack.co"],
      frameSrc: ["https://checkout.paystack.com", "https://paystack.com", "https://standard.paystack.co"],
      imgSrc: ["'self'", "data:", "https://*.paystack.co", "https://paystack.com", "https://checkout.paystack.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const allowedOrigins = [
  "http://localhost:3000", "http://127.0.0.1:3000",
  "https://scholarmark.onrender.com", "https://scholarmark.vercel.app",
  "https://scholarmark.co.ke", "https://www.scholarmark.co.ke",
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin)) return cb(null, true);
    if (/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin)) return cb(null, true);
    console.warn(`[CORS] Blocked: ${origin}`);
    cb(new Error("CORS: origin not allowed"));
  },
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
}));

// ─── RATE LIMITERS ────────────────────────────────────────────────
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests." } });
const submissionLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: "Submission limit reached. Try again in an hour." } });
const paymentLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: "Payment request limit reached." } });
app.use("/api", generalLimiter);

app.use("/api/webhook/paystack", express.raw({ type: "application/json" }));
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

app.get("/api/config", (req, res) => {
  res.json({
    clerkPublishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY || "",
    paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || ""
  });
});

app.use(express.static(path.join(__dirname, "../frontend"), {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
}));

// ─── HELPERS ──────────────────────────────────────────────────────
function getClientIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.headers["x-real-ip"] || req.socket.remoteAddress || "127.0.0.1";
}

async function paystackRequest(method, endpoint, body) {
  try {
    const res = await fetch(`https://api.paystack.co${endpoint}`, {
      method,
      headers: { "Authorization": `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  } catch (err) {
    console.error(`[Paystack] Network error on ${endpoint}:`, err.message);
    return { status: false, message: "Network error" };
  }
}

function extractText(buffer) {
  try {
    const txt = buffer.toString("utf8");
    const printable = txt.replace(/[^\x20-\x7E\r\n\t]/g, "").length;
    if (printable / txt.length > 0.7) return txt.slice(0, 15000);
    return txt.replace(/[^\x20-\x7E\r\n\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 15000);
  } catch (e) {
    return buffer.toString("latin1").replace(/[^\x20-\x7E\r\n\t]/g, " ").slice(0, 15000);
  }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthenticated" });
    const token = authHeader.split(" ")[1];
    const session = await clerk.verifyToken(token);
    req.auth = { userId: session.sub };
    next();
  } catch (err) {
    console.error("[Auth] Session verification failed:", err.message);
    res.status(401).json({ error: "Invalid session" });
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────
app.get("/api/user/submissions", requireAuth, async (req, res) => {
  try {
    const submissions = await db.getSubmissionsByUserId(req.auth.userId);
    res.json({ success: true, submissions });
  } catch (err) {
    console.error("[User/Submissions] ERROR:", err);
    res.status(500).json({ error: "Could not fetch history." });
  }
});

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
    const prices = await pricing.getPricingForCurrency("KES");
    res.json({ success: true, country: "KE", currency: "KES", prices });
  }
});

// ─── SUBMISSION ───────────────────────────────────────────────────
app.post("/api/submission", requireAuth, submissionLimiter, upload.array("files", 10), async (req, res) => {
  try {
    const userId = req.auth.userId;

    const { name, email, level } = req.body;
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

    // ── KEY FIX: Save extracted text directly to DB ──
    // Never use in-memory cache — Render restarts wipe it before review runs
    const extractedText = req.files
      .map((f, i) => `--- ${i === 0 ? "MAIN DOCUMENT" : "SUPPORTING MATERIAL"}: ${f.originalname} ---\n${extractText(f.buffer)}`)
      .join("\n\n");

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
      extracted_text: extractedText,
      user_id: userId,
    });

    console.log(`[Submission] Created ${submissionId} — ${level} — ${priceData.formatted} — text: ${extractedText.length} chars`);
    res.json({ success: true, submissionId, price: priceData, currency: useCurrency });
  } catch (err) {
    console.error("[Submission] ERROR:", err);
    res.status(500).json({ error: "Submission failed. Please try again.", details: err.message });
  }
});

// ─── PAYMENT INIT ─────────────────────────────────────────────────
app.post("/api/payment/init", paymentLimiter, async (req, res) => {
  try {
    const { submissionId } = req.body;
    if (!submissionId) return res.status(400).json({ error: "submissionId required." });

    const submission = await db.getSubmissionById(submissionId);
    if (!submission) return res.status(404).json({ error: "Submission not found." });

    // Already paid — return existing review token
    if (await db.hasSuccessfulPayment(submissionId)) {
      const existingReview = await db.getReviewBySubmissionId(submissionId);
      if (existingReview) return res.json({ success: true, alreadyPaid: true, reviewToken: existingReview.token });
      return res.status(400).json({ error: "Already paid. Contact support if your review is missing." });
    }

    const ref = `sm_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
    const frontendUrl = process.env.FRONTEND_URL || "https://scholarmark.vercel.app";

    // ── KEY FIX: Always use redirect flow — no popup ──
    // Redirect is reliable. Popup marks payments "abandoned" even when successful.
    // Paystack appends ?reference=<ref>&trxref=<ref> to callback_url automatically.
    const callbackUrl = `${frontendUrl}?submissionId=${submissionId}`;

    const paystackPayload = {
      email: submission.email,
      amount: submission.amount,
      reference: ref,
      callback_url: callbackUrl,
      metadata: {
        submission_id: submissionId,
        level: submission.level,
        name: submission.name,
        file_count: submission.file_count,
      },
      channels: ["card", "mobile_money", "bank_transfer"],
    };

    console.log(`[Payment/Init] ref: ${ref}, amount: ${submission.amount}, callback: ${callbackUrl}`);

    const paystackRes = await paystackRequest("POST", "/transaction/initialize", paystackPayload);
    if (!paystackRes.status) {
      console.error("[Payment/Init] Paystack error:", JSON.stringify(paystackRes));
      return res.status(502).json({ error: `Payment initialization failed: ${paystackRes.message || "Unknown error"}` });
    }

    await db.createTransaction({
      id: uuidv4(),
      submission_id: submissionId,
      paystack_ref: ref,
      paystack_internal_ref: paystackRes.data.reference || ref,
      amount: submission.amount,
      currency: submission.currency,
    });

    console.log(`[Payment/Init] Success — ref: ${ref}, auth_url: ${paystackRes.data.authorization_url}`);
    res.json({
      success: true,
      reference: ref,
      authorization_url: paystackRes.data.authorization_url,
      // access_code still returned for any future popup use
      access_code: paystackRes.data.access_code,
    });
  } catch (err) {
    console.error("[Payment/Init] Exception:", err);
    res.status(500).json({ error: "Payment initialization failed. Please try again." });
  }
});

// ─── PAYMENT VERIFY ───────────────────────────────────────────────
app.post("/api/payment/verify", async (req, res) => {
  try {
    const { reference, submissionId } = req.body;
    if (!reference && !submissionId) return res.status(400).json({ error: "Reference or submissionId required." });

    console.log(`[Verify] ref: ${reference}, subId: ${submissionId}`);

    // Look up transaction by ref first, fall back to submissionId
    let transaction = reference ? await db.getTransactionByRef(reference) : null;
    if (!transaction && submissionId) {
      console.log(`[Verify] Ref not found — trying submissionId fallback`);
      transaction = await db.getTransactionBySubmission(submissionId);
    }
    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found. Please contact support with ref: " + reference });
    }

    const verifyRef = transaction.paystack_ref; // Always use our sm_xxx ref to verify

    // Already successful — return existing review
    if (transaction.status === "success") {
      let existingReview = await db.getReviewBySubmissionId(transaction.submission_id);

      if (!existingReview) {
        console.log(`[Verify] Paid but no review found for subId: ${transaction.submission_id}. Re-triggering...`);
        try {
          await triggerReview(transaction);
          existingReview = await db.getReviewBySubmissionId(transaction.submission_id);
        } catch (revErr) {
          console.error("[Verify] Re-triggering review failed:", revErr.message);
          
          // Check for common fatal errors (e.g. invalid JSON, API quota)
          const isFatal = revErr.message.includes("invalid JSON") || revErr.message.includes("401") || revErr.message.includes("403");
          
          return res.status(isFatal ? 500 : 402).json({
            success: !isFatal,
            reviewToken: null,
            status: "paid_awaiting_review",
            error: isFatal ? `Academic review generation failed: ${revErr.message}` : "Review is being generated. Please wait a moment.",
            retryable: !isFatal,
          });
        }
      }

      const submission = await db.getSubmissionById(transaction.submission_id);
      return res.json({
        success: true,
        reviewToken: existingReview?.token || null,
        status: existingReview ? "reviewed" : "paid_awaiting_review",
        submission: submission ? { name: submission.name, email: submission.email, level: submission.level, fileCount: submission.file_count } : null,
      });
    }

    // ── Verify with Paystack ──────────────────────────────────────
    console.log(`[Verify] Checking Paystack for ref: ${verifyRef}`);
    const verification = await paystackRequest("GET", `/transaction/verify/${verifyRef}`);
    const paystackStatus = verification.data?.status;
    console.log(`[Verify] Paystack status: ${paystackStatus}`);

    if (!verification.status || !paystackStatus) {
      return res.status(502).json({ error: "Could not reach payment provider. Please try again." });
    }

    // Not yet confirmed — tell frontend to retry
    if (paystackStatus === "pending") {
      return res.status(402).json({
        error: "Payment is still processing. Please wait a moment and try again.",
        status: paystackStatus,
        retryable: true,
      });
    }

    // Abandoned — this should rarely happen with redirect flow
    if (paystackStatus === "abandoned") {
      return res.status(402).json({
        error: "Payment was not completed. Please try paying again.",
        status: paystackStatus,
        retryable: false,
      });
    }

    if (paystackStatus !== "success") {
      await db.updateTransactionFailed(verifyRef);
      return res.status(402).json({ error: `Payment failed (${paystackStatus}). Please try again.` });
    }

    // ── Amount check ──────────────────────────────────────────────
    if (verification.data.amount !== transaction.amount) {
      console.warn(`[Verify] Amount mismatch: expected ${transaction.amount}, got ${verification.data.amount}`);
      const ratio = verification.data.amount / transaction.amount;
      if (process.env.NODE_ENV === "production" && (ratio < 0.95 || ratio > 1.05)) {
        await db.updateTransactionFailed(verifyRef);
        return res.status(402).json({ error: "Payment amount mismatch. Please contact support." });
      }
    }

    await db.updateTransactionSuccess(verifyRef, verification.data);
    console.log(`[Verify] Payment confirmed — triggering review for ${transaction.submission_id}`);
    const reviewToken = await triggerReview(transaction);
    const submission = await db.getSubmissionById(transaction.submission_id);

    res.json({
      success: true,
      reviewToken,
      submission: submission ? { name: submission.name, email: submission.email, level: submission.level, fileCount: submission.file_count } : null,
    });
  } catch (err) {
    console.error("[Verify] Exception:", err);
    res.status(500).json({ error: "Verification failed. Please contact support with your reference." });
  }
});

// ─── WEBHOOK ──────────────────────────────────────────────────────
app.post("/api/webhook/paystack", async (req, res) => {
  res.sendStatus(200);
  try {
    const signature = req.headers["x-paystack-signature"];
    const computed = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(req.body).digest("hex");
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
    console.log(`[Webhook] Review triggered for ref ${ref}`);
  } catch (err) {
    console.error("[Webhook] Error:", err);
  }
});

// ─── REVIEW ───────────────────────────────────────────────────────
async function triggerReview(transaction) {
  const submission = await db.getSubmissionById(transaction.submission_id);
  if (!submission) throw new Error("Submission not found for review");

  // ── KEY FIX: Read text from DB — never from in-memory cache ──
  const docContext = submission.extracted_text?.trim()
    ? submission.extracted_text
    : "[Document text unavailable. Please contact support.]";

  console.log(`[Review] Text available: ${docContext.length} chars`);

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
  "strengths": ["<specific strength>", "<strength 2>", "<strength 3>"],
  "criticalWeaknesses": ["<specific weakness>", "<weakness 2>", "<weakness 3>"],
  "criteriaScores": {
    ${criteria.map(c => `"${c}": { "score": <0-100>, "feedback": "<one specific sentence>" }`).join(",\n    ")}
  },
  "improvementPlan": [
    { "priority": "High",   "area": "<area>", "action": "<concrete step>", "rationale": "<why>" },
    { "priority": "High",   "area": "<area>", "action": "<concrete step>", "rationale": "<why>" },
    { "priority": "Medium", "area": "<area>", "action": "<concrete step>", "rationale": "<why>" },
    { "priority": "Medium", "area": "<area>", "action": "<concrete step>", "rationale": "<why>" },
    { "priority": "Low",    "area": "<area>", "action": "<concrete step>", "rationale": "<why>" }
  ],
  "recommendedResources": ["<book/journal/tool>", "<resource 2>", "<resource 3>"],
  "resubmissionReadiness": "<Ready for Submission|Minor Revisions Required|Major Revisions Required|Not Ready for Submission>",
  "reviewerNotes": "<One honest paragraph of final commentary>"
}

SUBMITTED DOCUMENTS:
"""
${docContext}
"""`;

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
  });

  if (!anthropicRes.ok) {
    const txt = await anthropicRes.text();
    throw new Error(`Anthropic API error ${anthropicRes.status}: ${txt}`);
  }

  const anthropicData = await anthropicRes.json();
  const raw = anthropicData.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();

  console.log(`[Review] Anthropic raw response received (${raw.length} chars)`);

  let result;
  try {
    result = JSON.parse(raw);
  } catch (parseErr) {
    console.error("[Review] JSON parse failed. Raw text:", raw);
    throw new Error("AI review returned invalid JSON content. This usually happens if the AI output contains unescaped characters.");
  }

  const reviewToken = crypto.randomBytes(48).toString("hex");
  await db.createReview({
    id: uuidv4(),
    submission_id: submission.id,
    transaction_id: transaction.id,
    result_json: JSON.stringify(result),
    token: reviewToken,
  });

  console.log(`[Review] Successfully saved review for subId: ${submission.id} — score: ${result.overallScore}`);
  return reviewToken;
}

app.get("/api/review/:token", async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length < 96) return res.status(400).json({ error: "Invalid token." });
    const review = await db.getReviewByToken(token);
    if (!review) return res.status(404).json({ error: "Review not found." });
    res.json({ success: true, result: JSON.parse(review.result_json), name: review.name, level: review.level, fileNames: JSON.parse(review.file_names), createdAt: review.created_at });
  } catch (err) {
    console.error("[Review/Get]", err);
    res.status(500).json({ error: "Could not retrieve review." });
  }
});

app.get("/api/review/by-submission/:submissionId", requireAuth, async (req, res) => {
  try {
    const { submissionId } = req.params;
    const submission = await db.getSubmissionById(submissionId);
    if (!submission || submission.user_id !== req.auth.userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    const review = await db.getReviewBySubmissionId(submissionId);
    if (!review) return res.status(404).json({ error: "Review not found" });
    res.json({ success: true, token: review.token });
  } catch (err) {
    console.error("[Review/BySub]", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));

app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "File too large. Maximum 10MB." });
  if (err.code === "LIMIT_FILE_COUNT") return res.status(400).json({ error: "Maximum 10 files." });
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