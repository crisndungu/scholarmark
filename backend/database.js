/**
 * database.js — SQLite schema and helpers
 *
 * Tables:
 *   submissions  — every upload attempt
 *   transactions — payment records (linked to submissions)
 *   reviews      — completed AI review results
 *
 * Why SQLite?
 *   - Zero cost, zero setup, file-based
 *   - Perfectly adequate for thousands of daily submissions
 *   - Easy to migrate to PostgreSQL later if needed
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const DB_PATH = process.env.DB_PATH || "./data/scholarmark.db";

// Ensure data directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// Performance pragmas
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

// ─── SCHEMA ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id            TEXT PRIMARY KEY,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL,
    level         TEXT NOT NULL,
    currency      TEXT NOT NULL,
    amount        INTEGER NOT NULL,
    file_count    INTEGER NOT NULL,
    file_names    TEXT NOT NULL,      -- JSON array of filenames
    country_code  TEXT,
    ip_address    TEXT,
    status        TEXT DEFAULT 'pending'  -- pending | paid | reviewed | failed
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id              TEXT PRIMARY KEY,
    submission_id   TEXT NOT NULL REFERENCES submissions(id),
    paystack_ref    TEXT UNIQUE NOT NULL,
    amount          INTEGER NOT NULL,
    currency        TEXT NOT NULL,
    status          TEXT DEFAULT 'pending',  -- pending | success | failed
    paystack_data   TEXT,                    -- full JSON response from Paystack
    verified_at     DATETIME,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id              TEXT PRIMARY KEY,
    submission_id   TEXT NOT NULL REFERENCES submissions(id),
    transaction_id  TEXT NOT NULL REFERENCES transactions(id),
    result_json     TEXT NOT NULL,           -- full AI review as JSON
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    token           TEXT UNIQUE NOT NULL     -- secure one-time access token
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_email    ON submissions(email);
  CREATE INDEX IF NOT EXISTS idx_transactions_ref     ON transactions(paystack_ref);
  CREATE INDEX IF NOT EXISTS idx_transactions_sub     ON transactions(submission_id);
  CREATE INDEX IF NOT EXISTS idx_reviews_token        ON reviews(token);
  CREATE INDEX IF NOT EXISTS idx_reviews_sub          ON reviews(submission_id);
`);

// ─── HELPERS ───────────────────────────────────────────────────────

const db_helpers = {
  db,

  createSubmission(data) {
    const stmt = db.prepare(`
      INSERT INTO submissions (id, name, email, level, currency, amount, file_count, file_names, country_code, ip_address)
      VALUES (@id, @name, @email, @level, @currency, @amount, @file_count, @file_names, @country_code, @ip_address)
    `);
    stmt.run(data);
  },

  createTransaction(data) {
    const stmt = db.prepare(`
      INSERT INTO transactions (id, submission_id, paystack_ref, amount, currency)
      VALUES (@id, @submission_id, @paystack_ref, @amount, @currency)
    `);
    stmt.run(data);
  },

  getTransactionByRef(ref) {
    return db.prepare("SELECT * FROM transactions WHERE paystack_ref = ?").get(ref);
  },

  updateTransactionSuccess(ref, paystackData) {
    db.prepare(`
      UPDATE transactions
      SET status = 'success', paystack_data = ?, verified_at = CURRENT_TIMESTAMP
      WHERE paystack_ref = ?
    `).run(JSON.stringify(paystackData), ref);

    db.prepare(`
      UPDATE submissions SET status = 'paid'
      WHERE id = (SELECT submission_id FROM transactions WHERE paystack_ref = ?)
    `).run(ref);
  },

  updateTransactionFailed(ref) {
    db.prepare("UPDATE transactions SET status = 'failed' WHERE paystack_ref = ?").run(ref);
    db.prepare(`
      UPDATE submissions SET status = 'failed'
      WHERE id = (SELECT submission_id FROM transactions WHERE paystack_ref = ?)
    `).run(ref);
  },

  createReview(data) {
    db.prepare(`
      INSERT INTO reviews (id, submission_id, transaction_id, result_json, token)
      VALUES (@id, @submission_id, @transaction_id, @result_json, @token)
    `).run(data);

    db.prepare("UPDATE submissions SET status = 'reviewed' WHERE id = ?")
      .run(data.submission_id);
  },

  getReviewByToken(token) {
    return db.prepare(`
      SELECT r.*, s.name, s.email, s.level, s.file_names
      FROM reviews r
      JOIN submissions s ON s.id = r.submission_id
      WHERE r.token = ?
    `).get(token);
  },

  getSubmissionById(id) {
    return db.prepare("SELECT * FROM submissions WHERE id = ?").get(id);
  },

  getTransactionBySubmission(submissionId) {
    return db.prepare("SELECT * FROM transactions WHERE submission_id = ? AND status = 'success' LIMIT 1").get(submissionId);
  },

  // Prevent double charges — check if a submission already has a successful payment
  hasSuccessfulPayment(submissionId) {
    const t = db.prepare("SELECT id FROM transactions WHERE submission_id = ? AND status = 'success'").get(submissionId);
    return !!t;
  }
};

console.log(`[DB] SQLite ready at ${path.resolve(DB_PATH)}`);
module.exports = db_helpers;
