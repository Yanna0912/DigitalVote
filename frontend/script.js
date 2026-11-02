/* =========================================================================
   CCDI Supreme Student Government Election — frontend
   -------------------------------------------------------------------------
   Talks to the backend in ../backend (Express + Supabase). Set the
   backend URL in config.js before deploying.
   ========================================================================= */

const API_BASE = (window.CCDI_API_BASE || "http://localhost:4000/api").replace(/\/$/, "");

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
      cache: "no-store",
    });
  } catch (_networkErr) {
    throw { error: "Can't reach the server. Check your connection and try again." };
  }

  let data = {};
  try { data = await res.json(); } catch (_parseErr) { /* empty body is fine */ }

  if (!res.ok) {
    throw {
      ...(data && typeof data === "object" ? data : {}),
      error: data && data.error ? data.error : "Something went wrong. Please try again.",
      status: res.status,
    };
  }
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
const ADMIN_TAB_KEY = "ccdi_admin_tab";
const BALLOT_SELECTIONS_KEY = "ccdi_ballot_selections";
const STUDENT_SESSION_KEY = "ccdi_student_session";
const ADMIN_SESSION_KEY = "ccdi_admin_session";

function cacheStudentSession(student, votingOpen) {
  sessionStorage.setItem(STUDENT_SESSION_KEY, JSON.stringify({ student, votingOpen }));
}
function cacheAdminSession(admin) {
  sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(admin));
}
function isInvalidSession(error) {
  return error?.status === 401 || error?.status === 403 || error?.status === 404;
}

/* ---------------- helpers ---------------- */
function firstName(name) { return (name || "").split(",")[1]?.trim().split(" ")[0] || name; }
function timeStamp(d) {
  if (!d) return "&mdash;";
  return new Date(d).toLocaleString("en-PH", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}
function candidateProfileMarkup(candidate, result = null) {
  const initials = String(candidate.name || "?").split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
  return `
    <div class="candidate-profile-card">
      <div class="candidate-profile-photo">
        ${candidate.photo ? `<img src="${candidate.photo}" alt="${escapeHtml(candidate.name)}">` : `<span>${escapeHtml(initials)}</span>`}
      </div>
      <div class="candidate-profile-info">
        <strong>${escapeHtml(candidate.name)}</strong>
        <span>Block: ${escapeHtml(candidate.block || "Not listed")}</span>
        <span>ID: ${escapeHtml(candidate.id_no || "Not listed")}</span>
        ${candidate.party ? `<span class="candidate-profile-party">${escapeHtml(candidate.party)}</span>` : ""}
      </div>
      ${result ? `<div class="candidate-profile-result"><strong>${result.votes} vote${result.votes === 1 ? "" : "s"}</strong><span>${result.percent}%</span></div>` : ""}
    </div>`;
}
function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------- DOM refs ---------------- */
const voterSection = document.getElementById("voterSection");
const adminSection = document.getElementById("adminSection");
const panel = document.getElementById("panel");
const voteFullscreen = document.getElementById("voteFullscreen");
const publicPage = voterSection.closest(".page");

const credOverlay = document.getElementById("credOverlay");
const credEyebrow = document.getElementById("credEyebrow");
const credName = document.getElementById("credName");
const credMessage = document.getElementById("credMessage");

const otpOverlay = document.getElementById("otpOverlay");
const registrationOverlay = document.getElementById("registrationOverlay");
const forgotPasswordOverlay = document.getElementById("forgotPasswordOverlay");

let waitingPoll = null;

/* ---------------- Step: REGISTER / LOG IN ---------------- */
function renderEntryStep() {
  publicPage.classList.remove("hidden");
  voteFullscreen.classList.remove("show");
  voterSection.classList.remove("hidden");
  if (waitingPoll) { clearInterval(waitingPoll); waitingPoll = null; }

  panel.innerHTML = `
    <div class="panel-content">
      <p class="eyebrow">Voter access</p>
      <h2 class="step-title">Log in to vote</h2>
      ${loginFormHtml()}
    </div>`;

  document.getElementById("tabRegisterBtn").onclick = openRegistrationModal;
  document.getElementById("forgotAdminPassword").onclick = (event) => {
    event.preventDefault();
    openAdminPasswordReset();
  };
  document.getElementById("btnLogin").onclick = () => {
    handleLogin(document.getElementById("loginUser").value, document.getElementById("loginPass").value);
  };
  document.getElementById("toggleLoginPassword").onclick = () => {
    const passwordInput = document.getElementById("loginPass");
    const toggleButton = document.getElementById("toggleLoginPassword");
    const isVisible = passwordInput.type === "text";
    passwordInput.type = isVisible ? "password" : "text";
    toggleButton.innerHTML = isVisible ? "&#128065;" : "&#128065;&#xfe0e;";
    toggleButton.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
    toggleButton.setAttribute("title", isVisible ? "Show password" : "Hide password");
  };
  document.getElementById("loginPass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btnLogin").click();
  });
}

function openRegistrationModal() {
  document.getElementById("registrationError").textContent = "";
  registrationOverlay.classList.add("show");
  document.getElementById("registrationFirstName").focus();
}

async function submitRegistration() {

  const errorEl = document.getElementById("registrationError");
  errorEl.textContent = "";
  const fieldIds = ["registrationFirstName", "registrationLastName", "registrationStudentId", "registrationEmail"];
  const values = Object.fromEntries(fieldIds.map((id) => [id, document.getElementById(id).value.trim()]));
  if (fieldIds.some((id) => !values[id])) {
    errorEl.textContent = "Please complete all required fields.";
    return;
  }
  const button = document.getElementById("submitRegistration");
  button.disabled = true;
  try {
    const data = await api("/auth/student/register", {
      method: "POST",
      body: {
        first_name: values.registrationFirstName,
        last_name: values.registrationLastName,
        suffix: document.getElementById("registrationSuffix").value.trim(),
        id_no: values.registrationStudentId,
        email: values.registrationEmail,
      },
    });
    registrationOverlay.classList.remove("show");
    showCredentialResult(data);
  } catch (err) {
    errorEl.textContent = err.error || "Couldn't submit your registration.";
  } finally {
    button.disabled = false;
  }
}
function closeRegistrationModal() {
  registrationOverlay.classList.remove("show");
  renderEntryStep();
}

document.getElementById("registrationClose")?.addEventListener("click", closeRegistrationModal);
document.getElementById("submitRegistration")?.addEventListener("click", submitRegistration);
document.getElementById("otpClose")?.addEventListener("click", () => otpOverlay.classList.remove("show"));

// optional: click the dark background or press Esc to close
registrationOverlay.addEventListener("click", (e) => { if (e.target === registrationOverlay) closeRegistrationModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRegistrationModal(); });


function loginFormHtml() {
  return `
    <div class="field">
      <input type="text" id="loginUser" placeholder="Username" autocomplete="off">
    </div>
    <div class="field password-field">
      <input type="password" id="loginPass" placeholder="Password" autocomplete="off">
      <button class="password-toggle" id="toggleLoginPassword" type="button" aria-label="Show password" title="Show password">&#128065;</button>
    </div>
    <p class="error-text" id="loginError"></p>
    <button class="btn btn-primary" id="btnLogin">Log in</button>
    <p class="cred-note" style="text-align:right;margin:8px 0 0;"><a href="#" id="forgotAdminPassword">Forgot admin password?</a></p>
    <div class="signin-block">
      <p class="signin-block-title">No credentials yet?</p>
      <button class="btn-secondary" id="tabRegisterBtn" type="button">Register</button>
    </div>`;
}

function openAdminPasswordReset() {
  document.getElementById("resetAdminEmail").value = "";
  document.getElementById("resetAdminCode").value = "";
  document.getElementById("resetAdminPassword").value = "";
  document.getElementById("resetAdminPasswordConfirm").value = "";
  document.getElementById("adminResetFields").classList.add("hidden");
  document.getElementById("requestAdminResetCode").classList.remove("hidden");
  document.getElementById("requestAdminResetCode").textContent = "Send reset code";
  document.getElementById("adminResetError").textContent = "";
  document.getElementById("adminResetMessage").textContent = "";
  forgotPasswordOverlay.classList.add("show");
  document.getElementById("resetAdminEmail").focus();
}

document.getElementById("forgotPasswordClose").onclick = () => forgotPasswordOverlay.classList.remove("show");
forgotPasswordOverlay.addEventListener("click", (event) => {
  if (event.target === forgotPasswordOverlay) forgotPasswordOverlay.classList.remove("show");
});
document.getElementById("requestAdminResetCode").onclick = async () => {
  const email = document.getElementById("resetAdminEmail").value.trim();
  const errorEl = document.getElementById("adminResetError");
  const messageEl = document.getElementById("adminResetMessage");
  const button = document.getElementById("requestAdminResetCode");
  errorEl.textContent = "";
  messageEl.textContent = "";
  if (!email) {
    errorEl.textContent = "Enter the email address on your admin account.";
    return;
  }

  button.disabled = true;
  try {
    const data = await api("/auth/admin/forgot-password", { method: "POST", body: { email } });
    document.getElementById("adminResetFields").classList.remove("hidden");
    button.textContent = "Send another code";
    messageEl.textContent = data.message;
    document.getElementById("resetAdminCode").focus();
  } catch (err) {
    errorEl.textContent = err.error || "Couldn't send a reset code. Please try again.";
  } finally {
    button.disabled = false;
  }
};

document.getElementById("resetAdminPasswordBtn").onclick = async () => {
  const email = document.getElementById("resetAdminEmail").value.trim();
  const code = document.getElementById("resetAdminCode").value.trim();
  const password = document.getElementById("resetAdminPassword").value;
  const confirmation = document.getElementById("resetAdminPasswordConfirm").value;
  const errorEl = document.getElementById("adminResetError");
  const messageEl = document.getElementById("adminResetMessage");
  const button = document.getElementById("resetAdminPasswordBtn");
  errorEl.textContent = "";
  messageEl.textContent = "";
  if (!code || !password || !confirmation) {
    errorEl.textContent = "Enter the reset code and both password fields.";
    return;
  }
  if (password !== confirmation) {
    errorEl.textContent = "The passwords do not match.";
    return;
  }
  if (password.length < 8) {
    errorEl.textContent = "Password should be at least 8 characters.";
    return;
  }

  button.disabled = true;
  try {
    const data = await api("/auth/admin/reset-password", {
      method: "POST",
      body: { email, code, password },
    });
    document.getElementById("adminResetFields").classList.add("hidden");
    document.getElementById("requestAdminResetCode").classList.add("hidden");
    messageEl.textContent = data.message;
  } catch (err) {
    errorEl.textContent = err.error || "Couldn't change the password. Please try again.";
  } finally {
    button.disabled = false;
  }
};

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
      cacheStudentSession(data.student, data.votingOpen);
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

/* ---------------- registration result pop-up ---------------- */
function showCredentialResult(data) {
  credEyebrow.textContent = "Registration complete";
  credName.textContent = "Check your email";
  credMessage.textContent = data.message || "";
  credOverlay.classList.add("show");
}

document.getElementById("credClose").onclick = () => {
  credOverlay.classList.remove("show");
  renderEntryStep();
};

/* ---------------- Full-screen voting experience ---------------- */
/* waiting / ballot / confirmation / already-voted all render here,   */
/* replacing the whole screen instead of living in the small login card. */
function enterFullscreen(mode) {
  voterSection.classList.add("hidden");
  publicPage.classList.add("hidden");
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
    <fieldset class="race">
      <legend class="eyebrow" style="margin-bottom:8px;">${escapeHtml(race.position)}</legend>
      ${race.candidates.map((c) => `
        <label class="candidate-vote-option">
          <input type="radio" name="race-${ri}" value="${escapeHtml(c.name)}">
          ${candidateProfileMarkup(c)}
        </label>`).join("")}
    </fieldset>`).join("");

  voteFullscreen.innerHTML = `
    <div class="ballot-inner">
      <div class="ballot-header">
        <p class="eyebrow">Hi, ${escapeHtml(firstName(currentStudent?.name || ""))} &middot; official ballot</p>
        <h2>Cast your vote</h2>
      </div>
      ${ballot.length ? `<div class="ballot-grid">${racesHtml}</div>` : '<p class="error-text" style="color:var(--muted);">No candidates have been set up yet. Please check with the election officer.</p>'}
      <p class="error-text" id="voteError"></p>
      <div class="ballot-submit-row">
        <button class="btn btn-primary" id="btnSubmitVote" ${ballot.length ? "" : "disabled"}>Submit vote</button>
      </div>
    </div>`;

  let savedSelections = {};
  try {
    savedSelections = JSON.parse(sessionStorage.getItem(BALLOT_SELECTIONS_KEY) || "{}");
  } catch (_error) {
    sessionStorage.removeItem(BALLOT_SELECTIONS_KEY);
  }
  ballot.forEach((race, ri) => {
    const savedName = savedSelections[race.position];
    if (!savedName) return;
    const option = Array.from(document.querySelectorAll(`input[name="race-${ri}"]`))
      .find((input) => input.value === savedName);
    if (option) option.checked = true;
  });
  voteFullscreen.querySelectorAll(".candidate-vote-option input").forEach((input) => {
    input.addEventListener("change", () => {
      const selections = {};
      ballot.forEach((race, ri) => {
        const selected = document.querySelector(`input[name="race-${ri}"]:checked`);
        if (selected) selections[race.position] = selected.value;
      });
      sessionStorage.setItem(BALLOT_SELECTIONS_KEY, JSON.stringify(selections));
    });
  });
  document.getElementById("btnSubmitVote").onclick = () => submitVote(ballot);
}

async function submitVote(ballot) {
  const errorEl = document.getElementById("voteError");
  const votes = {};
  for (let ri = 0; ri < ballot.length; ri++) {
    const race = ballot[ri];
    const checked = Array.from(document.querySelectorAll(`input[name="race-${ri}"]:checked`));
    if (checked.length) {
      votes[race.position] = checked[0].value;
    }
  }
  errorEl.textContent = "";

  const btn = document.getElementById("btnSubmitVote");
  btn.disabled = true;
  try {
    const res = await api("/vote", { method: "POST", token: studentToken, body: { votes } });
    sessionStorage.removeItem(BALLOT_SELECTIONS_KEY);
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
    cacheStudentSession(data.student, data.votingOpen);
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
  sessionStorage.removeItem(STUDENT_SESSION_KEY);
  sessionStorage.removeItem(BALLOT_SELECTIONS_KEY);
  currentStudent = null;
  voteFullscreen.classList.remove("show");
  renderEntryStep();
}

async function restoreSession() {
  if (adminToken) {
    try {
      const data = await api("/admin/me", { token: adminToken });
      currentAdmin = data.admin;
      cacheAdminSession(data.admin);
      openAdminDashboard(data.admin, sessionStorage.getItem(ADMIN_TAB_KEY));
      return;
    } catch (error) {
      if (isInvalidSession(error)) {
        clearAdminToken();
        sessionStorage.removeItem(ADMIN_SESSION_KEY);
        sessionStorage.removeItem(ADMIN_TAB_KEY);
      } else {
        try {
          currentAdmin = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY) || "null");
        } catch (_parseError) {
          sessionStorage.removeItem(ADMIN_SESSION_KEY);
        }
        if (currentAdmin) {
          openAdminDashboard(currentAdmin, sessionStorage.getItem(ADMIN_TAB_KEY));
          return;
        }
      }
    }
  }

  if (studentToken) {
    try {
      const data = await api("/me", { token: studentToken });
      currentStudent = data.student;
      cacheStudentSession(data.student, data.votingOpen);
      proceedAfterAuth(data.student, data.votingOpen);
      return;
    } catch (error) {
      if (isInvalidSession(error)) {
        clearStudentToken();
        sessionStorage.removeItem(STUDENT_SESSION_KEY);
        sessionStorage.removeItem(BALLOT_SELECTIONS_KEY);
      } else {
        let cachedSession;
        try {
          cachedSession = JSON.parse(sessionStorage.getItem(STUDENT_SESSION_KEY) || "null");
        } catch (_parseError) {
          sessionStorage.removeItem(STUDENT_SESSION_KEY);
        }
        if (cachedSession?.student) {
          currentStudent = cachedSession.student;
          proceedAfterAuth(cachedSession.student, cachedSession.votingOpen);
          return;
        }
      }
    }
  }

  currentAdmin = null;
  currentStudent = null;
  renderEntryStep();
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
    cacheAdminSession(data.admin);
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
function openAdminDashboard(admin, initialTab = "dashboard") {
  voterSection.classList.add("hidden");
  publicPage.classList.add("hidden");
  voteFullscreen.classList.remove("show");
  adminSection.classList.remove("hidden");
  document.getElementById("adminWho").textContent = `${admin.name} \u00b7 ${admin.email}`;
  switchAdminTab(initialTab);
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
  publicPage.classList.remove("hidden");
  voterSection.classList.remove("hidden");
  clearAdminToken();
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
  sessionStorage.removeItem(ADMIN_TAB_KEY);
  currentAdmin = null;
  resetToStart();
};

function switchAdminTab(tab) {
  const validTabs = ["dashboard", "students", "candidates", "qrcodes", "admins"];
  const activeTab = validTabs.includes(tab) ? tab : "dashboard";
  sessionStorage.setItem(ADMIN_TAB_KEY, activeTab);
  document.querySelectorAll(".sidebar-link").forEach((b) => b.classList.toggle("active", b.dataset.admintab === activeTab));
  ["dashboard", "students", "candidates", "qrcodes", "admins"].forEach((t) => {
    document.getElementById("adminPanel" + capitalize(t)).classList.toggle("hidden", t !== activeTab);
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
  const statRow = document.getElementById("statRow");
  statRow.innerHTML = `
    <div class="stat-card total-stat-card">
      <div class="stat-label">Total students</div>
      <div class="stat-num">${stats.total}</div>
    </div>
    <div class="metric-card-grid">
      <div class="stat-card metric-stat-card"><div class="stat-nume">${stats.registeredNotVoted}</div><div class="stat-label">Credentials issued</div></div>
      <div class="stat-card metric-stat-card"><div class="stat-numi">${stats.voted}</div><div class="stat-label">Voted</div></div>
    </div>`;

  document.getElementById("statusCardContainer").innerHTML = `
    <button class="stat-card status-card ${open ? "status-open" : "status-closed"}" id="statusCard">
      <span><span class="status-dot"></span><strong>${open ? "Voting OPEN" : "Voting CLOSED"}</strong></span>
      <span class="status-toggle-label">Click to ${open ? "close" : "open"} voting</span>
    </button>`;

  const chartTotal = Math.max(1, stats.total);
  const credentialAngle = (stats.registeredNotVoted / chartTotal) * 360;
  const votedAngle = credentialAngle + (stats.voted / chartTotal) * 360;
  const notRegistered = Math.max(0, stats.total - stats.registeredNotVoted - stats.voted);
  document.getElementById("participationChart").style.background = `conic-gradient(var(--blue-light) 0deg ${credentialAngle}deg, var(--success) ${credentialAngle}deg ${votedAngle}deg, rgba(255,255,255,.16) ${votedAngle}deg 360deg)`;
  document.getElementById("participationChart").innerHTML = `<span class="participation-chart-center"><strong>${Math.round((stats.voted / chartTotal) * 100)}%</strong><small>voted</small></span>`;
  document.getElementById("participationLegend").innerHTML = [
    ["Credentials issued", stats.registeredNotVoted, "var(--blue-light)"],
    ["Voted", stats.voted, "var(--success)"],
    ["Not registered", notRegistered, "rgba(255,255,255,.4)"],
  ].map(([label, value, color]) => `<div class="legend-item"><span class="legend-dot" style="background:${color}"></span><strong>${label}</strong><span>${Math.round((value / chartTotal) * 100)}% <small>(${value})</small></span></div>`).join("");

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
    const totalVotes = race.candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
    return `
      <div class="results-row">
        <h4 class="results-position">${escapeHtml(race.position)}</h4>
        ${race.candidates.map((candidate) => candidateProfileMarkup(candidate, {
          votes: candidate.votes,
          percent: totalVotes ? Math.round((candidate.votes / totalVotes) * 100) : 0,
        })).join("")}
      </div>`;
  }).join("");
}

/* ---- students: per-block summary cards + collapsible full roster ---- */
let cachedRoster = [];
let selectedRosterBlock = null;
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
          <div class="block-card" data-roster-block="${escapeHtml(key)}" title="Show students in ${escapeHtml(key)}">
            <h4>${escapeHtml(key)}</h4>
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

  grid.querySelectorAll("[data-roster-block]").forEach((card) => {
    card.onclick = () => {
      const block = card.dataset.rosterBlock;
      selectedRosterBlock = selectedRosterBlock === block ? null : block;
      document.querySelector(".roster-details").open = true;
      renderRosterTable();
      grid.querySelectorAll(".block-card").forEach((item) => item.classList.toggle("is-selected", item === card && selectedRosterBlock !== null));
    };
  });
}

async function renderRosterTable() {
  if (!cachedRoster.length) {
    try {
      const data = await api("/admin/students", { token: adminToken });
      cachedRoster = data.students || [];
    } catch (_err) { cachedRoster = []; }
  }
  const visibleRoster = selectedRosterBlock
    ? cachedRoster.filter((student) => (student.block || "No block") === selectedRosterBlock)
    : cachedRoster;
  document.getElementById("rosterCount").textContent = visibleRoster.length;
  document.getElementById("rosterFilterLabel").textContent = selectedRosterBlock ? `- ${selectedRosterBlock}` : "";
  const tbody = document.querySelector("#rosterTable tbody");
  tbody.innerHTML = visibleRoster.length
    ? visibleRoster.map((s) => `
      <tr>
        <td>${s.id_no}</td><td>${s.name}</td><td>${s.block || "&mdash;"}</td><td>${s.email || "&mdash;"}</td>
        <td>
          <span class="status-pill ${s.registered ? "yes" : "no"}">${s.registered ? "Issued" : "Not issued"}</span>
          ${s.registered ? `<button class="roster-resend-btn" data-resend-credentials="${encodeURIComponent(s.id_no)}" type="button">Resend</button>` : ""}
        </td>
        <td><span class="status-pill ${s.voted ? "yes" : "no"}">${s.voted ? "Yes" : "No"}</span></td>
      </tr>`).join("")
    : `<tr><td colspan="6" class="table-empty">No students yet.</td></tr>`;

  tbody.querySelectorAll("[data-resend-credentials]").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = "Sending...";
      try {
        const result = await api(`/admin/students/${button.dataset.resendCredentials}/resend-credentials`, { method: "POST", token: adminToken });
        alert(result.message);
      } catch (err) {
        alert(err.error || "Couldn't resend credentials.");
      } finally {
        button.disabled = false;
        button.textContent = "Resend";
      }
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
  let results = [];
  let resultsUnavailable = false;
  try {
    const candidateData = await api("/admin/candidates", { token: adminToken });
    candidates = candidateData.candidates || [];
  } catch (_err) {
    el.innerHTML = `<p class="error-text">Couldn't load candidates.</p>`;
    return;
  }
  try {
    const resultData = await api("/admin/results", { token: adminToken });
    results = resultData.results || [];
  } catch (_err) {
    resultsUnavailable = true;
  }
  const resultsByCandidate = new Map();
  results.forEach((race) => {
    const raceVotes = race.candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
    race.candidates.forEach((candidate) => resultsByCandidate.set(`${race.position}::${candidate.name}`, {
      votes: candidate.votes,
      percent: raceVotes ? Math.round((candidate.votes / raceVotes) * 100) : 0,
    }));
  });
  candidates = candidates.map((candidate) => ({
    ...candidate,
    result: resultsByCandidate.get(`${candidate.race_position || candidate.position}::${candidate.name}`) || { votes: 0, percent: 0 },
  }));
  if (!candidates.length) {
    el.innerHTML = `<p class="panel-note">No candidates yet. Use "Add Candidates" to get started.</p>`;
    return;
  }
  const byPosition = {};
  candidates.forEach((c) => {
    const position = c.race_position || c.position;
    if (!byPosition[position]) byPosition[position] = [];
    byPosition[position].push(c);
  });
  el.innerHTML = `${resultsUnavailable ? `<p class="panel-note">Candidate profiles are available, but vote totals couldn't be loaded.</p>` : ""}` + Object.entries(byPosition).map(([position, list]) => `
    <div class="candidate-position-group">
      <p class="candidate-position-title">${escapeHtml(position)}</p>
      ${list.map((c) => `
        <div class="candidate-list-row">
          ${candidateProfileMarkup(c, c.result)}
        </div>`).join("")}
    </div>`).join("");
}

const addCandidateOverlay = document.getElementById("addCandidateOverlay");
const candidateSearch = document.getElementById("candStudentSearch");
const candidateStudentSelect = document.getElementById("candStudent");
const candidateSearchStatus = document.getElementById("candidateSearchStatus");
const MAX_CANDIDATE_SEARCH_RESULTS = 100;

function renderCandidateStudentSearch() {
  const query = candidateSearch.value.trim().toLocaleLowerCase();
  candidateStudentSelect.value = "";

  if (query.length < 2) {
    candidateStudentSelect.innerHTML = `<option value="">Type at least 2 characters to search</option>`;
    candidateStudentSelect.disabled = true;
    candidateSearchStatus.textContent = cachedRoster.length
      ? "Search by student name, ID, or block."
      : "No students are available in the roster.";
    return;
  }

  const matches = cachedRoster.filter((student) =>
    [student.name, student.id_no, student.block]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query))
  );
  const visibleMatches = matches.slice(0, MAX_CANDIDATE_SEARCH_RESULTS);
  candidateStudentSelect.innerHTML = visibleMatches.length
    ? `<option value="">Select a student (${matches.length} match${matches.length === 1 ? "" : "es"})</option>` +
      visibleMatches.map((student) =>
        `<option value="${escapeHtml(student.id_no)}">${escapeHtml(student.name)} | ${escapeHtml(student.id_no)}${student.block ? ` | ${escapeHtml(student.block)}` : ""}</option>`
      ).join("")
    : `<option value="">No matching students</option>`;
  candidateStudentSelect.disabled = visibleMatches.length === 0;

  if (!matches.length) {
    candidateSearchStatus.textContent = "No students match. Try a different name, ID, or block.";
  } else if (matches.length > MAX_CANDIDATE_SEARCH_RESULTS) {
    candidateSearchStatus.textContent = `Showing the first ${MAX_CANDIDATE_SEARCH_RESULTS} of ${matches.length} matches. Add more search terms to narrow the results.`;
  } else {
    candidateSearchStatus.textContent = `${matches.length} student${matches.length === 1 ? "" : "s"} found.`;
  }
}

candidateSearch.addEventListener("input", renderCandidateStudentSearch);

document.getElementById("openAddCandidateModal").onclick = async () => {
  const errorEl = document.getElementById("candidateRosterError");
  errorEl.textContent = "";
  candidateSearch.value = "";
  candidateSearch.disabled = true;
  candidateStudentSelect.disabled = true;
  candidateStudentSelect.innerHTML = `<option value="">Loading student roster...</option>`;
  candidateSearchStatus.textContent = "Loading student roster...";
  addCandidateOverlay.classList.add("show");
  try {
    const data = await api("/admin/students", { token: adminToken });
    cachedRoster = data.students || [];
    candidateSearch.disabled = cachedRoster.length === 0;
    renderCandidateStudentSearch();
    if (!cachedRoster.length) errorEl.textContent = "Add students to the roster before adding candidates.";
  } catch (err) {
    candidateSearch.disabled = true;
    candidateStudentSelect.innerHTML = `<option value="">Roster unavailable</option>`;
    candidateSearchStatus.textContent = "";
    errorEl.textContent = err.error || "Couldn't load the student roster.";
  }
};
document.getElementById("closeAddCandidateModal").onclick = () => addCandidateOverlay.classList.remove("show");
document.getElementById("addCandidateBtn").onclick = async () => {
  const position = document.getElementById("candPosition").value.trim();
  const id_no = document.getElementById("candStudent").value;
  const party = document.getElementById("candParty").value.trim();
  const photoFile = document.getElementById("candPhoto").files[0];
  const errorEl = document.getElementById("candidateRosterError");
  errorEl.textContent = "";
  if (!position || !id_no) {
    errorEl.textContent = "Enter a position and select a student.";
    return;
  }
  const button = document.getElementById("addCandidateBtn");
  button.disabled = true;
  try {
    const photo = photoFile ? await fileAsDataUrl(photoFile) : "";
    await api("/admin/candidates", { method: "POST", token: adminToken, body: { position, id_no, party, photo } });
    document.getElementById("candPosition").value = "";
    candidateSearch.value = "";
    candidateStudentSelect.value = "";
    document.getElementById("candParty").value = "";
    document.getElementById("candPhoto").value = "";
    renderCandidateList(); renderResultsPanel();
    addCandidateOverlay.classList.remove("show");
  } catch (err) {
    errorEl.textContent = err.error || "Couldn't add that candidate.";
  } finally {
    button.disabled = false;
  }
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
        return `
          <div class="admin-list-row">
            <div class="admin-list-main">
              <div class="admin-list-name-row">
                <span class="admin-list-name">${escapeHtml(a.name)}</span>
                ${isSelf ? '<span class="status-pill yes">You</span>' : ""}
              </div>
              <div class="admin-list-meta">${escapeHtml(a.username)} &middot; ${escapeHtml(a.email)}</div>
              ${a.party_list ? `<div class="admin-list-party">Party list: ${escapeHtml(a.party_list)}</div>` : ""}
            </div>
          </div>`;
      }).join("")
    : `<p class="panel-note">No admin accounts yet.</p>`;

}

const addAdminOverlay = document.getElementById("addAdminOverlay");
document.getElementById("toggleAdminPassword").onclick = () => {
  const passwordInput = document.getElementById("admPassword2");
  const toggleButton = document.getElementById("toggleAdminPassword");
  const isVisible = passwordInput.type === "text";
  passwordInput.type = isVisible ? "password" : "text";
  toggleButton.innerHTML = isVisible ? "&#128065;" : "&#128065;&#xfe0e;";
  toggleButton.setAttribute("aria-label", isVisible ? "Show password" : "Hide password");
  toggleButton.setAttribute("title", isVisible ? "Show password" : "Hide password");
};
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
  const party_list = document.getElementById("admPartyList").value.trim();
  const username = document.getElementById("admUsername2").value.trim();
  const password = document.getElementById("admPassword2").value;
  try {
    await api("/admin/admins", { method: "POST", token: adminToken, body: { name, email, party_list, username, password } });
    ["admName", "admEmail2", "admPartyList", "admUsername2", "admPassword2"].forEach((id) => { document.getElementById(id).value = ""; });
    renderAdminList();
    addAdminOverlay.classList.remove("show");
  } catch (err) {
    errorEl.textContent = err.error || "Couldn't add that admin.";
  }
};

/* ---------------- Boot ---------------- */
restoreSession();
