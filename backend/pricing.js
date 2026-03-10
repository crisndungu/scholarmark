/**
 * pricing.js — Location-based currency detection & pricing
 *
 * Base prices in GBP:
 *   Level 7  → £7
 *   Level 8  → £12
 *   Level 9  → £18
 *   Level 10 → £25
 *
 * Currency is detected from the user's IP address country.
 * Supported currencies: GBP, USD, EUR, KES, NGN, ZAR, GHS, UGX, TZS
 */

// ─── BASE PRICES (in GBP, minor units = pence) ─────────────────────
const BASE_PRICES_GBP = {
  "Level 7": 700,   // £7.00
  "Level 8": 1200,  // £12.00
  "Level 9": 1800,  // £18.00
  "Level 10": 2500,  // £25.00
};

// ─── COUNTRY → CURRENCY MAP ────────────────────────────────────────
const COUNTRY_CURRENCY = {
  // UK
  GB: "GBP",
  // Eurozone
  DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", NL: "EUR", BE: "EUR", AT: "EUR",
  PT: "EUR", IE: "EUR", FI: "EUR", GR: "EUR", LU: "EUR", MT: "EUR", CY: "EUR",
  SK: "EUR", SI: "EUR", EE: "EUR", LV: "EUR", LT: "EUR",
  // US & territories
  US: "USD", PR: "USD", GU: "USD",
  // Canada
  CA: "CAD",
  // Australia
  AU: "AUD",
  // East Africa
  KE: "KES", UG: "UGX", TZ: "TZS", RW: "RWF", ET: "ETB",
  // West Africa
  NG: "NGN", GH: "GHS", SL: "SLL", LR: "LRD", GM: "GMD",
  // South Africa
  ZA: "ZAR",
  // Rest of Africa
  EG: "EGP", MA: "MAD", TN: "TND", DZ: "DZD", ZM: "ZMW", ZW: "ZWL",
  // Asia
  IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", NP: "NPR",
  // Middle East
  AE: "AED", SA: "SAR", QA: "QAR", KW: "KWD",
};

// ─── EXCHANGE RATES (GBP base, fallback hardcoded) ─────────────────
// These are approximate — refresh via API in production
const FALLBACK_RATES = {
  GBP: 1.0,
  USD: 1.27,
  EUR: 1.18,
  CAD: 1.72,
  AUD: 1.94,
  KES: 164.0,
  UGX: 4720.0,
  TZS: 3250.0,
  RWF: 1380.0,
  ETB: 70.0,
  NGN: 2000.0,
  GHS: 15.5,
  ZAR: 23.5,
  EGP: 62.0,
  MAD: 12.7,
  INR: 106.0,
  AED: 4.67,
  SAR: 4.77,
};

// ─── CURRENCY CONFIG ───────────────────────────────────────────────
const CURRENCY_CONFIG = {
  GBP: { symbol: "£", name: "British Pounds", decimals: 2, paystackMinor: 100 },
  USD: { symbol: "$", name: "US Dollars", decimals: 2, paystackMinor: 100 },
  EUR: { symbol: "€", name: "Euros", decimals: 2, paystackMinor: 100 },
  CAD: { symbol: "CA$", name: "Canadian Dollars", decimals: 2, paystackMinor: 100 },
  AUD: { symbol: "A$", name: "Australian Dollars", decimals: 2, paystackMinor: 100 },
  KES: { symbol: "KES", name: "Kenyan Shillings", decimals: 0, paystackMinor: 100 },
  UGX: { symbol: "UGX", name: "Ugandan Shillings", decimals: 0, paystackMinor: 100 },
  TZS: { symbol: "TZS", name: "Tanzanian Shillings", decimals: 0, paystackMinor: 100 },
  NGN: { symbol: "₦", name: "Nigerian Naira", decimals: 0, paystackMinor: 100 },
  GHS: { symbol: "₵", name: "Ghanaian Cedis", decimals: 2, paystackMinor: 100 },
  ZAR: { symbol: "R", name: "South African Rand", decimals: 2, paystackMinor: 100 },
  EGP: { symbol: "EGP", name: "Egyptian Pounds", decimals: 2, paystackMinor: 100 },
  INR: { symbol: "₹", name: "Indian Rupees", decimals: 2, paystackMinor: 100 },
  AED: { symbol: "AED", name: "UAE Dirhams", decimals: 2, paystackMinor: 100 },
};

// Live exchange rates cache (refreshed every hour)
let ratesCache = { rates: FALLBACK_RATES, lastFetched: 0 };

async function getLiveRates() {
  const now = Date.now();
  const ONE_HOUR = 60 * 60 * 1000;

  if (now - ratesCache.lastFetched < ONE_HOUR) return ratesCache.rates;

  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  if (!apiKey) return FALLBACK_RATES;

  try {
    const fetch = require("node-fetch");
    const res = await fetch(`https://api.exchangeratesapi.io/v1/latest?access_key=${apiKey}&base=GBP`);
    if (!res.ok) throw new Error("Rate API error");
    const data = await res.json();
    ratesCache = { rates: data.rates, lastFetched: now };
    return data.rates;
  } catch (e) {
    console.warn("[Pricing] Live rates unavailable, using fallback:", e.message);
    return FALLBACK_RATES;
  }
}

/**
 * Convert GBP minor units to target currency minor units (for Paystack)
 */
async function convertPrice(gbpPence, targetCurrency) {
  const rates = await getLiveRates();
  const rate = rates[targetCurrency] || rates.USD;
  const config = CURRENCY_CONFIG[targetCurrency] || CURRENCY_CONFIG.USD;

  // Convert from pence → pounds → target currency → target minor units
  const targetAmount = (gbpPence / 100) * rate;
  const minor = Math.round(targetAmount * config.paystackMinor);

  // Format display
  const display = config.decimals === 0
    ? Math.round(targetAmount).toLocaleString()
    : targetAmount.toFixed(config.decimals);

  return {
    currency: targetCurrency,
    minor,          // amount to send to Paystack
    display,        // e.g. "1,234" or "12.50"
    symbol: config.symbol,
    formatted: `${config.symbol}${display}`,
    name: config.name,
  };
}

/**
 * Get currency from country code
 */
function getCurrencyForCountry(countryCode) {
  return "KES";  // ✅ KES only for everyone
}

/**
 * Get full pricing for a given currency
 */
async function getPricingForCurrency(currency) {
  const pricing = {};
  for (const [level, pence] of Object.entries(BASE_PRICES_GBP)) {
    pricing[level] = await convertPrice(pence, currency);
  }
  return pricing;
}

module.exports = {
  BASE_PRICES_GBP,
  CURRENCY_CONFIG,
  COUNTRY_CURRENCY,
  getCurrencyForCountry,
  convertPrice,
  getPricingForCurrency,
};
