/**
 * portal.js — ScholarMark User Portal Logic
 */

window.addEventListener('load', async function () {
    // Wait for Clerk to load
    const checkClerk = setInterval(async () => {
        if (window.Clerk) {
            clearInterval(checkClerk);
            await initPortal();
        }
    }, 100);
});

async function initPortal() {
    try {
        await window.Clerk.load();

        if (!window.Clerk.user) {
            // Not logged in, redirect to sign-in or home
            window.location.href = '/';
            return;
        }

        // Render User Button
        const userButtonDiv = document.getElementById('user-button');
        window.Clerk.mountUserButton(userButtonDiv);

        await loadUserSubmissions();
    } catch (err) {
        console.error("[Portal] Init failed:", err);
    }
}

async function loadUserSubmissions() {
    const content = document.getElementById('dashboard-content');
    
    try {
        const token = await window.Clerk.session.getToken();
        const res = await fetch(`${window.API_BASE}/api/user/submissions`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const data = await res.json();
        renderSubmissions(data.submissions);
    } catch (err) {
        console.error("[Portal] Failed to load submissions:", err);
        content.innerHTML = `<div class="empty-state"><h3>Error loading history</h3><p>${err.message}</p></div>`;
    }
}

function renderSubmissions(submissions) {
    const content = document.getElementById('dashboard-content');
    
    if (!submissions || submissions.length === 0) {
        content.innerHTML = `
            <div class="empty-state">
                <div style="font-size: 3rem; margin-bottom: 1rem;">📄</div>
                <h3>No submissions yet</h3>
                <p>Documents you submit for review will appear here.</p>
                <a href="/" class="btn-view" style="display: inline-block; margin-top: 1rem; text-decoration: none;">Submit Your First Document</a>
            </div>`;
        return;
    }

    content.innerHTML = submissions.map(s => `
        <div class="doc-card">
            <div class="doc-info">
                <h3>${esc(s.level)} Review</h3>
                <div class="doc-meta">
                    <span>📅 ${new Date(s.created_at).toLocaleDateString()}</span>
                    <span>📂 ${JSON.parse(s.file_names).length} files</span>
                </div>
            </div>
            <div style="display: flex; align-items: center; gap: 1rem;">
                <span class="status-pill status-${s.status}">${s.status}</span>
                ${s.status === 'reviewed' ? `<button class="btn-view" onclick="viewReview('${s.id}')">View Report</button>` : ''}
            </div>
        </div>
    `).join('');
}

async function viewReview(submissionId) {
    try {
        const token = await window.Clerk.session.getToken();
        const res = await fetch(`${window.API_BASE}/api/review/by-submission/${submissionId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.token) {
            window.location.href = `/?token=${data.token}`;
        } else {
            alert("Review not found or still processing.");
        }
    } catch (err) {
        console.error("[Portal] View failed:", err);
        alert("Could not load review.");
    }
}

function esc(s) {
    if (typeof s !== "string") return String(s ?? "");
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
