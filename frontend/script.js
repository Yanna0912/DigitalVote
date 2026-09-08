/* =========================================================================
   CCDI Supreme Student Government Election — frontend
   -------------------------------------------------------------------------
   Talks to the backend in ../backend (Express + Supabase). Set the
   backend URL in config.js before deploying.
   ========================================================================= */

const API_BASE ="https://digitalvote.onrender.com/api"; // default to Render deployment if not set in config.js

/* ---------------- tiny API client ---------------- */
async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (_networkErr) {
    throw { error: "Can't reach the server. Check your connection and try again." };
  }

  let data = {};
  try { data = await res.json(); } catch (_parseErr) { /* empty body is fine */ }

  if (!res.ok) throw data && data.error ? data : { error: "Something went wrong. Please try again." };
  return data;
}

async function apiUpload(path, file, token) {
  const form = new FormData();
  form.append("file", file);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
  } catch (_networkErr) {
    throw { error: "Can't reach the server. Check your connection and try again." };
  }
  let data = {};
  try { data = await res.json(); } catch (_parseErr) { /* empty body is fine */ }
  if (!res.ok) throw data && data.error ? data : { error: "Upload failed." };
  return data;
}

/* ---------------- session state ---------------- */
let studentToken = sessionStorage.getItem("ccdi_student_token") || null;
let adminToken = sessionStorage.getItem("ccdi_admin_token") || null;
let currentStudent = null;
let currentAdmin = null;
let pendingAdminCreds = null; // {username, password} kept only for the OTP step, cleared right after

function setStudentToken(t) { studentToken = t; sessionStorage.setItem("ccdi_student_token", t); }
function clearStudentToken() { studentToken = null; sessionStorage.removeItem("ccdi_student_token"); }
function setAdminToken(t) { adminToken = t; sessionStorage.setItem("ccdi_admin_token", t); }
function clearAdminToken() { adminToken = null; sessionStorage.removeItem("ccdi_admin_token"); }

/* ---------------- helpers ---------------- */
function firstName(name) { return (name || "").split(",")[1]?.trim().split(" ")[0] || name; }
function timeStamp(d) {
  if (!d) return "&mdash;";
  return new Date(d).toLocaleString("en-PH", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------------- DOM refs ---------------- */
const voterSection = document.getElementById("voterSection");
const adminSection = document.getElementById("adminSection");
const panel = document.getElementById("panel");
const voteFullscreen = document.getElementById("voteFullscreen");

const credOverlay = document.getElementById("credOverlay");
const credEyebrow = document.getElementById("credEyebrow");
const credName = document.getElementById("credName");
const credMessage = document.getElementById("credMessage");
const credDevBox = document.getElementById("credDevBox");
const credUser = document.getElementById("credUser");
const credPass = document.getElementById("credPass");

const otpOverlay = document.getElementById("otpOverlay");

let activeTab = "register";
let waitingPoll = null;
let lastDevCredentials = null;

/* ---------------- Step: REGISTER / LOG IN ---------------- */
function renderEntryStep(tab) {
  activeTab = tab || activeTab || "register";
  voteFullscreen.classList.remove("show");
  voterSection.classList.remove("hidden");
  if (waitingPoll) { clearInterval(waitingPoll); waitingPoll = null; }

  panel.innerHTML = `
    <div class="panel-content">
      <p class="eyebrow">Voter access</p>
      <h2 class="step-title">${activeTab === "register" ? "Register to vote" : "Log in to vote"}</h2>
      <div class="mode-tabs">
        <button class="mode-tab ${activeTab === "register" ? "active" : ""}" id="tabRegisterBtn">First time &middot; Register</button>
        <button class="mode-tab ${activeTab === "login" ? "active" : ""}" id="tabLoginBtn">Have a login &middot; Sign in</button>
      </div>
      ${activeTab === "register" ? registerFormHtml() : loginFormHtml()}
    </div>`;

  document.getElementById("tabRegisterBtn").onclick = () => renderEntryStep("register");
  document.getElementById("tabLoginBtn").onclick = () => renderEntryStep("login");

  if (activeTab === "register") {
    document.getElementById("btnRegister").onclick = () => {
      handleRegister(document.getElementById("regId").value, document.getElementById("regEmail").value);
    };
  } else {
    document.getElementById("btnLogin").onclick = () => {
      handleLogin(document.getElementById("loginUser").value, document.getElementById("loginPass").value);
    };
    document.getElementById("loginPass").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("btnLogin").click();
    });
  }
}

function registerFormHtml() {
  return `
    <div class="field">
      <input type="text" id="regId" placeholder="Student ID, e.g. 21-0143" autocomplete="off">
    </div>
    <div class="field">
      <input type="email" id="regEmail" placeholder="Your email" autocomplete="off">
    </div>
    <p class="error-text" id="regError"></p>
    <button class="btn btn-primary" id="btnRegister">Register &amp; get my login</button>
    <p class="panel-note" style="margin-top:14px;">First time, this saves your email against your Student ID and emails you a username and password. After that, your ID + email will just tell you to log in below.</p>`;
}
function loginFormHtml() {
  return `
    <div class="field">
      <input type="text" id="loginUser" placeholder="Username" autocomplete="off">
    </div>
    <div class="field">
      <input type="password" id="loginPass" placeholder="Password" autocomplete="off">
    </div>
    <p class="error-text" id="loginError"></p>
    <button class="btn btn-primary" id="btnLogin">Log in</button>`;
}

async function handleRegister(idInput, emailInput) {
  const errorEl = document.getElementById("regError");
  errorEl.textContent = "";
  const id_no = String(idInput || "").trim();
  const email = String(emailInput || "").trim();
  if (!id_no || !email) {
    errorEl.textContent = "Please enter both your Student ID and email.";
    return;
  }
  const btn = document.getElementById("btnRegister");
  btn.disabled = true;
  try {
    const data = await api("/auth/student/lookup", { method: "POST", body: { id_no, email } });
    showCredentialResult(data);
  } catch (err) {
    errorEl.textContent = err.error || "Something went wrong. Please try again.";
  } finally {
    btn.disabled = false;
  }
}

async function handleLogin(username, password) {
  const errorEl = document.getElementById("loginError");
  errorEl.textContent = "";
  if (!username.trim() || !password.trim()) {
    errorEl.textContent = "Enter both your username and password.";
    return;
  }
  const btn = document.getElementById("btnLogin");
  btn.disabled = true;
  try {
    const data = await api("/auth/login", { method: "POST", body: { username: username.trim(), password } });
    if (data.role === "admin") {
      pendingAdminCreds = { username: username.trim(), password };
      startAdminOtp(data);
    } else {
      setStudentToken(data.token);
      currentStudent = data.student;
      proceedAfterAuth(data.student, data.votingOpen);
    }
  } catch (err) {
    errorEl.textContent = err.error || "Something went wrong. Please try again.";
  } finally {
    btn.disabled = false;
  }
}

function proceedAfterAuth(student, votingOpen) {
  if (student.voted) { showAlreadyVoted(student); return; }
  if (!votingOpen) { showWaiting(student); return; }
  renderVoteStep();
}

/* ---------------- registration result pop-up (email confirmation / dev fallback) ---------------- */
function showCredentialResult(data) {
  const alreadyRegistered = data.status === "already_registered";
  credEyebrow.textContent = alreadyRegistered ? "Already registered" : "Registration";
  credName.textContent = alreadyRegistered ? "You're already registered" : "Check your email";
  credMessage.textContent = data.message || "";

  lastDevCredentials = data.devCredentials || null;
  if (lastDevCredentials) {
    credUser.textContent = lastDevCredentials.username;
    credPass.textContent = lastDevCredentials.password;
    credDevBox.classList.remove("hidden");
  } else {
    credDevBox.classList.add("hidden");
  }
  credOverlay.classList.add("show");
}

document.getElementById("credClose").onclick = () => {
  credOverlay.classList.remove("show");
  renderEntryStep("login");
  if (lastDevCredentials) {
    document.getElementById("loginUser").value = lastDevCredentials.username;
    document.getElementById("loginPass").value = lastDevCredentials.password;
  }
};

document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const text = document.getElementById(btn.dataset.copyTarget).textContent;
    navigator.clipboard?.writeText(text).then(() => {
      btn.classList.add("copied");
      const original = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.classList.remove("copied"); btn.textContent = original; }, 1500);
    });
  });
});

/* ---------------- Full-screen voting experience ---------------- */
/* waiting / ballot / confirmation / already-voted all render here,   */
/* replacing the whole screen instead of living in the small login card. */
function enterFullscreen(mode) {
  voterSection.classList.add("hidden");
  voteFullscreen.className = `vote-fullscreen show ${mode}`;
}

async function renderVoteStep() {
  enterFullscreen("ballot");
  voteFullscreen.innerHTML = `<div class="ballot-inner"><p class="panel-note">Loading the ballot&hellip;</p></div>`;

  let ballot;
  try {
    const data = await api("/ballot", { token: studentToken });
    ballot = data.ballot || [];
  } catch (err) {
    if (err.error && /not open/i.test(err.error)) { showWaiting(currentStudent); return; }
    voteFullscreen.innerHTML = `<div class="ballot-inner"><p class="error-text">${err.error || "Couldn't load the ballot."}</p></div>`;
    return;
  }

  const racesHtml = ballot.map((race, ri) => `
    <fieldset class="race" data-position="${race.position}">
      <legend class="eyebrow" style="margin-bottom:8px;">${race.position}</legend>
      ${race.candidates.map((c) => `
        <label class="candidate-row">
          <input type="radio" name="race-${ri}" value="${c.name}">
          <span>${c.name}${c.slogan ? `<br><small style="color:var(--muted); font-weight:400;">${c.slogan}</small>` : ""}</span>
        </label>`).join("")}
    </fieldset>`).join("");

  voteFullscreen.innerHTML = `
    <div class="ballot-inner">
      <div class="ballot-header">
        <p class="eyebrow">Hi, ${firstName(currentStudent?.name || "")} &middot; official ballot</p>
        <h2>Cast your vote</h2>
      </div>
      ${ballot.length ? `<div class="ballot-grid">${racesHtml}</div>` : '<p class="error-text" style="color:var(--muted);">No candidates have been set up yet. Please check with the election officer.</p>'}
      <p class="error-text" id="voteError"></p>
      <div class="ballot-submit-row">
        <button class="btn btn-primary" id="btnSubmitVote" ${ballot.length ? "" : "disabled"}>Submit vote</button>
      </div>
    </div>`;

  document.getElementById("btnSubmitVote").onclick = () => submitVote(ballot);
}

async function submitVote(ballot) {
  const errorEl = document.getElementById("voteError");
  const votes = {};
  for (let ri = 0; ri < ballot.length; ri++) {
    const race = ballot[ri];
    const checked = document.querySelector(`input[name="race-${ri}"]:checked`);
    if (!checked) {
      errorEl.textContent = `Please select a candidate for ${race.position}.`;
      return;
    }
    votes[race.position] = checked.value;
  }
  errorEl.textContent = "";

  const btn = document.getElementById("btnSubmitVote");
  btn.disabled = true;
  try {
    const res = await api("/vote", { method: "POST", token: studentToken, body: { votes } });
    showConfirmation({ name: currentStudent?.name || "", votedAt: res.votedAt });
  } catch (err) {
    errorEl.textContent = err.error || "Couldn't submit your vote. Please try again.";
    btn.disabled = false;
  }
}

function showConfirmation(record) {
  enterFullscreen("confirm");
  voteFullscreen.innerHTML = `
    <div class="takeover-inner">
      <div class="status-badge">&#10003;</div>
      <h2>Thank you, ${firstName(record.name)}!</h2>
      <p>Your vote has been recorded successfully.</p>
      <div class="stamp">Voted &middot; ${timeStamp(record.votedAt)}</div><br>
      <button class="btn-secondary" id="btnDone">Done</button>
    </div>`;
  document.getElementById("btnDone").onclick = () => resetToStart();
  setTimeout(resetToStart, 8000);
}

function showAlreadyVoted(record) {
  enterFullscreen("blocked");
  voteFullscreen.innerHTML = `
    <div class="takeover-inner">
      <div class="status-badge">!</div>
      <h2>Already voted</h2>
      <p>${record.name} already cast a vote${record.voted_at ? ` on ${timeStamp(record.voted_at)}` : ""}. Each student may only vote once.</p>
      <button class="btn-secondary" id="btnDone2">Back</button>
    </div>`;
  document.getElementById("btnDone2").onclick = () => resetToStart();
}

function showWaiting(student) {
  enterFullscreen("waiting");
  voteFullscreen.innerHTML = `
    <div class="takeover-inner">
      <div class="spinner"></div>
      <h2>Almost there, ${firstName(student.name)}</h2>
      <p>Voting hasn't started yet. This screen will move on by itself once the election officer opens the polls &mdash; or come back later.</p>
      <div class="waiting-actions">
        <button class="btn-secondary" id="btnCheckAgain">Check now</button>
        <button class="btn-secondary" id="btnExitWaiting">Exit</button>
      </div>
    </div>`;
  document.getElementById("btnCheckAgain").onclick = () => checkWaiting();
  document.getElementById("btnExitWaiting").onclick = () => resetToStart();
  if (waitingPoll) clearInterval(waitingPoll);
  waitingPoll = setInterval(() => checkWaiting(true), 4000);
}
async function checkWaiting(_silent) {
  try {
    const data = await api("/me", { token: studentToken });
    currentStudent = data.student;
    if (data.student.voted) {
      clearInterval(waitingPoll); waitingPoll = null;
      showAlreadyVoted(data.student);
      return;
    }
    if (data.votingOpen) {
      clearInterval(waitingPoll); waitingPoll = null;
      renderVoteStep();
    }
  } catch (_err) {
    // transient error while polling — try again on the next tick
  }
}

function resetToStart() {
  if (waitingPoll) { clearInterval(waitingPoll); waitingPoll = null; }
  clearStudentToken();
  currentStudent = null;
  voteFullscreen.classList.remove("show");
  renderEntryStep("register");
}

/* ---------------- Admin OTP verification ---------------- */
function startAdminOtp(data) {
  document.getElementById("otpTarget").innerHTML = `We sent a 6-digit verification code to <strong>${data.maskedEmail}</strong>.`;
  document.getElementById("otpDemoNote").textContent = data.devCode ? `Demo only \u2014 email isn't configured yet. Your code: ${data.devCode}` : "";
  document.getElementById("otpInput").value = "";
  document.getElementById("otpError").textContent = "";
  otpOverlay.classList.add("show");
}
document.getElementById("otpSubmit").onclick = async () => {
  const errorEl = document.getElementById("otpError");
  const code = document.getElementById("otpInput").value.trim();
  if (!code || !pendingAdminCreds) { errorEl.textContent = "Enter the code we sent you."; return; }
  const btn = document.getElementById("otpSubmit");
  btn.disabled = true;
  try {
    const data = await api("/auth/admin/verify-otp", { method: "POST", body: { username: pendingAdminCreds.username, code } });
    otpOverlay.classList.remove("show");
    setAdminToken(data.token);
    currentAdmin = data.admin;
    pendingAdminCreds = null;
    openAdminDashboard(data.admin);
  } catch (err) {
    errorEl.textContent = err.error || "Incorrect code. Please try again.";
  } finally {
    btn.disabled = false;
  }
};
document.getElementById("otpInput").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("otpSubmit").click(); });
document.getElementById("otpResendLink").onclick = async (e) => {
  e.preventDefault();
  if (!pendingAdminCreds) return;
  try {
    const data = await api("/auth/login", { method: "POST", body: pendingAdminCreds });
    startAdminOtp(data);
  } catch (err) {
    document.getElementById("otpError").textContent = err.error || "Couldn't resend the code.";
  }
};

/* ---------------- Admin dashboard ---------------- */
function openAdminDashboard(admin) {
  voterSection.classList.add("hidden");
  voteFullscreen.classList.remove("show");
  adminSection.classList.remove("hidden");
  document.getElementById("adminWho").textContent = `${admin.name} \u00b7 ${admin.email}`;
  switchAdminTab("dashboard");
  refreshAll();
}
function refreshAll() {
  renderStatRow();
  renderResultsPanel();
  renderBlockGrid();
  renderRosterTable();
  renderCandidateList();
  renderSiteQr();
  renderAdminList();
}
document.getElementById("adminLogout").onclick = () => {
  adminSection.classList.add("hidden");
  voterSection.classList.remove("hidden");
  clearAdminToken();
  currentAdmin = null;
  resetToStart();
};

function switchAdminTab(tab) {
  document.querySelectorAll(".sidebar-link").forEach((b) => b.classList.toggle("active", b.dataset.admintab === tab));
  ["dashboard", "students", "candidates", "qrcodes", "admins"].forEach((t) => {
    document.getElementById("adminPanel" + capitalize(t)).classList.toggle("hidden", t !== tab);
  });
}
document.querySelectorAll(".sidebar-link").forEach((btn) => {
  btn.addEventListener("click", () => switchAdminTab(btn.dataset.admintab));
});

/* ---- dashboard: stats + election status toggle + live results ---- */
async function renderStatRow() {
  let stats;
  try {
    stats = await api("/admin/stats", { token: adminToken });
  } catch (_err) {
    document.getElementById("statRow").innerHTML = `<p class="error-text">Couldn't load stats.</p>`;
    return;
  }
  const open = stats.votingOpen;
  document.getElementById("statRow").innerHTML = `
    <div class="stat-card"><div class="stat-num">${stats.total}</div><div class="stat-label">Total students</div></div>
    <div class="stat-card"><div class="stat-num">${stats.registeredNotVoted}</div><div class="stat-label">Credentials issued, not yet voted</div></div>
    <div class="stat-card"><div class="stat-num">${stats.voted}</div><div class="stat-label">Voted</div></div>
    <div class="stat-card status-card ${open ? "status-open" : "status-closed"}" id="statusCard">
      <div><span class="status-dot"></span><strong>${open ? "Voting OPEN" : "Voting CLOSED"}</strong></div>
      <div class="status-toggle-label">Tap to ${open ? "close" : "open"} voting</div>
    </div>`;

  document.getElementById("statusCard").onclick = async () => {
    try {
      await api("/admin/settings/voting-open", { method: "POST", token: adminToken, body: { open: !open } });
      renderStatRow();
    } catch (err) {
      alert(err.error || "Couldn't update election status.");
    }
  };
}

async function renderResultsPanel() {
  const el = document.getElementById("resultsCard");
  let results;
  try {
    const data = await api("/admin/results", { token: adminToken });
    results = data.results || [];
  } catch (_err) {
    el.innerHTML = `<h3 class="panel-heading">Live results</h3><p class="error-text">Couldn't load results.</p>`;
    return;
  }
  if (!results.length) {
    el.innerHTML = `<h3 class="panel-heading">Live results</h3><p class="panel-note">No positions set up yet. Add candidates first.</p>`;
    return;
  }
  el.innerHTML = `<h3 class="panel-heading">Live results</h3>` + results.map((race) => {
    const max = Math.max(1, ...race.candidates.map((c) => c.votes));
    return `
      <div class="results-row">
        <h4>${race.position}</h4>
        ${race.candidates.map((c) => `
          <div class="results-bar-track"><div class="results-bar-fill" style="width:${(c.votes / max) * 100}%"></div></div>
          <div class="results-bar-label"><span>${c.name}</span><span>${c.votes} vote${c.votes === 1 ? "" : "s"}</span></div>
        `).join("")}
      </div>`;
  }).join("");
}

/* ---- students: per-block summary cards + collapsible full roster ---- */
let cachedRoster = [];
async function renderBlockGrid() {
  try {
    const data = await api("/admin/students", { token: adminToken });
    cachedRoster = data.students || [];
  } catch (_err) {
    cachedRoster = [];
  }

  const blocks = {};
  cachedRoster.forEach((s) => {
    const key = s.block || "No block";
    if (!blocks[key]) blocks[key] = { total: 0, registered: 0, voted: 0 };
    blocks[key].total++;
    if (s.registered) blocks[key].registered++;
    if (s.voted) blocks[key].voted++;
  });

  const grid = document.getElementById("blockGrid");
  const keys = Object.keys(blocks).sort();
  grid.innerHTML = keys.length
    ? keys.map((key) => {
        const b = blocks[key];
        const votedPct = b.total ? Math.round((b.voted / b.total) * 100) : 0;
        const genPct = b.total ? Math.round((b.registered / b.total) * 100) : 0;
        return `
          <div class="block-card">
            <h4>${key}</h4>
            <div class="block-metric">
              <div class="block-metric-label"><span>Voted</span><span>${votedPct}%</span></div>
              <div class="block-metric-track"><div class="block-metric-fill voted" style="width:${votedPct}%"></div></div>
            </div>
            <div class="block-metric">
              <div class="block-metric-label"><span>Generated</span><span>${genPct}%</span></div>
              <div class="block-metric-track"><div class="block-metric-fill generated" style="width:${genPct}%"></div></div>
            </div>
          </div>`;
      }).join("")
    : `<p class="panel-note">No students in the roster yet.</p>`;
}

async function renderRosterTable() {
  if (!cachedRoster.length) {
    try {
      const data = await api("/admin/students", { token: adminToken });
      cachedRoster = data.students || [];
    } catch (_err) { cachedRoster = []; }
  }
  document.getElementById("rosterCount").textContent = cachedRoster.length;
  const tbody = document.querySelector("#rosterTable tbody");
  tbody.innerHTML = cachedRoster.length
    ? cachedRoster.map((s) => `
      <tr>
        <td>${s.id_no}</td><td>${s.name}</td><td>${s.block || "&mdash;"}</td><td>${s.email || "&mdash;"}</td>
        <td><button class="row-remove" data-remove-student="${s.id_no}">&times;</button></td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="table-empty">No students yet.</td></tr>`;

  tbody.querySelectorAll("[data-remove-student]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/admin/students/${encodeURIComponent(btn.dataset.removeStudent)}`, { method: "DELETE", token: adminToken });
        cachedRoster = [];
        renderRosterTable(); renderBlockGrid(); renderStatRow();
      } catch (err) { alert(err.error || "Couldn't remove that student."); }
    };
  });
}

/* Add Student modal (manual add + CSV import) */
const addStudentOverlay = document.getElementById("addStudentOverlay");
document.getElementById("openAddStudentModal").onclick = () => {
  document.getElementById("rosterError").textContent = "";
  document.getElementById("csvError").textContent = "";
  addStudentOverlay.classList.add("show");
};
document.getElementById("closeAddStudentModal").onclick = () => addStudentOverlay.classList.remove("show");

document.getElementById("studentModalTabOne").onclick = () => {
  document.getElementById("studentModalTabOne").classList.add("active");
  document.getElementById("studentModalTabCsv").classList.remove("active");
  document.getElementById("studentModalOne").classList.remove("hidden");
  document.getElementById("studentModalCsv").classList.add("hidden");
};
document.getElementById("studentModalTabCsv").onclick = () => {
  document.getElementById("studentModalTabCsv").classList.add("active");
  document.getElementById("studentModalTabOne").classList.remove("active");
  document.getElementById("studentModalCsv").classList.remove("hidden");
  document.getElementById("studentModalOne").classList.add("hidden");
};

document.getElementById("addStudentBtn").onclick = async () => {
  const errorEl = document.getElementById("rosterError");
  errorEl.textContent = "";
  const id_no = document.getElementById("rosterId").value.trim();
  const name = document.getElementById("rosterName").value.trim();
  const block = document.getElementById("rosterBlock").value.trim();
  if (!id_no || !name) { errorEl.textContent = "Student ID and name are required."; return; }
  try {
    await api("/admin/students", { method: "POST", token: adminToken, body: { id_no, name, block } });
    document.getElementById("rosterId").value = "";
    document.getElementById("rosterName").value = "";
    document.getElementById("rosterBlock").value = "";
    cachedRoster = [];
    renderRosterTable(); renderBlockGrid(); renderStatRow();
    addStudentOverlay.classList.remove("show");
  } catch (err) { errorEl.textContent = err.error || "Couldn't add that student."; }
};

document.getElementById("importCsvBtn").onclick = async () => {
  const errorEl = document.getElementById("csvError");
  errorEl.textContent = "";
  const fileInput = document.getElementById("csvFileInput");
  const file = fileInput.files[0];
  if (!file) { errorEl.textContent = "Choose a CSV file first."; return; }
  const btn = document.getElementById("importCsvBtn");
  btn.disabled = true;
  try {
    const data = await apiUpload("/admin/students/import", file, adminToken);
    fileInput.value = "";
    cachedRoster = [];
    renderRosterTable(); renderStatRow(); renderBlockGrid();
    addStudentOverlay.classList.remove("show");
    alert(`Imported/updated ${data.count} student(s).`);
  } catch (err) {
    errorEl.textContent = err.error || "Import failed.";
  } finally {
    btn.disabled = false;
  }
};

/* ---- candidates: grouped list + Add Candidate modal ---- */
async function renderCandidateList() {
  const el = document.getElementById("candidateList");
  let candidates;
  try {
    const data = await api("/admin/candidates", { token: adminToken });
    candidates = data.candidates || [];
  } catch (_err) {
    el.innerHTML = `<p class="error-text">Couldn't load candidates.</p>`;
    return;
  }
  if (!candidates.length) {
    el.innerHTML = `<p class="panel-note">No candidates yet. Use "Add Candidates" to get started.</p>`;
    return;
  }
  const byPosition = {};
  candidates.forEach((c) => {
    if (!byPosition[c.position]) byPosition[c.position] = [];
    byPosition[c.position].push(c);
  });
  el.innerHTML = Object.entries(byPosition).map(([position, list]) => `
    <div class="candidate-position-group">
      <p class="candidate-position-title">${position}</p>
      ${list.map((c) => `
        <div class="candidate-list-row">
          <div>
            <div class="candidate-list-name">${c.name}</div>
            ${c.slogan ? `<div class="candidate-list-slogan">${c.slogan}</div>` : ""}
          </div>
          <button class="row-remove" data-remove-cand="${c.id}">&times;</button>
        </div>`).join("")}
    </div>`).join("");

  el.querySelectorAll("[data-remove-cand]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/admin/candidates/${btn.dataset.removeCand}`, { method: "DELETE", token: adminToken });
        renderCandidateList(); renderResultsPanel();
      } catch (err) { alert(err.error || "Couldn't remove that candidate."); }
    };
  });
}

const addCandidateOverlay = document.getElementById("addCandidateOverlay");
document.getElementById("openAddCandidateModal").onclick = () => addCandidateOverlay.classList.add("show");
document.getElementById("closeAddCandidateModal").onclick = () => addCandidateOverlay.classList.remove("show");
document.getElementById("addCandidateBtn").onclick = async () => {
  const position = document.getElementById("candPosition").value.trim();
  const name = document.getElementById("candName").value.trim();
  const slogan = document.getElementById("candSlogan").value.trim();
  if (!position || !name) return;
  try {
    await api("/admin/candidates", { method: "POST", token: adminToken, body: { position, name, slogan } });
    document.getElementById("candPosition").value = "";
    document.getElementById("candName").value = "";
    document.getElementById("candSlogan").value = "";
    renderCandidateList(); renderResultsPanel();
    addCandidateOverlay.classList.remove("show");
  } catch (err) { alert(err.error || "Couldn't add that candidate."); }
};

/* ---- site QR code (leads back to this site, not a per-student code) ---- */
function renderSiteQr() {
  const url = window.location.href.split("#")[0];
  document.getElementById("siteQrUrl").textContent = url;
  const box = document.getElementById("siteQrBox");
  box.innerHTML = "";
  if (typeof QRCode !== "undefined") {
    new QRCode(box, { text: url, width: 170, height: 170, colorDark: "#0A0F22", colorLight: "#ffffff" });
  }
}
document.getElementById("downloadQrBtn").onclick = () => {
  const canvas = document.querySelector("#siteQrBox canvas");
  if (!canvas) return;
  const link = document.createElement("a");
  link.download = "ccdi-election-qr.png";
  link.href = canvas.toDataURL("image/png");
  link.click();
};

/* ---- admin accounts: list + Add Admin modal (no public sign-up) ---- */
async function renderAdminList() {
  const el = document.getElementById("adminList");
  let admins;
  try {
    const data = await api("/admin/admins", { token: adminToken });
    admins = data.admins || [];
  } catch (_err) {
    el.innerHTML = `<p class="error-text">Couldn't load admin accounts.</p>`;
    return;
  }
  el.innerHTML = admins.length
    ? admins.map((a) => {
        const isSelf = currentAdmin && a.id === currentAdmin.id;
        const canRemove = admins.length > 1 && !isSelf;
        return `
          <div class="candidate-list-row">
            <div>
              <div class="candidate-list-name">${a.name}${isSelf ? ' <span class="status-pill yes">You</span>' : ""}</div>
              <div class="candidate-list-slogan">${a.username} &middot; ${a.email}</div>
            </div>
            ${canRemove ? `<button class="row-remove" data-remove-admin="${a.id}">&times;</button>` : ""}
          </div>`;
      }).join("")
    : `<p class="panel-note">No admin accounts yet.</p>`;

  el.querySelectorAll("[data-remove-admin]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/admin/admins/${btn.dataset.removeAdmin}`, { method: "DELETE", token: adminToken });
        renderAdminList();
      } catch (err) { alert(err.error || "Couldn't remove that admin."); }
    };
  });
}

const addAdminOverlay = document.getElementById("addAdminOverlay");
document.getElementById("openAddAdminModal").onclick = () => {
  document.getElementById("admError2").textContent = "";
  addAdminOverlay.classList.add("show");
};
document.getElementById("closeAddAdminModal").onclick = () => addAdminOverlay.classList.remove("show");
document.getElementById("addAdminBtn").onclick = async () => {
  const errorEl = document.getElementById("admError2");
  errorEl.textContent = "";
  const name = document.getElementById("admName").value.trim();
  const email = document.getElementById("admEmail2").value.trim();
  const username = document.getElementById("admUsername2").value.trim();
  const password = document.getElementById("admPassword2").value;
  try {
    await api("/admin/admins", { method: "POST", token: adminToken, body: { name, email, username, password } });
    ["admName", "admEmail2", "admUsername2", "admPassword2"].forEach((id) => { document.getElementById(id).value = ""; });
    renderAdminList();
    addAdminOverlay.classList.remove("show");
  } catch (err) {
    errorEl.textContent = err.error || "Couldn't add that admin.";
  }
};

document.getElementById("resetDemo").onclick = () => {
  alert("For safety, clearing votes/registrations isn't done from the browser. Run the relevant SQL in the Supabase dashboard (see backend/README.md) if you need to reset test data.");
};

/* ---------------- Boot ---------------- */
renderEntryStep("register");
