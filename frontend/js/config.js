/**
 * config.js — loaded before app.js
 *
 * API_BASE is intentionally empty.
 * Vercel's vercel.json proxies all /api/* requests to the Render backend,
 * so relative paths work transparently from the browser.
 *
 * If you ever host frontend + backend on the same Render service,
 * this stays empty and it still works.
 *
 * Only set a full URL here if you're testing locally against a deployed backend:
 *   const API_BASE = "https://scholarmark.onrender.com";
 */
const API_BASE = "";