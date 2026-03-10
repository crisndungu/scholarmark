/**
 * app.js — ScholarMark Frontend
 *
 * All API keys live on the server. This file only talks to our own backend.
 * Paystack public key is fetched from /api/pubkey on load.
 */

// ─── STATE ────────────────────────────────────────────────────────
const S = {
  step: "upload",   // upload | payment | processing | results
  files: [],
  level: "Level 7",
  name: "",
  email: "",
  currency: "USD",
  prices: {},
  country: "US",
  submissionId: null,
  paystackKey: null,
  reviewToken: null,
  review: null,
  progress: 0,
};


const MAX_FILES = 10;

const LEVEL_DATA = {
  "Level 7": { short: "Master's", sub: "Postgraduate Taught", criteria: ["Critical Analysis", "Research Methodology", "Theoretical Frameworks", "Academic Writing", "Argument Coherence"] },
  "Level 8": { short: "Doctoral", sub: "PhD / Professional Doctorate", criteria: ["Original Contribution", "Research Design Rigour", "Literature Synthesis", "Theoretical Innovation", "Scholarly Impact"] },
  "Level 9": { short: "Post-Doctoral", sub: "Advanced Research & Fellowship", criteria: ["Field-Leading Insight", "Interdisciplinary Synthesis", "Publication Readiness", "Grant Narrative", "Methodological Mastery"] },
  "Level 10": { short: "Expert", sub: "Expert & Professorial Practice", criteria: ["Paradigm Contribution", "Global Scholarly Relevance", "Policy Implications", "Pedagogical Value", "Legacy Impact"] },
};

// ─── VALIDATION HELPERS ───────────────────────────────────────────

function validateName(raw) {
  const val = raw.trim();
  if (val.length < 2) return "Please enter your full name or student ID.";
  if (/\d/.test(val)) {
    if (val.length < 4) return "Student ID must be at least 4 characters.";
    return null;
  }
  if (!/^[a-zA-ZÀ-ÿ'\-\. ]+$/.test(val)) {
    return "Name should only contain letters, hyphens, and apostrophes. No numbers or special characters.";
  }
  if ((val.match(/[a-zA-ZÀ-ÿ]/g) || []).length < 2) {
    return "Please enter a valid name.";
  }
  return null;
}

function validateEmail(raw) {
  const val = raw.trim().toLowerCase();
  if (!val) return "Please enter your email address.";
  if (val.includes(" ")) return "Email address cannot contain spaces.";
  if ((val.match(/@/g) || []).length !== 1) return "Please enter a valid email address (e.g. name@gmail.com).";

  const [local, domain] = val.split("@");
  if (!local || local.length < 1) return "Please enter a valid email address.";
  if (local.length > 64) return "Email address is too long.";
  if (!/^[a-z0-9._%+\-]+$/.test(local)) return "The part before @ contains invalid characters.";
  if (local.startsWith(".") || local.endsWith(".")) return "Email address cannot start or end with a dot before the @.";
  if (!domain) return "Please include the domain (e.g. @gmail.com).";
  if (!domain.includes(".")) return "Email domain looks incomplete — did you mean @gmail.com or @yahoo.com?";

  const domainParts = domain.split(".");
  if (domainParts.some(p => p.length === 0)) return "Please enter a valid email domain.";

  const tld = domainParts[domainParts.length - 1];
  if (tld.length < 2 || tld.length > 10) return "The email domain ending looks incorrect (e.g. .com, .co.ke, .ac.uk).";
  if (!/^[a-z0-9.\-]+$/.test(domain)) return "Email domain contains invalid characters.";

  const typos = {
    "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com",
    "gmail.co": "gmail.com", "gmail.cm": "gmail.com", "yaho.com": "yahoo.com",
    "yahooo.com": "yahoo.com", "yahoo.co": "yahoo.com", "hotmial.com": "hotmail.com",
    "hotmail.co": "hotmail.com", "outlok.com": "outlook.com", "outllok.com": "outlook.com",
  };
  if (typos[domain]) return `Did you mean @${typos[domain]}? Please check your email address.`;

  return null;
}

// ─── INLINE FIELD ERROR DISPLAY ──────────────────────────────────
function setFieldError(inputId, message) {
  const input = document.getElementById(inputId);
  if (!input) return;
  clearFieldError(inputId);
  if (message) {
    input.style.borderColor = "#ef4444";
    input.style.boxShadow = "0 0 0 3px rgba(239,68,68,0.1)";
    const errEl = document.createElement("div");
    errEl.className = "field-err";
    errEl.id = inputId + "_err";
    errEl.style.cssText = "font-size:0.72rem;color:#b91c1c;margin-top:5px;font-family:var(--sans);display:flex;align-items:center;gap:4px;";
    errEl.innerHTML = `<span style="font-size:0.8rem">⚠</span> ${message}`;
    input.parentElement.appendChild(errEl);
  } else {
    input.style.borderColor = "#22c55e";
    input.style.boxShadow = "0 0 0 3px rgba(34,197,94,0.1)";
  }
}

function clearFieldError(inputId) {
  const input = document.getElementById(inputId);
  const errEl = document.getElementById(inputId + "_err");
  if (input) { input.style.borderColor = ""; input.style.boxShadow = ""; }
  if (errEl) errEl.remove();
}

// ─── INIT ─────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  S.prices = {
    "Level 7": { formatted: "$10", minor: 1000, currency: "USD" },
    "Level 8": { formatted: "$18", minor: 1800, currency: "USD" },
    "Level 9": { formatted: "$26", minor: 2600, currency: "USD" },
    "Level 10": { formatted: "$36", minor: 3600, currency: "USD" },
  };

  setupNav();
  setupFAQ();
  setupMarquee();
  setupCounters();
  setupReveal();
  setupHeroParticles();
  setupHeroCardFloat();
  setupHeroCursor();

  renderWidget();

  loadLocationAndPricing().then(() => {
    updatePricingUI();
    if (S.step === "upload") renderWidget();
  });
  loadPaystackKey();
});

// ─── LOAD PAYSTACK KEY FROM SERVER ────────────────────────────────
async function loadPaystackKey() {
  try {
    const res = await fetch(`${API_BASE}/api/pubkey`);
    const data = await res.json();
    S.paystackKey = data.key;
  } catch (e) {
    console.error("Could not load payment config:", e);
  }
}

// ─── LOAD LOCATION & PRICING ──────────────────────────────────────
async function loadLocationAndPricing() {
  try {
    const res = await fetch(`${API_BASE}/api/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    if (data.success) {
      S.country = data.country;
      S.currency = data.currency;
      S.prices = data.prices;
      updatePricingUI();
    }
  } catch (e) {
    console.warn("Location detection failed, using USD fallback");
    S.prices = {
      "Level 7": { formatted: "$10", minor: 1000, currency: "USD" },
      "Level 8": { formatted: "$18", minor: 1800, currency: "USD" },
      "Level 9": { formatted: "$26", minor: 2600, currency: "USD" },
      "Level 10": { formatted: "$36", minor: 3600, currency: "USD" },
    };
  }
}

function updatePricingUI() {
  document.querySelectorAll("[data-price-level]").forEach(el => {
    const level = el.dataset.priceLevel;
    if (S.prices[level]) el.textContent = S.prices[level].formatted;
  });
  document.querySelectorAll(".lo-p").forEach(el => {
    const level = el.closest("[data-level]")?.dataset.level;
    if (level && S.prices[level]) el.textContent = S.prices[level].formatted;
  });
}

// ─── FILE HELPERS ─────────────────────────────────────────────────
function fileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  if (ext === "pdf") return "📕";
  if (ext === "doc" || ext === "docx") return "📘";
  if (ext === "txt") return "📄";
  return "📎";
}

function inferRole(file, index) {
  if (index === 0) return "Main document";
  const n = file.name.toLowerCase();
  if (/guideline|rubric|brief|instruction|marking|assessment/.test(n)) return "Guidelines";
  if (/appendix|appendices/.test(n)) return "Appendix";
  if (/abstract/.test(n)) return "Abstract";
  if (/chapter/.test(n)) return "Chapter";
  return "Supporting doc";
}

// ─── WIDGET RENDER ENGINE ─────────────────────────────────────────
function renderWidget() {
  const titles = {
    upload: "Begin Your Submission",
    payment: "Confirm & Pay",
    processing: "Reviewing Your Work…",
    results: "Your Review Report",
  };
  const el = document.getElementById("widgetTitle");
  if (el) el.textContent = titles[S.step];

  syncDots();

  const body = document.getElementById("widgetBody");
  if (!body) return;

  const renders = { upload: renderUpload, payment: renderPayment, processing: renderProcessing, results: renderResults };
  body.innerHTML = renders[S.step]();

  if (S.step === "upload") bindUpload();
  if (S.step === "results") updatePricingUI();
}

function syncDots() {
  const order = ["upload", "payment", "processing", "results"];
  const idx = order.indexOf(S.step);
  order.forEach((_, i) => {
    const d = document.getElementById("wd" + i);
    if (d) d.className = "wdot" + (i === idx ? " active" : i < idx ? " done" : "");
  });
}

// ─── UPLOAD VIEW ──────────────────────────────────────────────────
function renderUpload() {
  const priceForLevel = S.prices[S.level]?.formatted || "…";
  return `
<div class="err-box" id="errBox"></div>
<div class="f">
  <label for="nameIn">Your Full Name or Student ID</label>
  <input id="nameIn" type="text"
    placeholder="e.g. Jane Mwangi  or  STU-2024-001"
    value="${esc(S.name)}"
    autocomplete="name"
    maxlength="200"
    oninput="liveValidateName(this)"
    onblur="liveValidateName(this)" />
  <div class="field-hint">Letters, hyphens and apostrophes only — or your student ID</div>
</div>
<div class="f">
  <label>Academic Level <span class="field-note">— price shown in your local currency</span></label>
  <div class="lvl-grid">
    ${Object.keys(LEVEL_DATA).map(k => `
    <div class="lvl-opt${S.level === k ? " sel" : ""}" data-level="${k}"
      onclick="pickLevel('${k}')" role="radio" aria-checked="${S.level === k}" tabindex="0"
      onkeydown="if(event.key==='Enter'||event.key===' ')pickLevel('${k}')">
      <div class="lo-n">${k} — ${LEVEL_DATA[k].short}</div>
      <div class="lo-p">${S.prices[k]?.formatted || "…"}</div>
    </div>`).join("")}
  </div>
</div>
<div class="f">
  <label>Documents <span class="field-note">(main work + any guidelines, rubrics, marking briefs)</span></label>
  <div class="dropzone${S.files.length >= MAX_FILES ? " at-limit" : ""}" id="dz"
    onclick="${S.files.length < MAX_FILES ? "document.getElementById('fi').click()" : ""}"
    role="button" tabindex="0" aria-label="Upload documents"
    onkeydown="if(event.key==='Enter'||event.key===' ')document.getElementById('fi').click()">
    <span class="dz-i">📁</span>
    <div class="dz-t">${S.files.length >= MAX_FILES ? "Maximum files reached" : "Drop files here or click to browse"}</div>
    <div class="dz-s">PDF · DOC · DOCX · TXT — up to 10MB each</div>
    <span class="dz-pill">${S.files.length} / ${MAX_FILES} files</span>
  </div>
  <input type="file" id="fi" style="display:none" accept=".txt,.pdf,.doc,.docx" multiple />
  ${S.files.length > 0 ? `
  <div class="file-list">
    ${S.files.map((f, i) => `
    <div class="file-item">
      <div class="fi-ico">${fileIcon(f.name)}</div>
      <div class="fi-info">
        <div class="fi-name">${esc(f.name)}</div>
        <div class="fi-size">${(f.size / 1024).toFixed(0)} KB</div>
      </div>
      <div class="fi-role">${inferRole(f, i)}</div>
      <button class="fi-rm" onclick="removeFile(${i})" aria-label="Remove ${esc(f.name)}" type="button">✕</button>
    </div>`).join("")}
  </div>
  <div class="file-count">${S.files.length} file${S.files.length !== 1 ? "s" : ""} ready${S.files.length < MAX_FILES ? " — you may add more" : ""}</div>
  ` : ""}
</div>
<button class="btn-w" type="button" ${S.files.length === 0 ? "disabled" : ""} onclick="toPayment()">
  Continue — ${priceForLevel}
</button>`;
}

// ─── LIVE VALIDATION ─────────────────────────────────────────────
function liveValidateName(input) {
  const err = validateName(input.value);
  setFieldError("nameIn", err);
}

function liveValidateEmail(input) {
  const err = validateEmail(input.value);
  setFieldError("emailIn", err);
}

function bindUpload() {
  const fi = document.getElementById("fi");
  const dz = document.getElementById("dz");
  if (fi) fi.onchange = e => addFiles(Array.from(e.target.files));
  if (dz) {
    dz.ondragover = e => { e.preventDefault(); dz.classList.add("over"); };
    dz.ondragleave = () => dz.classList.remove("over");
    dz.ondrop = e => { e.preventDefault(); dz.classList.remove("over"); addFiles(Array.from(e.dataTransfer.files)); };
  }
}

function addFiles(newFiles) {
  // Persist whatever the user has typed before re-rendering
  S.name = document.getElementById("nameIn")?.value.trim() || S.name;
  for (const f of newFiles) {
    if (S.files.length >= MAX_FILES) { showErr(`Maximum ${MAX_FILES} files allowed.`); break; }
    if (f.size > 10 * 1024 * 1024) { showErr(`"${f.name}" exceeds 10MB.`); continue; }
    if (!/\.(pdf|doc|docx|txt)$/i.test(f.name)) { showErr(`"${f.name}" is not a supported format.`); continue; }
    if (S.files.find(x => x.name === f.name && x.size === f.size)) continue;
    S.files.push(f);
  }
  renderWidget();
}

function removeFile(idx) {
  S.name = document.getElementById("nameIn")?.value.trim() || S.name;
  S.files.splice(idx, 1);
  renderWidget();
}

function pickLevel(lv) {
  S.name = document.getElementById("nameIn")?.value.trim() || S.name;
  S.level = lv;
  renderWidget();
}

async function toPayment() {
  const nm = document.getElementById("nameIn")?.value.trim();
  const nameErr = validateName(nm || "");
  if (nameErr) { setFieldError("nameIn", nameErr); showErr(nameErr); return; }
  if (!S.files.length) return showErr("Please upload at least one document.");
  S.name = nm;

  const btn = document.querySelector(".btn-w");
  if (btn) { btn.disabled = true; btn.textContent = "Uploading…"; }

  try {
    const form = new FormData();
    form.append("name", S.name);
    form.append("email", S.email || "pending@scholarmark.co");
    form.append("level", S.level);
    form.append("currency", S.currency);
    S.files.forEach(f => form.append("files", f));

    const res = await fetch(`${API_BASE}/api/submission`, { method: "POST", body: form });
    const data = await res.json();

    if (!res.ok || !data.success) return showErr(data.error || "Upload failed. Please try again.");

    S.submissionId = data.submissionId;
    S.step = "payment";
    renderWidget();
  } catch (e) {
    showErr("Network error. Please check your connection and try again.");
  } finally {
    if (btn) { btn.disabled = false; }
  }
}

// ─── PAYMENT VIEW ─────────────────────────────────────────────────
function renderPayment() {
  const price = S.prices[S.level];
  const lv = LEVEL_DATA[S.level];
  return `
<div class="err-box" id="errBox"></div>
<div class="pay-sum">
  <div class="ps-row"><span class="ps-l">Service</span><span class="ps-v">Level ${S.level.split(" ")[1]} — ${lv.short}</span></div>
  <div class="ps-row"><span class="ps-l">Files submitted</span><span class="ps-v">${S.files.length} document${S.files.length !== 1 ? "s" : ""}</span></div>
  <div class="ps-row"><span class="ps-l">Currency</span><span class="ps-v">${S.currency} — auto-detected from your location</span></div>
  <div class="ps-row total-row"><span class="ps-l">Total</span><span class="ps-total">${price?.formatted || "…"}</span></div>
</div>
<div class="f">
  <label for="emailIn">Email address <span class="field-note">— for your receipt &amp; report access</span></label>
  <input id="emailIn" type="email"
    placeholder="e.g. name@gmail.com"
    value="${esc(S.email)}"
    autocomplete="email"
    maxlength="254"
    oninput="liveValidateEmail(this)"
    onblur="liveValidateEmail(this)" />
  <div class="field-hint">We accept all providers — Gmail, Yahoo, Outlook, iCloud, and more</div>
</div>
<p class="pay-note">🔒 Secured by Paystack · M-Pesa, Visa, Mastercard &amp; Bank Transfer · Documents deleted after review</p>
<button class="btn-w" type="button" onclick="doPayment()">
  Pay ${price?.formatted || "…"} — Secure Checkout
</button>
<button class="btn-w-outline" type="button" onclick="S.step='upload';renderWidget()">← Back</button>`;
}

async function doPayment() {
  const em = document.getElementById("emailIn")?.value.trim();
  const emailErr = validateEmail(em || "");
  if (emailErr) { setFieldError("emailIn", emailErr); showErr(emailErr); return; }
  S.email = em;

  if (!S.paystackKey) return showErr("Payment system not ready. Please refresh and try again.");
  if (!S.submissionId) return showErr("Session expired. Please start again.");

  const btn = document.querySelector(".btn-w");
  if (btn) { btn.disabled = true; btn.textContent = "Initialising payment…"; }

  try {
    const initRes = await fetch(`${API_BASE}/api/payment/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ submissionId: S.submissionId }),
    });
    const initData = await initRes.json();

    if (!initRes.ok || !initData.success) {
      return showErr(initData.error || "Payment initialization failed. Please try again.");
    }

    if (!window.PaystackPop) return showErr("Paystack failed to load. Please refresh.");

    window.PaystackPop.resumeTransaction(initData.access_code, {
      onSuccess: async () => {
        S.step = "processing";
        renderWidget();
        await verifyPayment(initData.reference);
      },
      onCancel: () => {
        showErr("Payment was cancelled. Your submission is saved — you can pay again.");
        if (btn) { btn.disabled = false; btn.textContent = `Pay ${S.prices[S.level]?.formatted || "…"} — Secure Checkout`; }
      },
    });
  } catch (e) {
    showErr("Network error. Please check your connection.");
    if (btn) { btn.disabled = false; }
  }
}

// ─── PROCESSING VIEW ──────────────────────────────────────────────
function renderProcessing() {
  const stages = [
    [5, "Receiving your submission"],
    [18, "Reading all uploaded documents"],
    [34, "Cross-referencing guidelines & rubrics"],
    [50, "Evaluating against academic criteria"],
    [67, "Drafting improvement plan"],
    [83, "Compiling your written report"],
  ];
  return `
<div class="proc-wrap" aria-live="polite" aria-label="Review in progress">
  <div class="proc-spin"></div>
  <h3 class="proc-h">Reviewing your submission</h3>
  <p class="proc-sub">Analysing ${S.files.length} document${S.files.length !== 1 ? "s" : ""} against ${S.level} criteria…</p>
  <div class="proc-bar"><div class="proc-fill" id="pFill" style="width:${S.progress}%"></div></div>
  <div class="proc-pct" id="pPct">${Math.round(S.progress)}%</div>
  <div class="proc-steps">
    ${stages.map(([t, lbl]) => `
    <div class="proc-step${S.progress >= t + 15 ? " done" : S.progress >= t ? " active" : ""}" id="ps${t}">
      <div class="ps-d"></div>${lbl}${S.progress >= t + 15 ? " ✓" : ""}
    </div>`).join("")}
  </div>
</div>`;
}

// ─── VERIFY PAYMENT ───────────────────────────────────────────────
async function verifyPayment(reference) {
  S.progress = 8;
  const iv = setInterval(() => {
    if (S.progress < 85) S.progress = Math.min(85, S.progress + Math.random() * 5 + 2);
    updateProgress();
  }, 800);

  try {
    const res = await fetch(`${API_BASE}/api/payment/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference }),
    });
    const data = await res.json();

    clearInterval(iv);

    if (!res.ok || !data.success) {
      S.step = "payment";
      renderWidget();
      showErr(data.error || "Payment verification failed. Please contact support with reference: " + reference);
      return;
    }

    S.reviewToken = data.reviewToken;
    S.progress = 100;
    updateProgress();

    const reviewRes = await fetch(`${API_BASE}/api/review/${data.reviewToken}`);
    const reviewData = await reviewRes.json();

    if (!reviewRes.ok || !reviewData.success) {
      showErr("Review completed but could not be loaded. Please refresh or contact support.");
      return;
    }

    S.review = reviewData.result;
    S.step = "results";
    setTimeout(() => renderWidget(), 400);
  } catch (e) {
    clearInterval(iv);
    S.step = "payment";
    renderWidget();
    showErr("Network error during verification. Please contact support with your payment reference.");
  }
}

function updateProgress() {
  const fill = document.getElementById("pFill");
  const pct = document.getElementById("pPct");
  if (fill) fill.style.width = S.progress + "%";
  if (pct) pct.textContent = Math.round(S.progress) + "%";
  document.querySelectorAll(".proc-step").forEach(el => {
    const t = parseInt(el.id.replace("ps", ""));
    const lbl = el.textContent.replace(" ✓", "").trim();
    el.className = "proc-step" + (S.progress >= t + 15 ? " done" : S.progress >= t ? " active" : "");
    el.innerHTML = `<div class="ps-d"></div>${lbl}${S.progress >= t + 15 ? " ✓" : ""}`;
  });
}

// ─── RESULTS VIEW ─────────────────────────────────────────────────
function renderResults() {
  const r = S.review;
  if (!r) return "<p>No results available.</p>";
  const sc = s => s >= 70 ? "var(--oxford)" : s >= 50 ? "#a16207" : "#b91c1c";
  return `
<div class="res-scroll">
  <div class="res-score-header">
    <div class="res-score-box">
      <div class="rsb-n">${r.overallScore}</div>
      <div class="rsb-d">/ 100</div>
    </div>
    <div class="res-info">
      <h4>${esc(r.grade)}</h4>
      <p>${esc(r.executiveSummary)}</p>
    </div>
  </div>
  <div class="res-blk"><div class="res-lbl">Strengths</div>
    <div class="tags-r">${r.strengths.map(s => `<span class="tg tg-g">✓ ${esc(s)}</span>`).join("")}</div>
  </div>
  <div class="res-blk"><div class="res-lbl">Weaknesses</div>
    <div class="tags-r">${r.criticalWeaknesses.map(w => `<span class="tg tg-r">✗ ${esc(w)}</span>`).join("")}</div>
  </div>
  <div class="res-blk"><div class="res-lbl">Criteria Scores</div>
    <div class="crit-list">
      ${Object.entries(r.criteriaScores).map(([n, d]) => `
      <div>
        <div class="crit-row">
          <div><div class="cr-name">${esc(n)}</div><div class="cr-fb">${esc(d.feedback)}</div></div>
          <div class="cr-score" style="color:${sc(d.score)}">${d.score}</div>
        </div>
        <div class="cr-bar"><div class="cr-fill" style="width:${d.score}%;background:${sc(d.score)}"></div></div>
      </div>`).join("")}
    </div>
  </div>
  <div class="res-blk"><div class="res-lbl">Improvement Plan</div>
    <div class="imp-list">
      ${r.improvementPlan.map(i => `
      <div class="imp-item">
        <span class="imp-pri p${i.priority[0]}">${i.priority}</span>
        <div>
          <div class="imp-area">${esc(i.area)}</div>
          <div class="imp-action">${esc(i.action)} — <em>${esc(i.rationale)}</em></div>
        </div>
      </div>`).join("")}
    </div>
  </div>
  <div class="res-blk"><div class="res-lbl">Resubmission Readiness</div>
    <span class="readiness-v">${esc(r.resubmissionReadiness)}</span>
  </div>
  <div class="res-blk"><div class="res-lbl">Reviewer Commentary</div>
    <div class="reviewer-note">${esc(r.reviewerNotes)}</div>
  </div>
  <button class="btn-w" type="button" onclick="downloadReport()" style="margin-top:4px">
    ↓ Download Full Report (PDF)
  </button>
  <button class="btn-w-outline" type="button" onclick="resetApp()">← Submit Another Document</button>
</div>`;
}

// ─── RESET ────────────────────────────────────────────────────────
function resetApp() {
  S.step = "upload"; S.files = []; S.name = ""; S.email = "";
  S.submissionId = null; S.reviewToken = null; S.review = null; S.progress = 0;
  renderWidget();
}

// ─── PDF REPORT ───────────────────────────────────────────────────
function downloadReport() {
  const r = S.review;
  if (!r) return;
  const sc = s => s >= 70 ? "#1d4ed8" : s >= 50 ? "#a16207" : "#b91c1c";
  const sf = s => s >= 70 ? "#deedf9" : s >= 50 ? "#fef9c3" : "#fee2e2";

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>ScholarMark Report — ${esc(S.name)}</title>
<link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,600;1,400&family=Outfit:wght@300;400;500;600&family=JetBrains+Mono:wght@300;400&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Outfit',sans-serif;background:#fff;color:#1a1a1a;font-size:10.5pt;line-height:1.65}
.cover{background:#002147;color:#f5f5f5;padding:52px 48px;position:relative;overflow:hidden}
.cover::after{content:'';position:absolute;top:-30%;right:-5%;width:400px;height:400px;border-radius:50%;background:radial-gradient(circle,rgba(185,214,242,0.08),transparent 70%)}
.c-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:36px}
.c-brand{font-family:'EB Garamond',serif;font-size:1.1rem;color:rgba(185,214,242,0.5)}
.c-badge{font-family:'JetBrains Mono',monospace;font-size:6.5pt;letter-spacing:0.18em;text-transform:uppercase;color:rgba(185,214,242,0.3);background:rgba(185,214,242,0.07);border:1px solid rgba(185,214,242,0.12);padding:4px 10px;border-radius:2px}
h1{font-family:'EB Garamond',serif;font-size:26pt;font-weight:400;line-height:1.1;color:white;margin-bottom:6px}
h1 em{font-style:italic;color:#b9d6f2}
.c-sub{font-family:'JetBrains Mono',monospace;font-size:7pt;color:rgba(185,214,242,0.3);letter-spacing:0.14em;text-transform:uppercase;margin-bottom:32px}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.mi{border-top:1px solid rgba(185,214,242,0.1);padding-top:11px}
.mi label{font-family:'JetBrains Mono',monospace;font-size:6pt;text-transform:uppercase;letter-spacing:0.18em;opacity:0.35;display:block;margin-bottom:3px}
.mi value{font-size:9.5pt;font-weight:500;display:block;color:#e8f2fb}
.sb{display:flex;align-items:center;gap:22px;padding:22px 48px;background:#f0f7fd;border-bottom:2px solid #deedf9}
.ss{width:76px;height:76px;border:2px solid #002147;background:${sf(r.overallScore)};display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:4px;flex-shrink:0}
.sn{font-family:'EB Garamond',serif;font-size:24pt;color:${sc(r.overallScore)};line-height:1}
.sd{font-family:'JetBrains Mono',monospace;font-size:6.5pt;color:#8a8680}
.si h2{font-family:'EB Garamond',serif;font-size:16pt;color:#002147;font-style:italic;margin-bottom:5px}
.si p{font-size:8.5pt;color:#555;line-height:1.7;max-width:500px}
.sec{padding:20px 48px;border-bottom:1px solid #e8e4df}
.sec h3{font-family:'EB Garamond',serif;font-size:11pt;color:#002147;font-style:italic;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.sec h3::after{content:'';flex:1;height:1px;background:#e8e4df}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tg{padding:3px 9px;border-radius:100px;font-size:7.5pt}
.tg-g{background:#dcfce7;color:#15803d;border:1px solid #86efac}
.tg-r{background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5}
.cg{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.ci{border:1px solid #e8e4df;padding:11px;border-radius:3px}
.cn{font-family:'JetBrains Mono',monospace;font-size:6.5pt;text-transform:uppercase;letter-spacing:0.1em;color:#8a8680;margin-bottom:2px}
.cs{font-family:'EB Garamond',serif;font-size:17pt;color:${sc(r.overallScore)};line-height:1}
.bar{height:2px;background:#e8e4df;border-radius:1px;margin:4px 0}
.bf{height:2px;border-radius:1px}
.cf{font-size:8pt;color:#555;line-height:1.55}
table{width:100%;border-collapse:collapse}
th{background:#002147;color:#f0f7fd;padding:7px 11px;text-align:left;font-family:'JetBrains Mono',monospace;font-size:6.5pt;letter-spacing:0.1em;text-transform:uppercase}
td{padding:8px 11px;border-bottom:1px solid #f0f0ec;font-size:8.5pt;vertical-align:top}
tr:nth-child(even) td{background:#fafaf8}
.pb{padding:2px 6px;border-radius:2px;font-family:'JetBrains Mono',monospace;font-size:6.5pt;font-weight:700}
.pH{background:#fee2e2;color:#b91c1c}.pM{background:#fef9c3;color:#a16207}.pL{background:#dcfce7;color:#15803d}
.rb{display:inline-block;background:#deedf9;border:1px solid #b9d6f2;color:#002147;padding:5px 14px;border-radius:3px;font-size:9pt;font-weight:500}
.note{border-left:3px solid #002147;padding:13px 16px;background:#f0f7fd;font-family:'EB Garamond',serif;font-style:italic;color:#2c2c2c;line-height:1.8;font-size:9.5pt}
ul.rl{list-style:none}
ul.rl li{padding:6px 11px 6px 22px;background:#fafaf8;border-radius:2px;font-size:8.5pt;color:#555;position:relative;margin-bottom:4px}
ul.rl li::before{content:"→";position:absolute;left:7px;color:#002147}
.footer{background:#002147;color:rgba(185,214,242,0.2);text-align:center;padding:11px;font-family:'JetBrains Mono',monospace;font-size:6.5pt;letter-spacing:0.1em}
@media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<div class="cover">
  <div class="c-top"><div class="c-brand">ScholarMark</div><div class="c-badge">Academic Review Report</div></div>
  <h1>Academic Review &<br/><em>Improvement Report</em></h1>
  <div class="c-sub">Confidential · For academic improvement purposes only</div>
  <div class="meta">
    <div class="mi"><label>Author</label><value>${esc(S.name || "—")}</value></div>
    <div class="mi"><label>Documents submitted</label><value>${S.files.length} file${S.files.length !== 1 ? "s" : ""}</value></div>
    <div class="mi"><label>Academic Level</label><value>${esc(S.level)} — ${esc(LEVEL_DATA[S.level]?.sub || "")}</value></div>
    <div class="mi"><label>Date</label><value>${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</value></div>
  </div>
</div>
<div class="sb">
  <div class="ss"><span class="sn">${r.overallScore}</span><span class="sd">/ 100</span></div>
  <div class="si"><h2>${esc(r.grade)}</h2><p>${esc(r.executiveSummary)}</p></div>
</div>
<div class="sec"><h3>Strengths</h3><div class="tags">${r.strengths.map(s => `<span class="tg tg-g">✓ ${esc(s)}</span>`).join("")}</div></div>
<div class="sec"><h3>Critical Weaknesses</h3><div class="tags">${r.criticalWeaknesses.map(w => `<span class="tg tg-r">✗ ${esc(w)}</span>`).join("")}</div></div>
<div class="sec"><h3>Assessment Criteria</h3><div class="cg">
${Object.entries(r.criteriaScores).map(([n, d]) => `<div class="ci"><div class="cn">${esc(n)}</div><div class="cs" style="color:${sc(d.score)}">${d.score}</div><div class="bar"><div class="bf" style="width:${d.score}%;background:${sc(d.score)}"></div></div><div class="cf">${esc(d.feedback)}</div></div>`).join("")}
</div></div>
<div class="sec"><h3>Improvement Action Plan</h3>
<table><thead><tr><th>Priority</th><th>Area</th><th>Recommended Action</th><th>Rationale</th></tr></thead>
<tbody>${r.improvementPlan.map(i => `<tr><td><span class="pb p${i.priority[0]}">${esc(i.priority)}</span></td><td><strong>${esc(i.area)}</strong></td><td>${esc(i.action)}</td><td>${esc(i.rationale)}</td></tr>`).join("")}</tbody></table>
</div>
<div class="sec"><h3>Recommended Resources</h3><ul class="rl">${r.recommendedResources.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
<div class="sec"><h3>Resubmission Readiness</h3><span class="rb">${esc(r.resubmissionReadiness)}</span></div>
<div class="sec"><h3>Reviewer's Final Commentary</h3><div class="note">${esc(r.reviewerNotes)}</div></div>
<div class="footer">ScholarMark Academic Review · Confidential · © ${new Date().getFullYear()}</div>
</body></html>`;

  const w = window.open("", "_blank");
  if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 700); }
}

// ─── NAV ──────────────────────────────────────────────────────────
function setupNav() {
  const nav = document.getElementById("nav");
  if (!nav) return;
  window.addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 50), { passive: true });
}

// ─── FAQ ──────────────────────────────────────────────────────────
function setupFAQ() {
  document.querySelectorAll(".faq-q").forEach(q => {
    const toggle = () => {
      const item = q.parentElement, open = item.classList.contains("open");
      document.querySelectorAll(".faq-item.open").forEach(x => {
        x.classList.remove("open");
        x.querySelector(".faq-q")?.setAttribute("aria-expanded", "false");
      });
      if (!open) { item.classList.add("open"); q.setAttribute("aria-expanded", "true"); }
    };
    q.addEventListener("click", toggle);
    q.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  });
}

// ─── MARQUEE ──────────────────────────────────────────────────────
function setupMarquee() {
  const track = document.getElementById("stripTrack");
  if (!track) return;
  const items = [
    "Master's Dissertations", "Doctoral Theses", "Research Papers", "Post-Doctoral Work",
    "Up to 10 Documents", "Marking Guidelines Accepted", "Structured Written Feedback",
    "Secure Submission", "Location-Based Pricing", "Level 7 to Level 10",
  ];
  const content = [...items, ...items]
    .map(t => `<span class="strip-item">${t}<span class="strip-sep">◆</span></span>`)
    .join("");
  track.innerHTML = content + content;
}

// ─── COUNTERS ─────────────────────────────────────────────────────
function setupCounters() {
  const co = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const el = e.target, target = +el.dataset.count, sfx = el.dataset.sfx || "";
      if (!target) return;
      const start = performance.now(), dur = 2000;
      const step = now => {
        const p = Math.min((now - start) / dur, 1), val = Math.round((1 - Math.pow(1 - p, 3)) * target);
        el.textContent = val.toLocaleString() + sfx;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      co.unobserve(el);
    });
  }, { threshold: 0.5 });
  document.querySelectorAll("[data-count]").forEach(el => co.observe(el));
}

// ─── HERO: CURSOR-TRACKING GLOW ──────────────────────────────────
function setupHeroCursor() {
  const hero = document.getElementById("hero");
  const cursor = document.getElementById("heroCursor");
  if (!hero || !cursor) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  hero.addEventListener("mousemove", e => {
    const rect = hero.getBoundingClientRect();
    cursor.style.left = (e.clientX - rect.left) + "px";
    cursor.style.top = (e.clientY - rect.top) + "px";
  });
}

// ─── HERO: FLOATING PARTICLES ─────────────────────────────────────
function setupHeroParticles() {
  const hero = document.getElementById("hero");
  if (!hero) return;

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;opacity:0.6;";
  hero.insertBefore(canvas, hero.firstChild);

  const ctx = canvas.getContext("2d");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const PARTICLE_COUNT = 55;
  let particles = [], W, H, animId;

  function resize() {
    const rect = hero.getBoundingClientRect();
    W = canvas.width = rect.width;
    H = canvas.height = rect.height;
  }

  function createParticle(randomY = false) {
    const size = Math.random() * 2.2 + 0.6;
    return {
      x: Math.random() * W, y: randomY ? Math.random() * H : H + 10, size,
      speedY: Math.random() * 0.35 + 0.12, speedX: (Math.random() - 0.5) * 0.18,
      opacity: Math.random() * 0.5 + 0.15, fade: Math.random() > 0.5 ? 0.003 : -0.003,
      hue: Math.random() * 20 + 200, sat: Math.floor(Math.random() * 30 + 60), lit: Math.floor(Math.random() * 20 + 70),
    };
  }

  function init() { resize(); particles = Array.from({ length: PARTICLE_COUNT }, () => createParticle(true)); }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of particles) {
      p.x += p.speedX; p.y -= p.speedY; p.opacity += p.fade;
      if (p.opacity >= 0.65 || p.opacity <= 0.08) p.fade *= -1;
      if (p.y < -10) Object.assign(p, createParticle(false));
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 2.5);
      grad.addColorStop(0, `hsla(${p.hue},${p.sat}%,${p.lit}%,${p.opacity})`);
      grad.addColorStop(1, `hsla(${p.hue},${p.sat}%,${p.lit}%,0)`);
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = grad; ctx.fill();
    }
    animId = requestAnimationFrame(draw);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelAnimationFrame(animId);
    else animId = requestAnimationFrame(draw);
  });

  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150); });

  init(); draw();
}

// ─── HERO: CARD FLOAT + BAR FILL ─────────────────────────────────
function setupHeroCardFloat() {
  const card = document.querySelector(".hero-card");
  if (!card) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { fillHeroBars(0); return; }
  setTimeout(() => { card.classList.add("loaded"); fillHeroBars(300); }, 2200);
}

function fillHeroBars(extraDelay) {
  document.querySelectorAll(".hc-bar-f").forEach((bar, i) => {
    const target = bar.style.width || "70%";
    bar.style.setProperty("--bar-w", target);
    bar.style.width = "0";
    setTimeout(() => bar.classList.add("animated"), extraDelay + i * 180);
  });
}

// ─── SCROLL REVEAL ────────────────────────────────────────────────
function setupReveal() {
  const ro = new IntersectionObserver((entries) => {
    entries.forEach((e, i) => {
      if (e.isIntersecting) { setTimeout(() => e.target.classList.add("in"), i * 70); ro.unobserve(e.target); }
    });
  }, { threshold: 0.1 });
  document.querySelectorAll(".reveal").forEach(el => ro.observe(el));
}

// ─── UTILS ────────────────────────────────────────────────────────
function esc(s) {
  if (typeof s !== "string") return String(s ?? "");
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function showErr(msg) {
  const el = document.getElementById("errBox");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 7000);
}

// ─── GLOBAL HELPERS ───────────────────────────────────────────────
window.pickLevel = pickLevel;
window.removeFile = removeFile;
window.toPayment = toPayment;
window.doPayment = doPayment;
window.downloadReport = downloadReport;
window.resetApp = resetApp;
window.liveValidateName = liveValidateName;
window.liveValidateEmail = liveValidateEmail;
window.setLevel = (lv) => { S.level = lv; document.getElementById("submit")?.scrollIntoView({ behavior: "smooth" }); };