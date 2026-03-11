/**
 * config.js — ScholarMark Frontend Configuration
 * Loaded BEFORE app.js in index.html
 */

// Determine API base URL based on environment
const getAPIBase = () => {
    const hostname = window.location.hostname;

    // Local development
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return 'http://localhost:3000';
    }

    // Production - Render backend
    if (hostname.includes('vercel.app') || hostname.includes('scholarmark.co.ke')) {
        return 'https://scholarmark.onrender.com';
    }

    // If frontend is hosted on Render itself
    if (hostname.includes('onrender.com')) {
        return 'https://' + hostname;
    }

    // Default fallback
    return 'https://scholarmark.onrender.com';
};

const API_BASE = getAPIBase();

// Log for debugging (remove in production if desired)
console.log('[Config] API_BASE:', API_BASE);
console.log('[Config] Current Host:', window.location.hostname);

// Expose globally for app.js
window.API_BASE = API_BASE;