/**
 * database.js — Turso (libSQL) schema and helpers
 * All rows are spread into plain objects before returning
 * so fields are always accessible as submission.amount, submission.email etc.
 */

const { createClient } = require("@libsql/client");
require("dotenv").config();

if (!process.env.TURSO_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error("[FATAL] TURSO_URL and TURSO_AUTH_TOKEN must be set");
  process.exit(1);
}

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ─── SCHEMA INIT ──────────────────────────────────────────────────
async function initSchema() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS submissions (
      id            TEXT PRIMARY KEY,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL,
      level         TEXT NOT NULL,
      currency      TEXT NOT NULL,
      amount        INTEGER NOT NULL,
      file_count    INTEGER NOT NULL,
      file_names    TEXT NOT NULL,
      country_code  TEXT,
      ip_address    TEXT,
      status        TEXT DEFAULT 'pending',
      extracted_text TEXT
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id              TEXT PRIMARY KEY,
      submission_id   TEXT NOT NULL,
      paystack_ref    TEXT UNIQUE NOT NULL,
      amount          INTEGER NOT NULL,
      currency        TEXT NOT NULL,
      status          TEXT DEFAULT 'pending',
      paystack_data   TEXT,
      verified_at     DATETIME,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id              TEXT PRIMARY KEY,
      submission_id   TEXT NOT NULL,
      transaction_id  TEXT NOT NULL,
      result_json     TEXT NOT NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      token           TEXT UNIQUE NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_submissions_email ON submissions(email);
    CREATE INDEX IF NOT EXISTS idx_transactions_ref  ON transactions(paystack_ref);
    CREATE INDEX IF NOT EXISTS idx_transactions_sub  ON transactions(submission_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_token     ON reviews(token);
    CREATE INDEX IF NOT EXISTS idx_reviews_sub       ON reviews(submission_id);
  `);

  // Migration: Add extracted_text column if missing
  try {
    const tableInfo = await db.execute("PRAGMA table_info(submissions)");
    const hasExtractedText = tableInfo.rows.some(r => r.name === 'extracted_text');
    if (!hasExtractedText) {
      console.log("[DB] Migrating: Adding extracted_text column to submissions table");
      await db.execute("ALTER TABLE submissions ADD COLUMN extracted_text TEXT");
    }
    const txInfo = await db.execute("PRAGMA table_info(transactions)");
    const hasInternalRef = txInfo.rows.some(r => r.name === 'paystack_internal_ref');
    if (!hasInternalRef) {
      console.log("[DB] Migrating: Adding paystack_internal_ref column to transactions table");
      await db.execute("ALTER TABLE transactions ADD COLUMN paystack_internal_ref TEXT");
    }
  } catch (migErr) {
    console.warn("[DB] Migration check failed (non-critical if fresh install):", migErr.message);
  }

  console.log("[DB] Turso ready at", process.env.TURSO_URL);
}

initSchema().catch(err => {
  console.error("[DB] Schema init failed:", err);
  process.exit(1);
});

// ─── ROW HELPER ───────────────────────────────────────────────────
// Turso rows are array-like objects. Spreading them into a plain {}
// ensures dot-notation access (row.amount, row.email etc.) always works.
function toObj(row) {
  if (!row) return null;
  return Object.fromEntries(
    Object.entries(row).filter(([k]) => !['toJSON', 'columnNames', 'columnOrigins'].includes(k))
  );
}

// ─── HELPERS ──────────────────────────────────────────────────────
const db_helpers = {
  db,

  async createSubmission(data) {
    await db.execute({
      sql: `INSERT INTO submissions
              (id, name, email, level, currency, amount, file_count, file_names, country_code, ip_address, extracted_text)
            VALUES
              (:id, :name, :email, :level, :currency, :amount, :file_count, :file_names, :country_code, :ip_address, :extracted_text)`,
      args: data,
    });
  },

  async createTransaction(data) {
    await db.execute({
      sql: `INSERT INTO transactions (id, submission_id, paystack_ref, amount, currency)
            VALUES (:id, :submission_id, :paystack_ref, :amount, :currency)`,
      args: data,
    });
  },

  async getSubmissionById(id) {
    const result = await db.execute({
      sql: "SELECT * FROM submissions WHERE id = ?",
      args: [id],
    });
    return toObj(result.rows[0]) || null;
  },

  async getTransactionByRef(ref) {
    const result = await db.execute({
      sql: "SELECT * FROM transactions WHERE (paystack_ref = ? COLLATE NOCASE) OR (paystack_internal_ref = ? COLLATE NOCASE)",
      args: [ref, ref],
    });
    return toObj(result.rows[0]) || null;
  },

  async getTransactionBySubmission(submissionId) {
    const result = await db.execute({
      sql: "SELECT * FROM transactions WHERE submission_id = ? ORDER BY created_at DESC LIMIT 1",
      args: [submissionId],
    });
    return toObj(result.rows[0]) || null;
  },

  async hasSuccessfulPayment(submissionId) {
    const result = await db.execute({
      sql: "SELECT id FROM transactions WHERE submission_id = ? AND status = 'success'",
      args: [submissionId],
    });
    return result.rows.length > 0;
  },

  async updateTransactionSuccess(ref, paystackData) {
    const internalRef = paystackData.reference; // Paystack's returned ref (might be T...)
    await db.execute({
      sql: `UPDATE transactions
            SET status = 'success', 
                paystack_data = ?, 
                paystack_internal_ref = ?,
                verified_at = CURRENT_TIMESTAMP
            WHERE paystack_ref = ? OR paystack_internal_ref = ?`,
      args: [JSON.stringify(paystackData), internalRef, ref, ref],
    });
    await db.execute({
      sql: `UPDATE submissions SET status = 'paid'
            WHERE id = (SELECT submission_id FROM transactions WHERE paystack_ref = ? OR paystack_internal_ref = ?)`,
      args: [ref, ref],
    });
  },

  async updateTransactionFailed(ref) {
    await db.execute({
      sql: "UPDATE transactions SET status = 'failed' WHERE paystack_ref = ?",
      args: [ref],
    });
    await db.execute({
      sql: `UPDATE submissions SET status = 'failed'
            WHERE id = (SELECT submission_id FROM transactions WHERE paystack_ref = ?)`,
      args: [ref],
    });
  },

  async createReview(data) {
    await db.execute({
      sql: `INSERT INTO reviews (id, submission_id, transaction_id, result_json, token)
            VALUES (:id, :submission_id, :transaction_id, :result_json, :token)`,
      args: data,
    });
    await db.execute({
      sql: "UPDATE submissions SET status = 'reviewed' WHERE id = ?",
      args: [data.submission_id],
    });
  },

  async getReviewByToken(token) {
    const result = await db.execute({
      sql: `SELECT r.*, s.name, s.email, s.level, s.file_names
            FROM reviews r
            JOIN submissions s ON s.id = r.submission_id
            WHERE r.token = ?`,
      args: [token],
    });
    return toObj(result.rows[0]) || null;
  },

  async getReviewBySubmissionId(submissionId) {
    const result = await db.execute({
      sql: `SELECT r.*, s.name, s.email, s.level, s.file_names
            FROM reviews r
            JOIN submissions s ON s.id = r.submission_id
            WHERE r.submission_id = ?
            ORDER BY r.created_at DESC LIMIT 1`,
      args: [submissionId],
    });
    return toObj(result.rows[0]) || null;
  },
};

module.exports = db_helpers;