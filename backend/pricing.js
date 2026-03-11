/**
 * pricing.js — ScholarMark
 *
 * KES-only. Fixed prices — no currency conversion.
 * Paystack KES amounts are in cents (×100).
 */

// ─── FIXED KES PRICES ─────────────────────────────────────────────
const KES_PRICES = {
  "Level 7": 1500,
  "Level 8": 2500,
  "Level 9": 3500,
  "Level 10": 5000,
};

// ─── CURRENCY CONFIG ──────────────────────────────────────────────
// Kept broad so existing server.js references don't break
const CURRENCY_CONFIG = {
  KES: { symbol: "KES", name: "Kenyan Shillings", decimals: 0, paystackMinor: 100 },
};

// ─── COUNTRY → CURRENCY ───────────────────────────────────────────
const COUNTRY_CURRENCY = {};  // unused — everyone gets KES

function getCurrencyForCountry(countryCode) {
  return "KES";
}

// ─── PRICING ──────────────────────────────────────────────────────
async function getPricingForCurrency(currency) {
  // Always return fixed KES prices — ignore currency argument
  const pricing = {};
  for (const [level, kes] of Object.entries(KES_PRICES)) {
    pricing[level] = {
      currency: "KES",
      symbol: "KES",
      amount: kes,
      minor: kes * 100,          // e.g. 1500 × 100 = 150000 for Paystack
      display: kes.toLocaleString("en-KE"),
      formatted: `KES ${kes.toLocaleString("en-KE")}`,
      name: "Kenyan Shillings",
    };
  }
  return pricing;
}

// Kept so nothing breaks if server.js calls it
async function convertPrice(gbpPence, targetCurrency) {
  const level = Object.entries({ "Level 7": 700, "Level 8": 1200, "Level 9": 1800, "Level 10": 2500 })
    .find(([, p]) => p === gbpPence)?.[0];
  const kes = level ? KES_PRICES[level] : 50;
  return {
    currency: "KES", symbol: "KES", amount: kes,
    minor: kes * 100, display: kes.toLocaleString("en-KE"),
    formatted: `KES ${kes.toLocaleString("en-KE")}`, name: "Kenyan Shillings",
  };
}

module.exports = {
  CURRENCY_CONFIG,
  COUNTRY_CURRENCY,
  BASE_PRICES_GBP: { "Level 7": 700, "Level 8": 1200, "Level 9": 1800, "Level 10": 2500 },
  getCurrencyForCountry,
  convertPrice,
  getPricingForCurrency,
};