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
const candidatePositionOrder = [
  "president",
  "vice president",
  "secretary",
  "treasurer",
  "auditor",
  "public information officer",
  "peace officer",
  "representative",
];

function candidatePositionRank(position) {
  const normalized = String(position || "").trim().toLocaleLowerCase();
  const basePosition = normalized.startsWith("representative - ")
    ? "representative"
    : normalized;
  const rank = candidatePositionOrder.indexOf(basePosition);
  return rank === -1 ? candidatePositionOrder.length : rank;
}

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
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (registrationOverlay.classList.contains("show")) closeRegistrationModal();
});


function loginFormHtml() {
  return `
    <div class="field">
      <input type="text" id="loginUser" placeholder="Username" autocomplete="off">
    </div>
    <div class="field password-field">
      <input type="password" id="loginPass" placeholder="Password" autocomplete="off">
      <button class="password-toggle" id="toggleLoginPassword" type="button" aria-label="Show password" title="Show password">&#128065;</button>
    </div>
    <p class="forgot-password-link"><a href="#" id="forgotAdminPassword">Forgot  password?</a></p>
    <p class="error-text" id="loginError"></p>
    <button class="btn btn-primary" id="btnLogin">Log in</button>
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

  ballot = [...ballot].sort((a, b) =>
    candidatePositionRank(a.position) - candidatePositionRank(b.position) ||
    String(a.position).localeCompare(String(b.position))
  );
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
      openAdminDashboard(data.admin, sessionStorage.getItem(ADMIN_TAB_KEY) || "votedesk");
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
          openAdminDashboard(currentAdmin, sessionStorage.getItem(ADMIN_TAB_KEY) || "votedesk");
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
let adminProfile = {
  name: "Erwin Gidoc",
  username: "erwin.gidoc",
  email: "admin@votedesk.example",
  picture: "",
};
let adminProfileOwner = "";
let signedOutAdmin = null;
let profilePictureDraft = "";

function openAdminDashboard(admin, initialTab = "votedesk") {
  const profileOwner = String(admin.id || admin.username || "sample-admin");
  if (adminProfileOwner !== profileOwner) {
    adminProfileOwner = profileOwner;
    adminProfile = {
      name: admin.name || "Erwin Gidoc",
      username: admin.username || "erwin.gidoc",
      email: admin.email || "admin@votedesk.example",
      picture: "",
    };
  }
  updateAdminProfileDisplay();
  voterSection.classList.add("hidden");
  publicPage.classList.add("hidden");
  voteFullscreen.classList.remove("show");
  adminSection.classList.remove("hidden");
  document.querySelector(".admin-sub").textContent = isStaffAccount() ? "Staff console" : "Admin console";
  switchAdminTab(initialTab);
  loadVoteDeskElections().then(() => {
    if (!isStaffAccount()) refreshAll();
  });
  startDashboardRefresh();
}

function isStaffAccount() {
  return currentAdmin?.role === "staff";
}

function initialsForName(name) {
  return String(name || "").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "EG";
}

function updateAdminProfileDisplay() {
  const initials = initialsForName(adminProfile.name);
  ["adminAvatar", "menuAvatar", "profileAvatar"].forEach((id) => {
    const avatar = document.getElementById(id);
    avatar.textContent = adminProfile.picture ? "" : initials;
    avatar.classList.toggle("has-picture", Boolean(adminProfile.picture));
    avatar.style.backgroundImage = adminProfile.picture ? `url("${adminProfile.picture}")` : "";
  });
  document.getElementById("menuAdminName").textContent = adminProfile.name;
  document.getElementById("accountButton").setAttribute("aria-label", `Account menu for ${adminProfile.name}`);
}

function closeTopbarMenus() {
  document.getElementById("notificationPanel").classList.add("hidden");
  document.getElementById("accountMenu").classList.add("hidden");
  document.getElementById("notificationButton").setAttribute("aria-expanded", "false");
  document.getElementById("accountButton").setAttribute("aria-expanded", "false");
}

function refreshAll() {
  renderStatRow();
  renderResultsPanel();
  renderBlockGrid();
  renderRosterTable();
  renderCandidateList();
  if (!isStaffAccount()) {
    renderSiteQr();
    renderAdminList();
  }
}
document.getElementById("adminLogout").onclick = () => {
  if (dashboardRefreshInterval) {
    clearInterval(dashboardRefreshInterval);
    dashboardRefreshInterval = null;
  }
  closeTopbarMenus();
  signedOutAdmin = currentAdmin || { name: adminProfile.name, username: adminProfile.username, email: adminProfile.email, role: "admin" };
  adminSection.classList.add("hidden");
  document.getElementById("signedOutScreen").classList.remove("hidden");
  clearAdminToken();
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
  sessionStorage.removeItem(ADMIN_TAB_KEY);
  currentAdmin = null;
};

function switchAdminTab(tab) {
  const adminTabs = ["votedesk", "dashboard", "students", "candidates", "qrcodes", "admins"];
  const staffTabs = ["dashboard", "students", "candidates"];
  const validTabs = isStaffAccount() ? staffTabs : adminTabs;
  const activeTab = validTabs.includes(tab) ? tab : "dashboard";
  sessionStorage.setItem(ADMIN_TAB_KEY, activeTab);
  document.querySelectorAll(".sidebar-link").forEach((button) => {
    button.classList.toggle("hidden", isStaffAccount() && !staffTabs.includes(button.dataset.admintab));
  });
  document.querySelector(".sidebar-admin-group").classList.toggle("hidden", isStaffAccount());
  document.querySelectorAll(".sidebar-link").forEach((b) => b.classList.toggle("active", b.dataset.admintab === activeTab));
  adminTabs.forEach((t) => {
    document.getElementById("adminPanel" + capitalize(t)).classList.toggle("hidden", t !== activeTab);
  });
  if (activeTab === "votedesk") renderVoteDeskDashboard();
  if (activeTab === "votedesk") loadVoteDeskElections();
}
document.querySelectorAll(".sidebar-link").forEach((btn) => {
  btn.addEventListener("click", () => switchAdminTab(btn.dataset.admintab));
});

/* ---------------- VoteDesk sample election dashboard ---------------- */
const voteDeskBlocks = ["Block A", "Block B", "Block C", "Block D", "Block E", "Block F"];
const voteDeskNameFirst = ["Amara", "Luis", "Mika", "Noah", "Sofia", "Ethan", "Isla", "Mateo", "Nina", "Caleb", "Leah", "Rafael", "Zoe", "Andre", "Maya", "Eli", "Clara", "Joaquin", "Iris", "Theo"];
const voteDeskNameLast = ["Santos", "Reyes", "Cruz", "Garcia", "Mendoza", "Bautista", "Flores", "Navarro", "Ramos", "Castillo", "Aquino", "Villanueva", "Rivera", "Torres", "Dela Cruz", "Lopez"];
let voteDeskElections = [];
let voteDeskSelectedId = "election-2025";
let voteDeskDropdownOpen = false;
let voteDeskDialogReturnFocus = null;
let voteDeskModal = { type: "", block: "", filter: "All", page: 1, showPasswords: false, position: "President", selectedBlock: "All blocks" };
let voteDeskDraft = { voters: [], fileName: "", skipped: 0, positions: [], sample: false };

function voteDeskMakeElection(config) {
  const election = {
    id: config.id,
    title: config.title,
    year: config.year,
    status: config.status,
    date: config.date,
    blocks: [],
    positions: [],
    ballotsCast: 0,
    blankBallots: 0,
    voters: [],
    sample: config.sample !== false,
  };
  election.positions = config.positions.map((position, positionIndex) => ({
    name: position.name,
    candidates: position.candidates.map((candidate, candidateIndex) => ({
      id: `${election.id}-${positionIndex}-${candidateIndex}`,
      name: candidate.name,
      slate: candidate.slate,
      initials: candidate.name.split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase(),
      weight: candidate.weight,
      votes: 0,
      blockVotes: {},
    })),
  }));
  config.blocks.forEach((totals, blockIndex) => {
    const blockName = voteDeskBlocks[blockIndex];
    const cast = config.status === "Upcoming" ? 0 : totals.turnout;
    const blank = cast ? Math.max(1, Math.round(cast * 0.02)) : 0;
    const block = { name: blockName, registered: totals.registered, cast, blank, votes: {} };
    election.ballotsCast += cast;
    election.blankBallots += blank;
    election.positions.forEach((position) => {
      const validVotes = cast - blank;
      const weightTotal = position.candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
      let allocated = 0;
      block.votes[position.name] = {};
      position.candidates.forEach((candidate, candidateIndex) => {
        const votes = candidateIndex === position.candidates.length - 1
          ? validVotes - allocated
          : Math.floor(validVotes * candidate.weight / weightTotal);
        allocated += votes;
        candidate.votes += votes;
        candidate.blockVotes[blockName] = votes;
        block.votes[position.name][candidate.id] = votes;
      });
    });
    election.blocks.push(block);

    for (let index = 0; index < totals.registered; index++) {
      const voterNumber = election.voters.length + 1;
      const hasCredentials = config.status === "Upcoming" || index < Math.round(totals.registered * 0.97);
      const first = voteDeskNameFirst[(voterNumber + blockIndex * 3) % voteDeskNameFirst.length];
      const last = voteDeskNameLast[(voterNumber * 3 + blockIndex) % voteDeskNameLast.length];
      const name = `${first} ${last}`;
      const username = `${first}.${last}.${String(voterNumber).padStart(3, "0")}`.toLowerCase();
      election.voters.push({
        id: `${election.year}-${String(voterNumber).padStart(4, "0")}`,
        name,
        block: blockName,
        username: hasCredentials ? username : "",
        password: hasCredentials ? `Sample-${String(voterNumber).padStart(4, "0")}` : "",
        hasCredentials,
        voted: config.status !== "Upcoming" && index < cast,
      });
    }
  });
  return election;
}

function voteDeskPosition(name, candidates) {
  return {
    name,
    candidates: candidates.map(([candidateName, slate, weight]) => ({
      name: candidateName,
      slate,
      weight,
    })),
  };
}

voteDeskElections = [
  voteDeskMakeElection({
    id: "election-2025", title: "2025 General Election", year: 2025, status: "Certified", date: "October 21, 2025",
    blocks: [{ registered: 126, turnout: 103 }, { registered: 108, turnout: 88 }, { registered: 143, turnout: 121 }, { registered: 97, turnout: 78 }, { registered: 119, turnout: 101 }, { registered: 132, turnout: 110 }],
    positions: [
      voteDeskPosition("President", [["Amara Villanueva", "Bagong Simula", 43], ["Luis Mendoza", "Unity Bloc", 35], ["Nina Ramos", "Independent", 22]]),
      voteDeskPosition("Vice President", [["Mika Reyes", "Unity Bloc", 39], ["Ethan Navarro", "Bagong Simula", 36], ["Sofia Castillo", "Independent", 25]]),
    ],
  }),
  voteDeskMakeElection({
    id: "election-2022", title: "2022 General Election", year: 2022, status: "Certified", date: "October 18, 2022",
    blocks: [{ registered: 112, turnout: 92 }, { registered: 95, turnout: 76 }, { registered: 128, turnout: 108 }, { registered: 104, turnout: 83 }, { registered: 117, turnout: 98 }, { registered: 121, turnout: 96 }],
    positions: [
      voteDeskPosition("President", [["Mateo Garcia", "Unity Bloc", 40], ["Leah Bautista", "Bagong Simula", 37], ["Andre Flores", "Independent", 23]]),
      voteDeskPosition("Vice President", [["Zoe Torres", "Bagong Simula", 42], ["Rafael Aquino", "Unity Bloc", 34], ["Clara Rivera", "Independent", 24]]),
    ],
  }),
  voteDeskMakeElection({
    id: "election-2019", title: "2019 General Election", year: 2019, status: "Archived", date: "October 15, 2019",
    blocks: [{ registered: 98, turnout: 73 }, { registered: 114, turnout: 91 }, { registered: 106, turnout: 84 }, { registered: 89, turnout: 67 }, { registered: 123, turnout: 101 }, { registered: 109, turnout: 80 }],
    positions: [
      voteDeskPosition("President", [["Maya Dela Cruz", "Bagong Simula", 45], ["Caleb Ramos", "Independent", 31], ["Isla Santos", "Unity Bloc", 24]]),
      voteDeskPosition("Vice President", [["Joaquin Lopez", "Unity Bloc", 38], ["Iris Navarro", "Bagong Simula", 36], ["Theo Castillo", "Independent", 26]]),
    ],
  }),
];

let voteDeskPersistentElections = [];
const voteDeskElectionDetails = new Map();
let voteDeskLoadError = "";
let voteDeskLoading = false;
let voteDeskLoadPromise = null;

function voteDeskIsPersistent(election = voteDeskElection()) {
  return Boolean(election?.persisted);
}

function voteDeskElection() {
  return voteDeskElections.find((election) => election.id === voteDeskSelectedId)
    || voteDeskPersistentElections.find((election) => election.id === voteDeskSelectedId)
    || voteDeskElections[0];
}

function loadVoteDeskElections() {
  if (voteDeskLoadPromise) return voteDeskLoadPromise;
  voteDeskLoadPromise = (async () => {
    voteDeskLoading = true;
    const storedElectionId = sessionStorage.getItem("ccdi_votedesk_election_id");
    document.getElementById("openAddStudentModal").classList.toggle("hidden", Boolean(storedElectionId));
    document.getElementById("openAddCandidateModal").classList.toggle("hidden", Boolean(storedElectionId));
    voteDeskLoadError = "";
    renderVoteDeskDashboard();
    try {
      const data = await api("/admin/elections", { token: adminToken });
      voteDeskPersistentElections = (data.elections || []).map((election) => ({
        ...election,
        title: election.title || election.name,
        date: election.date || election.election_date,
        blocks: [],
        positions: [],
        voters: [],
        blankBallots: 0,
        persisted: true,
      }));
      const storedElectionExists = [...voteDeskElections, ...voteDeskPersistentElections]
        .some((election) => election.id === storedElectionId);
      if (storedElectionExists) {
        voteDeskSelectedId = storedElectionId;
      } else if (voteDeskPersistentElections.length) {
        voteDeskSelectedId = voteDeskPersistentElections[0].id;
        sessionStorage.setItem("ccdi_votedesk_election_id", voteDeskSelectedId);
      } else {
        voteDeskSelectedId = voteDeskElections[0].id;
        sessionStorage.removeItem("ccdi_votedesk_election_id");
      }
      if (voteDeskIsPersistent()) await loadVoteDeskElectionDetails(voteDeskSelectedId);
    } catch (error) {
      voteDeskLoadError = error.error || "Couldn't load saved elections.";
    } finally {
      voteDeskLoading = false;
      renderVoteDeskDashboard();
    }
    await refreshSelectedElectionPanels();
  })().finally(() => {
    voteDeskLoadPromise = null;
  });
  return voteDeskLoadPromise;
}

async function loadVoteDeskElectionDetails(electionId) {
  const cachedElection = voteDeskElectionDetails.get(electionId);
  if (cachedElection) return cachedElection;
  const data = await api(`/admin/elections/${encodeURIComponent(electionId)}`, { token: adminToken });
  const election = { ...data.election, persisted: true };
  voteDeskElectionDetails.set(electionId, election);
  voteDeskPersistentElections = voteDeskPersistentElections.map((item) =>
    item.id === electionId ? { ...item, ...election, persisted: true } : item
  );
  return election;
}

async function selectVoteDeskElection(electionId) {
  voteDeskSelectedId = electionId;
  selectedRosterBlock = null;
  studentStatusFilter = "All";
  studentRosterPage = 1;
  sessionStorage.setItem("ccdi_votedesk_election_id", electionId);
  document.getElementById("openAddStudentModal").classList.toggle("hidden", voteDeskIsPersistent());
  document.getElementById("openAddCandidateModal").classList.toggle("hidden", voteDeskIsPersistent());
  voteDeskDropdownOpen = false;
  voteDeskLoadError = "";
  renderVoteDeskDashboard();
  if (voteDeskIsPersistent()) {
    try {
      await loadVoteDeskElectionDetails(electionId);
      renderVoteDeskDashboard();
    } catch (error) {
      voteDeskLoadError = error.error || "Couldn't load this election.";
      renderVoteDeskDashboard();
    }
  }
  await refreshSelectedElectionPanels();
}

function electionScopedAdminPath(path) {
  if (!voteDeskIsPersistent()) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}electionId=${encodeURIComponent(voteDeskElection().id)}`;
}

async function refreshSelectedElectionPanels() {
  const isPersistent = voteDeskIsPersistent();
  document.getElementById("openAddStudentModal").classList.toggle("hidden", isPersistent);
  document.getElementById("openAddCandidateModal").classList.toggle("hidden", isPersistent);
  await Promise.all([
    renderStatRow(),
    renderResultsPanel(),
    renderBlockGrid(),
    renderRosterTable(),
    renderCandidateList(),
  ]);
  if (voteDeskModal.type && voteDeskModal.type !== "create") renderVoteDeskDialog();
}

async function updateVoteDeskVoting(open) {
  const election = voteDeskElection();
  try {
    const data = await api(`/admin/elections/${encodeURIComponent(election.id)}/voting-open`, {
      method: "POST",
      token: adminToken,
      body: { open },
    });
    voteDeskElectionDetails.delete(election.id);
    const refreshed = await loadVoteDeskElectionDetails(election.id);
    voteDeskPersistentElections = voteDeskPersistentElections.map((item) =>
      item.id === election.id ? { ...item, ...data.election, ...refreshed, persisted: true } : item
    );
    renderVoteDeskDashboard();
    await refreshSelectedElectionPanels();
  } catch (error) {
    voteDeskLoadError = error.error || "Couldn't update voting status.";
    renderVoteDeskDashboard();
  }
}

async function updateVoteDeskStatus(status) {
  const election = voteDeskElection();
  try {
    await api(`/admin/elections/${encodeURIComponent(election.id)}/status`, {
      method: "POST",
      token: adminToken,
      body: { status },
    });
    voteDeskElectionDetails.delete(election.id);
    await loadVoteDeskElectionDetails(election.id);
    renderVoteDeskDashboard();
    await refreshSelectedElectionPanels();
  } catch (error) {
    voteDeskLoadError = error.error || "Couldn't update election status.";
    renderVoteDeskDashboard();
  }
}

function voteDeskWinner(position) {
  const [leader, runnerUp] = [...position.candidates].sort((a, b) => b.votes - a.votes);
  if (!leader || leader.votes === 0 || leader.votes === runnerUp?.votes) return null;
  return leader;
}

function voteDeskStatusClass(status) {
  return String(status).toLowerCase().replace(/\s+/g, "-");
}

function voteDeskAvatar(name, extraClass = "") {
  const initials = String(name || "?").split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
  return `<span class="vd-avatar ${extraClass}" aria-hidden="true">${escapeHtml(initials)}</span>`;
}

function renderVoteDeskDashboard() {
  const root = document.getElementById("voteDeskDashboard");
  if (!root) return;
  const election = voteDeskElection();
  if (voteDeskLoading) {
    root.innerHTML = `<p class="vd-loading-state">Loading saved election data…</p>`;
    return;
  }
  if (voteDeskIsPersistent(election) && !voteDeskElectionDetails.has(election.id)) {
    root.innerHTML = voteDeskLoadError
      ? `<p class="vd-alert" role="alert">${escapeHtml(voteDeskLoadError)} <button class="vd-button" type="button" data-vd-action="retry-elections">Try again</button></p>`
      : `<p class="vd-loading-state">Loading saved election data…</p>`;
    return;
  }
  const availableElections = [...voteDeskElections, ...voteDeskPersistentElections]
    .filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index)
    .sort((a, b) => b.year - a.year);
  const currentElections = availableElections.filter((item) => item.status !== "Archived");
  const archivedElections = availableElections.filter((item) => item.status === "Archived");
  const electionOption = (item) => `<button type="button" role="menuitem" class="vd-election-option ${item.id === election.id ? "is-selected" : ""}" data-vd-action="select-election" data-election-id="${escapeHtml(item.id)}"><span class="vd-election-option-copy"><strong>${item.year} · ${escapeHtml(item.title.replace(`${item.year} `, ""))}</strong><small>${escapeHtml(item.status)} · ${escapeHtml(item.date)}</small></span><span class="vd-election-check">${item.id === election.id ? "✓" : ""}</span></button>`;
  const registered = election.voters.length;
  const voted = election.voters.filter((voter) => voter.voted).length;
  const credentials = election.voters.filter((voter) => voter.hasCredentials).length;
  const turnout = registered ? Math.round(voted / registered * 100) : 0;
  const winners = election.positions.map((position) => {
    if (!position.candidates.length) return "";
    const winner = voteDeskWinner(position);
    const validVotes = position.candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
    const next = [...position.candidates].sort((a, b) => b.votes - a.votes)[1];
    const margin = winner && validVotes ? winner.votes - (next?.votes || 0) : 0;
    const certified = election.status === "Certified" || election.status === "Archived";
    const hasWinner = Boolean(winner && certified);
    const raceStatus = hasWinner
      ? "Winner"
      : certified ? validVotes ? "Tie" : "No votes"
        : election.votingOpen ? "In progress" : "Voting not started";
    const undecidedTitle = certified
      ? validVotes ? "Race ended in a tie" : "No votes cast for this position"
      : election.ballotsCast ? "Results are being counted" : "Winner not decided yet";
    const undecidedMessage = certified
      ? validVotes ? "The leading candidates received the same number of votes." : "This position received no votes."
      : election.votingOpen ? "Voting is open. Results are not final." : "Results will appear after voting begins.";
    return `<article class="vd-winner-card">
      <header class="vd-winner-band">
        <span class="vd-trophy" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 4h8v4a4 4 0 0 1-8 0V4ZM8 6H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4m-4 2v3m-4 3h8m-7-3h6v3H9z"/></svg></span>
        <h3>${escapeHtml(position.name)}</h3>
        <span class="vd-status ${hasWinner ? "vd-status-winner" : "vd-status-pending"}">${escapeHtml(raceStatus)}</span>
      </header>
      <div class="vd-winner-body">
        ${hasWinner ? `${voteDeskAvatar(winner.name, "vd-avatar-winner")}<div class="vd-winner-copy"><strong>${escapeHtml(winner.name)}</strong><span>${escapeHtml(winner.slate)}</span></div>
          <div class="vd-share-label"><span>Share of valid votes</span><strong>${Math.round(winner.votes / Math.max(1, validVotes) * 100)}%</strong></div>
          <div class="vd-progress"><span style="width:${Math.round(winner.votes / Math.max(1, validVotes) * 100)}%"></span></div>
          <div class="vd-winner-facts"><div><span>Votes</span><strong>${winner.votes.toLocaleString()}</strong></div><div><span>Won by</span><strong>${margin.toLocaleString()} votes</strong></div></div>`
          : `<div class="vd-undecided">${voteDeskAvatar("", "vd-avatar-winner")}<div><strong>${escapeHtml(undecidedTitle)}</strong><span>${escapeHtml(undecidedMessage)}</span></div></div>`}
      </div>
    </article>`;
  }).join("");

  root.innerHTML = `
    <header class="vd-page-header">
      <div class="vd-page-title"><span class="vd-eyebrow">Election dashboard ${election.sample ? '<span class="vd-sample-chip">SAMPLE DATA</span>' : ""}</span><h1>${escapeHtml(election.title)}</h1>
        <div class="vd-meta"><span class="vd-status vd-status-${voteDeskStatusClass(election.status)}">${escapeHtml(election.status)}</span>${election.votingOpen ? '<span class="vd-status vd-status-winner">Voting open</span>' : ""}<span>${escapeHtml(election.date)}</span><span>${election.ballotsCast.toLocaleString()} ballots cast</span></div>
      </div>
      ${voteDeskIsPersistent(election) ? `<div class="vd-election-management">${election.status !== "Certified" && election.status !== "Archived" ? `<button class="vd-button vd-button-primary" type="button" data-vd-action="toggle-voting">${election.votingOpen ? "Close & archive" : "Open voting"}</button>` : ""}${!election.votingOpen && election.status !== "Certified" && election.status !== "Archived" ? `<button class="vd-button" type="button" data-vd-action="certify-election">Certify results</button>` : ""}${!election.votingOpen && election.status === "Certified" ? `<button class="vd-button" type="button" data-vd-action="archive-election">Archive election</button>` : ""}</div>` : ""}
    </header>
    <div class="vd-toolbar">
      <div class="vd-election-picker">
        <button class="vd-button vd-button-primary" type="button" data-vd-action="toggle-elections" aria-expanded="${voteDeskDropdownOpen}">${escapeHtml(election.title)} <span aria-hidden="true">&#9662;</span></button>
        ${voteDeskDropdownOpen ? `<div class="vd-election-menu" role="menu">${currentElections.length ? `<p class="vd-election-group-title">Elections</p>${currentElections.map(electionOption).join("")}` : ""}${archivedElections.length ? `<div class="vd-election-menu-divider"></div><p class="vd-election-group-title">Archived</p>${archivedElections.map(electionOption).join("")}` : ""}${voteDeskLoadError ? `<p class="vd-load-error">${escapeHtml(voteDeskLoadError)}</p>` : ""}<div class="vd-election-menu-divider"></div><button class="vd-create-election-row" type="button" data-vd-action="create-election">+ Create new election</button></div>` : ""}
      </div>
      <button class="vd-button" type="button" data-vd-action="participants">Participants</button>
      <button class="vd-button" type="button" data-vd-action="candidates">Candidates</button>
      <button class="vd-button" type="button" data-vd-action="votes">Votes by block</button>
    </div>
    <section class="vd-summary-grid" aria-label="Election summary">
      <article class="vd-summary-card"><span>Registered voters</span><strong>${registered.toLocaleString()}</strong><small>Across ${election.blocks.length} blocks</small></article>
      <article class="vd-summary-card"><span>Voted</span><strong>${voted.toLocaleString()}</strong><small>${turnout}% turnout</small></article>
      <article class="vd-summary-card"><span>Username and password generated</span><strong>${credentials.toLocaleString()}</strong><small>${(registered - credentials).toLocaleString()} voters still have none</small></article>
      <article class="vd-summary-card"><span>Did not vote</span><strong>${(registered - voted).toLocaleString()}</strong><small>Of registered voters</small></article>
    </section>
    ${voteDeskLoadError ? `<p class="vd-alert" role="alert">${escapeHtml(voteDeskLoadError)}</p>` : ""}
    <section class="vd-winners-section"><div class="vd-section-heading"><div><span class="vd-eyebrow">Election results</span><h2>Winners</h2></div><span class="vd-section-note">${election.status === "Certified" || election.status === "Archived" ? `${election.ballotsCast.toLocaleString()} ballots counted` : "Results pending certification"}</span></div><div class="vd-winners-grid">${winners}</div></section>`;
}

const voteDeskDashboard = document.getElementById("voteDeskDashboard");
voteDeskDashboard.addEventListener("click", (event) => {
  const button = event.target.closest("[data-vd-action]");
  if (!button) {
    if (voteDeskDropdownOpen && !event.target.closest(".vd-election-picker")) {
      voteDeskDropdownOpen = false;
      renderVoteDeskDashboard();
    }
    return;
  }
  const action = button.dataset.vdAction;
  if (action === "toggle-elections") {
    voteDeskDropdownOpen = !voteDeskDropdownOpen;
    renderVoteDeskDashboard();
  } else if (action === "select-election") {
    selectVoteDeskElection(button.dataset.electionId);
  } else if (action === "participants") {
    openVoteDeskDialog("participants");
  } else if (action === "candidates") {
    openVoteDeskDialog("candidates");
  } else if (action === "votes") {
    openVoteDeskDialog("votes");
  } else if (action === "create-election") {
    voteDeskDropdownOpen = false;
    renderVoteDeskDashboard();
    openVoteDeskDialog("create");
  } else if (action === "toggle-voting") {
    updateVoteDeskVoting(!voteDeskElection().votingOpen);
  } else if (action === "certify-election") {
    updateVoteDeskStatus("Certified");
  } else if (action === "archive-election") {
    updateVoteDeskStatus("Archived");
  } else if (action === "retry-elections") {
    loadVoteDeskElections();
  }
});

document.addEventListener("click", (event) => {
  if (!voteDeskDropdownOpen || event.target.closest(".vd-election-picker")) return;
  voteDeskDropdownOpen = false;
  if (sessionStorage.getItem(ADMIN_TAB_KEY) === "votedesk") renderVoteDeskDashboard();
});

const voteDeskOverlay = document.getElementById("voteDeskOverlay");
const voteDeskDialogContent = document.getElementById("voteDeskDialogContent");
document.getElementById("voteDeskDialogClose").addEventListener("click", closeVoteDeskDialog);
voteDeskOverlay.addEventListener("click", (event) => {
  if (event.target === voteDeskOverlay) closeVoteDeskDialog();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && voteDeskOverlay.classList.contains("show")) closeVoteDeskDialog();
});

function voteDeskDialogHeader(title, subtitle) {
  return `<p class="vd-eyebrow">Election details</p><h2 id="voteDeskDialogTitle">${escapeHtml(title)}</h2><p class="vd-dialog-subtitle">${escapeHtml(subtitle)}</p>`;
}

function openVoteDeskDialog(type) {
  voteDeskModal = { type, block: "", filter: "All", page: 1, showPasswords: false, position: "President", selectedBlock: "All blocks" };
  if (type === "create") {
    voteDeskDraft = {
      voters: [], fileName: "", skipped: 0, name: "", year: "", date: "", sample: false,
      positions: [
        { name: "President", candidates: "" },
        { name: "Vice President", candidates: "" },
      ],
    };
  }
  voteDeskDialogReturnFocus = document.activeElement;
  renderVoteDeskDialog();
  voteDeskOverlay.classList.add("show");
  voteDeskOverlay.setAttribute("aria-hidden", "false");
  document.getElementById("voteDeskDialogClose").focus();
}

function closeVoteDeskDialog() {
  voteDeskOverlay.classList.remove("show");
  voteDeskOverlay.setAttribute("aria-hidden", "true");
  if (voteDeskDialogReturnFocus?.isConnected) voteDeskDialogReturnFocus.focus();
}

function voteDeskStat(label, value, note = "") {
  return `<article class="vd-dialog-stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ""}</article>`;
}

function renderVoteDeskDialog() {
  const election = voteDeskElection();
  if (voteDeskModal.type === "participants") renderVoteDeskParticipants(election);
  if (voteDeskModal.type === "candidates") renderVoteDeskCandidates(election);
  if (voteDeskModal.type === "votes") renderVoteDeskVotes(election);
  if (voteDeskModal.type === "create") renderVoteDeskCreate();
}

function renderVoteDeskParticipants(election) {
  const voted = election.voters.filter((voter) => voter.voted).length;
  const credentials = election.voters.filter((voter) => voter.hasCredentials).length;
  if (!voteDeskModal.block) {
    voteDeskDialogContent.innerHTML = `${voteDeskDialogHeader("Participants", `${election.title} · ${voteDeskIsPersistent(election) ? "saved voter list" : "sample voter list"}`)}
      <div class="vd-dialog-stats">${voteDeskStat("Registered voters", election.voters.length.toLocaleString())}${voteDeskStat("Voted", voted.toLocaleString())}${voteDeskStat("Credentials generated", credentials.toLocaleString())}</div>
      <div class="vd-block-grid">${election.blocks.map((block) => {
        const blockVoters = election.voters.filter((voter) => voter.block === block.name);
        const blockVoted = blockVoters.filter((voter) => voter.voted).length;
        const blockCreds = blockVoters.filter((voter) => voter.hasCredentials).length;
        const turnout = blockVoters.length ? Math.round(blockVoted / blockVoters.length * 100) : 0;
        return `<button type="button" class="vd-block-card" data-vd-action="open-block" data-block="${escapeHtml(block.name)}"><span class="vd-block-card-title">${escapeHtml(block.name)} <span aria-hidden="true">&#8594;</span></span><span class="vd-block-card-metrics"><span><strong>${blockVoters.length}</strong> registered</span><span><strong>${blockVoted}</strong> voted · ${turnout}%</span><span><strong>${blockCreds}</strong> credentials</span></span><span class="vd-progress"><span style="width:${turnout}%"></span></span><span class="vd-view-cue">View participants</span></button>`;
      }).join("")}</div>`;
    return;
  }

  const blockVoters = election.voters.filter((voter) => voter.block === voteDeskModal.block);
  const statuses = blockVoters.map((voter) => !voter.hasCredentials ? "No credentials" : voter.voted ? "Voted" : "Not voted");
  const filters = ["All", "Voted", "Not voted", "No credentials"];
  const statusCounts = Object.fromEntries(filters.map((filter) => [filter, filter === "All" ? blockVoters.length : statuses.filter((status) => status === filter).length]));
  const filtered = blockVoters.filter((voter) => {
    const status = !voter.hasCredentials ? "No credentials" : voter.voted ? "Voted" : "Not voted";
    return voteDeskModal.filter === "All" || voteDeskModal.filter === status;
  }).sort((a, b) => a.name.localeCompare(b.name));
  const totalPages = Math.max(1, Math.ceil(filtered.length / 20));
  voteDeskModal.page = Math.min(voteDeskModal.page, totalPages);
  const start = (voteDeskModal.page - 1) * 20;
  const shown = filtered.slice(start, start + 20);
  const blockVoted = blockVoters.filter((voter) => voter.voted).length;
  const blockCreds = blockVoters.filter((voter) => voter.hasCredentials).length;

  voteDeskDialogContent.innerHTML = `${voteDeskDialogHeader(`${voteDeskModal.block} participants`, `${election.title} · sorted by participant name`)}
    <div class="vd-dialog-toolbar"><button class="vd-button" type="button" data-vd-action="all-blocks">&#8592; All blocks</button><button class="vd-button" type="button" data-vd-action="toggle-passwords" ${voteDeskIsPersistent(election) ? "disabled title=\"Passwords cannot be retrieved from secure password hashes.\"" : ""}>${voteDeskModal.showPasswords ? "Hide passwords" : "Show passwords"}</button></div>
    <div class="vd-dialog-stats vd-dialog-stats-compact">${voteDeskStat("Registered", blockVoters.length.toLocaleString())}${voteDeskStat("Voted", blockVoted.toLocaleString())}${voteDeskStat("Credentials generated", blockCreds.toLocaleString())}</div>
    <div class="vd-filter-row">${filters.map((filter) => `<button type="button" class="vd-filter ${voteDeskModal.filter === filter ? "is-active" : ""}" data-vd-action="filter" data-filter="${escapeHtml(filter)}">${escapeHtml(filter)} <span>${statusCounts[filter]}</span></button>`).join("")}</div>
    <div class="vd-table-wrap"><table class="vd-table"><thead><tr><th>Voter ID</th><th>Participant</th><th>Block</th><th>Username</th><th>Password</th><th>Status</th></tr></thead><tbody>${shown.length ? shown.map((voter) => {
      const status = !voter.hasCredentials ? "No credentials" : voter.voted ? "Voted" : "Not voted";
      return `<tr><td class="vd-mono">${escapeHtml(voter.id)}</td><td>${escapeHtml(voter.name)}</td><td>${escapeHtml(voter.block)}</td><td class="vd-mono">${escapeHtml(voter.username || "—")}</td><td class="vd-mono">${voter.password ? escapeHtml(voteDeskModal.showPasswords ? voter.password : "••••••••") : "—"}</td><td><span class="vd-status vd-status-${voteDeskStatusClass(status)}">${escapeHtml(status)}</span></td></tr>`;
    }).join("") : `<tr><td colspan="6" class="vd-empty-cell">No participants match this filter.</td></tr>`}</tbody></table></div>
    <div class="vd-pagination"><span>Showing ${filtered.length ? start + 1 : 0} to ${Math.min(start + 20, filtered.length)} of ${filtered.length}</span><div><button class="vd-button" type="button" data-vd-action="previous-page" ${voteDeskModal.page <= 1 ? "disabled" : ""}>Previous</button><button class="vd-button" type="button" data-vd-action="next-page" ${voteDeskModal.page >= totalPages ? "disabled" : ""}>Next</button></div></div>
    <p class="vd-security-note">${voteDeskIsPersistent(election) ? "Passwords are not available after creation; the system stores only hashed passwords. Check Students for delivery status and resend credentials if needed." : "Sample credentials are shown for demonstration. A live system should store only hashed passwords."}</p>`;
}

function renderVoteDeskCandidates(election) {
  const finalized = election.status === "Certified" || election.status === "Archived";
  voteDeskDialogContent.innerHTML = `${voteDeskDialogHeader("Candidates", `${election.title} · ${voteDeskIsPersistent(election) ? "election candidate results" : "sample candidate results"}`)}
    ${election.positions.map((position) => {
      const valid = position.candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
      const winner = voteDeskWinner(position);
      return `<section class="vd-candidate-section"><header><h3>${escapeHtml(position.name)}</h3><span>${valid.toLocaleString()} valid votes</span></header>
        <div class="vd-candidate-list">${position.candidates.slice().sort((a, b) => b.votes - a.votes).map((candidate) => {
          const share = valid ? Math.round(candidate.votes / valid * 100) : 0;
          const state = !finalized || !valid ? "Pending" : !winner ? "Tie" : candidate.id === winner.id ? "Won" : "Lost";
          const stateClass = state === "Won" ? "vd-status-winner" : state === "Lost" ? "vd-status-lost" : "vd-status-pending";
          return `<article class="vd-candidate-row">${voteDeskAvatar(candidate.name)}<div class="vd-candidate-main"><strong>${escapeHtml(candidate.name)}</strong><span>Ballot ${String(position.candidates.indexOf(candidate) + 1).padStart(2, "0")} · ${escapeHtml(candidate.slate)}</span><div class="vd-block-chips">${election.blocks.map((block) => `<span>${escapeHtml(block.name.replace("Block ", ""))} <b>${candidate.blockVotes[block.name] || 0}</b></span>`).join("")}</div></div><div class="vd-candidate-result"><strong>${candidate.votes.toLocaleString()} votes</strong><span>${share}% share</span><span class="vd-status ${stateClass}">${state}</span></div></article>`;
        }).join("")}</div></section>`;
    }).join("")}`;
}

function renderVoteDeskVotes(election) {
  const position = election.positions.find((item) => item.name === voteDeskModal.position) || election.positions[0];
  if (!position) {
    voteDeskDialogContent.innerHTML = `${voteDeskDialogHeader("Votes by block", `${election.title} · no positions`)}<p class="vd-empty-state">No positions have been added to this election.</p>`;
    return;
  }
  const blocks = voteDeskModal.selectedBlock === "All blocks"
    ? election.blocks
    : election.blocks.filter((block) => block.name === voteDeskModal.selectedBlock);
  const candidateVotes = (block, candidate) => block.votes[position.name]?.[candidate.id] || 0;
  const rows = blocks.map((block) => {
    const ranked = position.candidates.map((candidate) => ({ candidate, votes: candidateVotes(block, candidate) }))
      .sort((a, b) => b.votes - a.votes);
    const leader = ranked[0];
    const uniqueLeader = leader?.votes > 0 && leader.votes !== ranked[1]?.votes;
    const leadLabel = uniqueLeader ? leader.candidate.name : leader?.votes ? "Tie" : "No votes";
    return `<tr><td><strong>${escapeHtml(block.name)}</strong></td><td class="vd-mono">${block.registered}</td><td class="vd-mono">${block.cast}</td><td class="vd-mono">${block.registered ? Math.round(block.cast / block.registered * 100) : 0}%</td>${position.candidates.map((candidate) => `<td class="vd-mono ${uniqueLeader && leader.candidate.id === candidate.id ? "vd-leading-cell" : ""}">${candidateVotes(block, candidate)}</td>`).join("")}<td class="vd-mono">${block.blank}</td><td>${block.cast ? `<span class="vd-status ${uniqueLeader ? "vd-status-winner" : "vd-status-pending"}">${escapeHtml(leadLabel)}</span>` : `<span class="vd-status vd-status-pending">Pending</span>`}</td></tr>`;
  }).join("");
  const totalWinner = voteDeskWinner(position);
  const positionVotes = position.candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
  const totalLeaderLabel = totalWinner
    ? `<strong>${escapeHtml(totalWinner.name)}</strong>`
    : positionVotes ? `<span class="vd-status vd-status-pending">Tie</span>`
      : election.ballotsCast ? `<span class="vd-status vd-status-pending">No votes</span>`
        : `<span class="vd-status vd-status-pending">Pending</span>`;
  const totalRow = voteDeskModal.selectedBlock === "All blocks" ? `<tr class="vd-total-row"><td>All blocks</td><td class="vd-mono">${election.blocks.reduce((sum, block) => sum + block.registered, 0)}</td><td class="vd-mono">${election.ballotsCast}</td><td class="vd-mono">${election.voters.length ? Math.round(election.ballotsCast / election.voters.length * 100) : 0}%</td>${position.candidates.map((candidate) => `<td class="vd-mono">${candidate.votes}</td>`).join("")}<td class="vd-mono">${election.blankBallots}</td><td>${totalLeaderLabel}</td></tr>` : "";
  const selected = blocks[0];
  const valid = selected ? position.candidates.reduce((sum, candidate) => sum + candidateVotes(selected, candidate), 0) : 0;
  voteDeskDialogContent.innerHTML = `${voteDeskDialogHeader("Votes by block", `${election.title} · ballot totals by block`)}
    <div class="vd-vote-controls"><div class="vd-filter-row">${election.positions.map((item) => `<button class="vd-filter ${item.name === position.name ? "is-active" : ""}" type="button" data-vd-action="vote-position" data-position="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button>`).join("")}</div><div class="vd-filter-row vd-block-filters">${["All blocks", ...election.blocks.map((block) => block.name)].map((name) => `<button class="vd-filter ${voteDeskModal.selectedBlock === name ? "is-active" : ""}" type="button" data-vd-action="vote-block" data-block="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("")}</div></div>
    <div class="vd-table-wrap"><table class="vd-table vd-votes-table"><thead><tr><th>Block</th><th>Registered</th><th>Cast</th><th>Turnout</th>${position.candidates.map((candidate) => `<th>${escapeHtml(candidate.name)}</th>`).join("")}<th>Blank</th><th>Leading</th></tr></thead><tbody>${rows}${totalRow}</tbody></table></div>
    ${voteDeskModal.selectedBlock !== "All blocks" && selected ? `<section class="vd-breakdown"><h3>${escapeHtml(selected.name)} · valid vote share</h3>${position.candidates.map((candidate) => {
      const votes = candidateVotes(selected, candidate);
      const share = valid ? Math.round(votes / valid * 100) : 0;
      return `<div class="vd-breakdown-row"><div><span>${escapeHtml(candidate.name)}</span><strong>${votes} · ${share}%</strong></div><span class="vd-progress"><span style="width:${share}%"></span></span></div>`;
    }).join("")}</section>` : ""}`;
}

function voteDeskParseCsv(text) {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim()).map((line) => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((value) => value.trim().replace(/^"|"$/g, "").replace(/""/g, '"')));
  if (rows.length && rows[0][0]?.toLowerCase() === "name" && rows[0][1]?.toLowerCase() === "block" && rows[0][2]?.toLowerCase() === "email") rows.shift();
  const voters = [];
  let skipped = 0;
  rows.forEach((row) => {
    const name = (row[0] || "").trim();
    const block = (row[1] || "").trim();
    if (!name || !block) {
      skipped++;
      return;
    }
    voters.push({ name, block, email: (row[2] || "").trim() });
  });
  return { voters, skipped };
}

function renderVoteDeskCreate() {
  const blocks = [...new Set(voteDeskDraft.voters.map((voter) => voter.block))].sort((a, b) => a.localeCompare(b));
  const counts = blocks.map((block) => [block, voteDeskDraft.voters.filter((voter) => voter.block === block).length]);
  voteDeskDialogContent.innerHTML = `${voteDeskDialogHeader("Create new election", "Prepare an upcoming election with a voter list and candidate positions.")}
    <div id="vdCreateErrors" class="vd-alert hidden" role="alert"></div>
    <form id="vdCreateElectionForm" novalidate>
      <div class="vd-form-grid"><label>Election name<input name="name" required placeholder="General Election" value="${escapeHtml(voteDeskDraft.name)}"></label><label>Year<input name="year" required inputmode="numeric" placeholder="2027" value="${escapeHtml(voteDeskDraft.year)}"></label><label class="vd-form-full">Election day<input name="date" type="date" required value="${escapeHtml(voteDeskDraft.date)}"></label></div>
      <section class="vd-create-section"><h3>Voter list</h3><p>CSV columns: <strong>name, block, email</strong>. Header row is optional. Example: <code>Maria Santos, Block A, maria@example.com</code>. Voters are grouped by the block column and credentials are emailed. Sample-list credentials are not emailed.</p><div class="vd-upload-actions"><label class="vd-button vd-file-button">Choose CSV file<input id="vdVoterCsv" type="file" accept=".csv,text/csv"></label><button class="vd-button" type="button" data-vd-action="sample-list">Use a sample list</button></div>
      ${voteDeskDraft.fileName ? `<div class="vd-upload-summary"><strong>${voteDeskDraft.voters.length} voters in ${counts.length} blocks</strong><span>${escapeHtml(voteDeskDraft.fileName)}</span><div class="vd-block-chips">${counts.map(([block, count]) => `<span>${escapeHtml(block)} <b>${count}</b></span>`).join("")}</div>${voteDeskDraft.skipped ? `<small>${voteDeskDraft.skipped} rows skipped because name or block was missing.</small>` : ""}<button class="vd-text-button" type="button" data-vd-action="remove-file">Remove file</button></div>` : `<p class="vd-upload-empty">No voter list selected.</p>`}
      </section>
      <section class="vd-create-section"><div class="vd-position-heading"><div><h3>Positions and candidates</h3><p>One candidate per line. Use <code>Name, Slate</code>; omit a slate for Independent.</p></div><button class="vd-button" type="button" data-vd-action="add-position" ${voteDeskDraft.positions.length >= 6 ? "disabled" : ""}>Add position</button></div>
        <div class="vd-position-editors">${voteDeskDraft.positions.map((position, index) => `<div class="vd-position-editor"><div><label>Position name<input data-position-index="${index}" data-position-field="name" value="${escapeHtml(position.name)}" placeholder="Position name"></label><button class="vd-text-button vd-remove-position" type="button" data-vd-action="remove-position" data-position-index="${index}" aria-label="Remove ${escapeHtml(position.name || "position")}">Remove</button></div><label>Candidates<textarea data-position-index="${index}" data-position-field="candidates" rows="3" placeholder="Maria Santos, Bagong Simula&#10;Juan Reyes, Unity Bloc">${escapeHtml(position.candidates)}</textarea></label></div>`).join("")}</div>
      </section>
      <div class="vd-dialog-actions"><button class="vd-button" type="button" data-vd-action="cancel-create">Cancel</button><button class="vd-button vd-button-primary" type="submit">Create election</button></div>
    </form>`;
}

function voteDeskCollectDraftInputs() {
  voteDeskDialogContent.querySelectorAll("[data-position-index][data-position-field]").forEach((input) => {
    const position = voteDeskDraft.positions[Number(input.dataset.positionIndex)];
    if (position) position[input.dataset.positionField] = input.value;
  });
}

async function voteDeskCreateElection() {
  voteDeskCollectDraftInputs();
  const form = document.getElementById("vdCreateElectionForm");
  const name = form.querySelector('[name="name"]').value.trim();
  const yearText = form.querySelector('[name="year"]').value.trim();
  const date = form.querySelector('[name="date"]').value;
  const errors = [];
  if (!name) errors.push("Enter an election name.");
  if (!/^\d{4}$/.test(yearText) || Number(yearText) < 1900 || Number(yearText) > 9999) errors.push("Enter a valid four-digit year.");
  if (!voteDeskDraft.voters.length) errors.push("Add a voter list before creating the election.");
  if (!voteDeskDraft.sample && voteDeskDraft.voters.some((voter) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(voter.email || ""))) {
    errors.push("Every voter needs a valid email address so credentials can be delivered.");
  }
  if (!date) errors.push("Choose an election day.");
  voteDeskDraft.positions.forEach((position, index) => {
    const parsedCandidates = position.candidates.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    position.parsedCandidates = parsedCandidates.map((line) => {
      const [candidateName, ...slateParts] = line.split(",");
      return { name: candidateName.trim(), slate: slateParts.join(",").trim() || "Independent", weight: 1 };
    }).filter((candidate) => candidate.name);
    if (!position.name.trim()) errors.push(`Position ${index + 1} needs a name.`);
    if (position.parsedCandidates.length < 2) errors.push(`${position.name.trim() || `Position ${index + 1}`} needs at least two candidates.`);
    const voterNames = new Map();
    voteDeskDraft.voters.forEach((voter) => {
      const key = voter.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
      voterNames.set(key, (voterNames.get(key) || 0) + 1);
    });
    const candidateKeys = new Set();
    position.parsedCandidates.forEach((candidate) => {
      const key = candidate.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
      if (voterNames.get(key) !== 1) {
        errors.push(`Candidate "${candidate.name}" must uniquely match a name in the voter list.`);
      }
      if (candidateKeys.has(key)) errors.push(`Candidate "${candidate.name}" is listed more than once for ${position.name || `Position ${index + 1}`}.`);
      candidateKeys.add(key);
    });
  });
  if (errors.length) {
    const alert = document.getElementById("vdCreateErrors");
    alert.innerHTML = `<strong>Check the following before creating:</strong><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`;
    alert.classList.remove("hidden");
    alert.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }

  const submitButton = document.querySelector('#vdCreateElectionForm [type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Creating…";
  try {
    const response = await api("/admin/elections", {
      method: "POST",
      token: adminToken,
      body: {
        name,
        year: Number(yearText),
        date,
        sample: voteDeskDraft.sample,
        voters: voteDeskDraft.voters,
        positions: voteDeskDraft.positions.map((position) => ({
          name: position.name.trim(),
          candidates: position.parsedCandidates.map(({ name: candidateName, slate }) => ({ name: candidateName, slate })),
        })),
      },
    });
    voteDeskSelectedId = response.election.id;
    selectedRosterBlock = null;
    studentStatusFilter = "All";
    studentRosterPage = 1;
    sessionStorage.setItem("ccdi_votedesk_election_id", voteDeskSelectedId);
    voteDeskElectionDetails.delete(voteDeskSelectedId);
    voteDeskDropdownOpen = false;
    closeVoteDeskDialog();
    await loadVoteDeskElections();
    if (response.delivery?.failed) {
      voteDeskLoadError = `${response.delivery.failed} credential email${response.delivery.failed === 1 ? "" : "s"} could not be delivered.`;
      renderVoteDeskDashboard();
    }
  } catch (error) {
    const alert = document.getElementById("vdCreateErrors");
    alert.innerHTML = `<strong>Election could not be created:</strong><ul><li>${escapeHtml(error.error || "Please check your information and try again.")}</li></ul>`;
    alert.classList.remove("hidden");
    alert.scrollIntoView({ block: "nearest", behavior: "smooth" });
    submitButton.disabled = false;
    submitButton.textContent = "Create election";
  }
}

voteDeskDialogContent.addEventListener("click", (event) => {
  const button = event.target.closest("[data-vd-action]");
  if (!button) return;
  const action = button.dataset.vdAction;
  if (action === "open-block") {
    voteDeskModal.block = button.dataset.block;
    voteDeskModal.filter = "All";
    voteDeskModal.page = 1;
    renderVoteDeskDialog();
  } else if (action === "all-blocks") {
    voteDeskModal.block = "";
    renderVoteDeskDialog();
  } else if (action === "toggle-passwords") {
    voteDeskModal.showPasswords = !voteDeskModal.showPasswords;
    renderVoteDeskDialog();
  } else if (action === "filter") {
    voteDeskModal.filter = button.dataset.filter;
    voteDeskModal.page = 1;
    renderVoteDeskDialog();
  } else if (action === "previous-page") {
    voteDeskModal.page = Math.max(1, voteDeskModal.page - 1);
    renderVoteDeskDialog();
  } else if (action === "next-page") {
    voteDeskModal.page++;
    renderVoteDeskDialog();
  } else if (action === "vote-position") {
    voteDeskModal.position = button.dataset.position;
    renderVoteDeskDialog();
  } else if (action === "vote-block") {
    voteDeskModal.selectedBlock = button.dataset.block;
    renderVoteDeskDialog();
  } else if (action === "sample-list") {
    voteDeskDraft.fileName = "sample-voter-list.csv";
    voteDeskDraft.skipped = 0;
    voteDeskDraft.sample = true;
    voteDeskDraft.voters = [
      { name: "Maria Santos", block: "Block A", email: "sample01@example.invalid" }, { name: "Luis Reyes", block: "Block A", email: "sample02@example.invalid" },
      { name: "Amara Cruz", block: "Block A", email: "sample03@example.invalid" }, { name: "Noah Garcia", block: "Block B", email: "sample04@example.invalid" },
      { name: "Sofia Mendoza", block: "Block B", email: "sample05@example.invalid" }, { name: "Ethan Flores", block: "Block C", email: "sample06@example.invalid" },
      { name: "Mika Navarro", block: "Block C", email: "sample07@example.invalid" }, { name: "Leah Ramos", block: "Block D", email: "sample08@example.invalid" },
      { name: "Andre Castillo", block: "Block D", email: "sample09@example.invalid" }, { name: "Nina Aquino", block: "Block E", email: "sample10@example.invalid" },
      { name: "Rafael Rivera", block: "Block E", email: "sample11@example.invalid" }, { name: "Clara Torres", block: "Block F", email: "sample12@example.invalid" },
    ];
    renderVoteDeskDialog();
  } else if (action === "remove-file") {
    voteDeskDraft.voters = [];
    voteDeskDraft.fileName = "";
    voteDeskDraft.skipped = 0;
    voteDeskDraft.sample = false;
    renderVoteDeskDialog();
  } else if (action === "add-position") {
    voteDeskCollectDraftInputs();
    if (voteDeskDraft.positions.length < 6) voteDeskDraft.positions.push({ name: "", candidates: "" });
    renderVoteDeskDialog();
  } else if (action === "remove-position") {
    voteDeskCollectDraftInputs();
    voteDeskDraft.positions.splice(Number(button.dataset.positionIndex), 1);
    renderVoteDeskDialog();
  } else if (action === "cancel-create") {
    closeVoteDeskDialog();
  }
});

voteDeskDialogContent.addEventListener("input", (event) => {
  if (event.target.matches('[name="name"]')) voteDeskDraft.name = event.target.value;
  if (event.target.matches('[name="year"]')) voteDeskDraft.year = event.target.value;
  if (event.target.matches('[name="date"]')) voteDeskDraft.date = event.target.value;
  if (event.target.matches("[data-position-index][data-position-field]")) {
    const position = voteDeskDraft.positions[Number(event.target.dataset.positionIndex)];
    if (position) position[event.target.dataset.positionField] = event.target.value;
  }
});
voteDeskDialogContent.addEventListener("change", async (event) => {
  if (event.target.id !== "vdVoterCsv") return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = voteDeskParseCsv(await file.text());
    voteDeskDraft.voters = parsed.voters;
    voteDeskDraft.fileName = file.name;
    voteDeskDraft.skipped = parsed.skipped;
    voteDeskDraft.sample = false;
    renderVoteDeskDialog();
  } catch (_error) {
    voteDeskDraft.voters = [];
    voteDeskDraft.fileName = "";
    const alert = document.getElementById("vdCreateErrors");
    alert.textContent = "The voter list could not be read. Please choose a valid CSV file.";
    alert.classList.remove("hidden");
  }
});
voteDeskDialogContent.addEventListener("submit", async (event) => {
  if (event.target.id !== "vdCreateElectionForm") return;
  event.preventDefault();
  await voteDeskCreateElection();
});

const dashboardNotifications = [
  { title: "Credentials generated", message: "Usernames and passwords generated for 412 voters in Block C.", time: "5 minutes ago", type: "success", unread: true },
  { title: "Low turnout in Block D", message: "Turnout is 66%, the lowest of all blocks.", time: "22 minutes ago", type: "warning", unread: true },
  { title: "Voter list uploaded", message: "CSV sorted into 4 blocks with 192 voters.", time: "1 hour ago", type: "info", unread: true },
  { title: "Failed sign-in attempts", message: "3 failed attempts on a voter account. It was locked for 15 minutes.", time: "3 hours ago", type: "warning", unread: false },
  { title: "Election certified", message: "2025 General Election results certified.", time: "Yesterday", type: "success", unread: false },
  { title: "Candidate added", message: "A candidate was added to the President ballot.", time: "2 days ago", type: "info", unread: false },
];
let notificationFilter = "all";

function renderNotifications() {
  const unreadCount = dashboardNotifications.filter((item) => item.unread).length;
  const badge = document.getElementById("notificationBadge");
  const button = document.getElementById("notificationButton");
  badge.textContent = unreadCount;
  badge.classList.toggle("hidden", unreadCount === 0);
  button.setAttribute("aria-label", unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications, all caught up");
  document.getElementById("notificationUnreadSummary").textContent = unreadCount ? `${unreadCount} unread` : "All caught up";
  document.querySelector('[data-notification-filter="all"]').textContent = `All (${dashboardNotifications.length})`;
  document.querySelector('[data-notification-filter="unread"]').textContent = `Unread (${unreadCount})`;

  const visible = dashboardNotifications.filter((item) => notificationFilter === "all" || item.unread);
  const list = document.getElementById("notificationList");
  if (!visible.length) {
    list.innerHTML = `<p class="notification-empty">You have read every notification.</p>`;
    return;
  }
  list.innerHTML = visible.map((item) => {
    const index = dashboardNotifications.indexOf(item);
    const icon = item.type === "success" ? "&#10003;" : item.type === "warning" ? "&#9888;" : "i";
    return `<button class="notification-row ${item.unread ? "is-unread" : ""}" type="button" data-notification-index="${index}" aria-label="${escapeHtml(item.title)}${item.unread ? ", unread" : ""}">
      <span class="notification-icon ${item.type}" aria-hidden="true">${icon}</span>
      <span class="notification-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.message)}</span><small>${escapeHtml(item.time)}</small></span>
      ${item.unread ? '<span class="notification-unread-dot" aria-label="Unread"></span>' : '<span class="notification-read-spacer"></span>'}
    </button>`;
  }).join("");
}

document.getElementById("notificationButton").addEventListener("click", () => {
  const panel = document.getElementById("notificationPanel");
  const willOpen = panel.classList.contains("hidden");
  closeTopbarMenus();
  if (willOpen) {
    panel.classList.remove("hidden");
    document.getElementById("notificationButton").setAttribute("aria-expanded", "true");
    renderNotifications();
  }
});
document.querySelectorAll(".notification-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    notificationFilter = tab.dataset.notificationFilter;
    document.querySelectorAll(".notification-tab").forEach((item) => {
      const selected = item === tab;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-selected", String(selected));
    });
    renderNotifications();
  });
});
document.getElementById("notificationList").addEventListener("click", (event) => {
  const row = event.target.closest("[data-notification-index]");
  if (!row) return;
  dashboardNotifications[Number(row.dataset.notificationIndex)].unread = false;
  renderNotifications();
});
document.getElementById("markAllNotificationsRead").addEventListener("click", () => {
  dashboardNotifications.forEach((item) => { item.unread = false; });
  renderNotifications();
});
renderNotifications();

document.getElementById("accountButton").addEventListener("click", () => {
  const menu = document.getElementById("accountMenu");
  const willOpen = menu.classList.contains("hidden");
  closeTopbarMenus();
  if (willOpen) {
    menu.classList.remove("hidden");
    document.getElementById("accountButton").setAttribute("aria-expanded", "true");
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#notificationAnchor") && !event.target.closest("#accountAnchor")) closeTopbarMenus();
});

const editProfileOverlay = document.getElementById("editProfileOverlay");
function openEditProfile() {
  closeTopbarMenus();
  profilePictureDraft = adminProfile.picture;
  document.getElementById("profileName").value = adminProfile.name;
  document.getElementById("profileUsername").value = adminProfile.username;
  document.getElementById("profileEmail").value = adminProfile.email;
  ["profileCurrentPassword", "profileNewPassword", "profileConfirmPassword"].forEach((id) => { document.getElementById(id).value = ""; });
  document.getElementById("removeProfilePicture").classList.toggle("hidden", !adminProfile.picture);
  document.getElementById("profileError").classList.add("hidden");
  document.getElementById("profileSuccess").classList.add("hidden");
  updateAdminProfileDisplay();
  editProfileOverlay.classList.add("show");
  editProfileOverlay.setAttribute("aria-hidden", "false");
  document.getElementById("profileName").focus();
}
function closeEditProfile() {
  editProfileOverlay.classList.remove("show");
  editProfileOverlay.setAttribute("aria-hidden", "true");
}
document.getElementById("accountSummary").addEventListener("click", openEditProfile);
document.getElementById("editProfileMenu").addEventListener("click", openEditProfile);
document.getElementById("chooseProfilePicture").addEventListener("click", () => {
  document.getElementById("profilePictureInput").click();
});
document.getElementById("closeEditProfile").addEventListener("click", closeEditProfile);
document.getElementById("profileCloseButton").addEventListener("click", closeEditProfile);
editProfileOverlay.addEventListener("click", (event) => {
  if (event.target === editProfileOverlay) closeEditProfile();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeTopbarMenus();
    if (editProfileOverlay.classList.contains("show")) closeEditProfile();
  }
});
document.getElementById("profilePictureInput").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const error = document.getElementById("profileError");
  const validImage = ["image/png", "image/jpeg"].includes(file.type);
  if (!validImage || file.size > 2 * 1024 * 1024) {
    error.textContent = !validImage ? "Choose a PNG or JPG image." : "The picture must be 2 MB or smaller.";
    error.classList.remove("hidden");
    event.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    profilePictureDraft = String(reader.result);
    const preview = document.getElementById("profileAvatar");
    preview.textContent = "";
    preview.classList.add("has-picture");
    preview.style.backgroundImage = `url("${profilePictureDraft}")`;
    document.getElementById("removeProfilePicture").classList.remove("hidden");
    error.classList.add("hidden");
  };
  reader.onerror = () => {
    error.textContent = "The picture could not be read. Choose another image.";
    error.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
});
document.getElementById("removeProfilePicture").addEventListener("click", () => {
  profilePictureDraft = "";
  const preview = document.getElementById("profileAvatar");
  preview.textContent = initialsForName(adminProfile.name);
  preview.classList.remove("has-picture");
  preview.style.backgroundImage = "";
  document.getElementById("removeProfilePicture").classList.add("hidden");
  document.getElementById("profilePictureInput").value = "";
});
document.getElementById("saveProfile").addEventListener("click", () => {
  const name = document.getElementById("profileName").value.trim();
  const username = document.getElementById("profileUsername").value.trim();
  const email = document.getElementById("profileEmail").value.trim();
  const currentPassword = document.getElementById("profileCurrentPassword").value;
  const newPassword = document.getElementById("profileNewPassword").value;
  const confirmation = document.getElementById("profileConfirmPassword").value;
  const errors = [];
  if (!name) errors.push("Full name is required.");
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) errors.push("Username must be 3 to 30 characters using letters, numbers, dots, dashes or underscores.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("Enter a valid email address or leave it empty.");
  const changingPassword = Boolean(currentPassword || newPassword || confirmation);
  if (changingPassword && !currentPassword) errors.push("Enter your current password to change it.");
  if (changingPassword && newPassword.length < 8) errors.push("New password must be at least 8 characters.");
  if (changingPassword && newPassword !== confirmation) errors.push("New password and confirmation do not match.");
  if (changingPassword && newPassword && newPassword === currentPassword) errors.push("New password must be different from the current password.");

  const error = document.getElementById("profileError");
  const success = document.getElementById("profileSuccess");
  success.classList.add("hidden");
  if (errors.length) {
    error.textContent = errors.join(" ");
    error.classList.remove("hidden");
    return;
  }
  adminProfile = { name, username, email, picture: profilePictureDraft };
  if (currentAdmin) {
    currentAdmin = { ...currentAdmin, name, username, email };
    cacheAdminSession(currentAdmin);
  }
  updateAdminProfileDisplay();
  ["profileCurrentPassword", "profileNewPassword", "profileConfirmPassword"].forEach((id) => { document.getElementById(id).value = ""; });
  error.classList.add("hidden");
  success.textContent = changingPassword ? "Profile saved and password changed." : "Profile saved.";
  success.classList.remove("hidden");
  document.getElementById("removeProfilePicture").classList.toggle("hidden", !profilePictureDraft);
});

document.getElementById("returnToDashboard").addEventListener("click", () => {
  document.getElementById("signedOutScreen").classList.add("hidden");
  currentAdmin = signedOutAdmin || { name: adminProfile.name, username: adminProfile.username, email: adminProfile.email, role: "admin" };
  openAdminDashboard(currentAdmin, "votedesk");
});

/* ---- dashboard: stats + election status toggle + live results ---- */
let dashboardRefreshInterval = null;
let dashboardRefreshInProgress = false;

function startDashboardRefresh() {
  if (dashboardRefreshInterval) clearInterval(dashboardRefreshInterval);
  dashboardRefreshInterval = setInterval(() => {
    if (adminSection.classList.contains("hidden") || sessionStorage.getItem(ADMIN_TAB_KEY) !== "dashboard") return;
    refreshLiveDashboard();
  }, 15000);
}

async function refreshLiveDashboard() {
  if (dashboardRefreshInProgress) return;
  dashboardRefreshInProgress = true;
  const refreshButton = document.getElementById("refreshLiveResults");
  if (refreshButton) refreshButton.disabled = true;
  try {
    await Promise.all([renderStatRow(), renderResultsPanel()]);
  } finally {
    dashboardRefreshInProgress = false;
  }
}

async function renderStatRow() {
  let stats;
  try {
    stats = await api(electionScopedAdminPath("/admin/stats"), { token: adminToken });
  } catch (_err) {
    document.getElementById("statRow").innerHTML = `<p class="error-text">Couldn't load stats.</p>`;
    return;
  }
  const open = stats.votingOpen;
  const credentialsGenerated = Number(stats.credentialsGenerated ?? (stats.registeredNotVoted || 0) + (stats.voted || 0));
  const credentialsNotVoted = Math.max(0, credentialsGenerated - (stats.voted || 0));
  const statRow = document.getElementById("statRow");
  statRow.innerHTML = `
    <div class="stat-card total-stat-card">
      <div class="stat-label">Total students</div>
      <div class="stat-num">${stats.total}</div>
    </div>
    <div class="metric-card-grid">
      <div class="stat-card metric-stat-card"><div class="stat-nume">${credentialsGenerated}</div><div class="stat-label">Credentials issued</div></div>
      <div class="stat-card metric-stat-card"><div class="stat-numi">${stats.voted}</div><div class="stat-label">Voted</div></div>
    </div>`;

  document.getElementById("statusCardContainer").innerHTML = isStaffAccount()
    ? `<div class="stat-card status-card ${open ? "status-open" : "status-closed"}">
        <span><span class="status-dot"></span><strong>${open ? "Voting OPEN" : "Voting CLOSED"}</strong></span>
        <span class="status-toggle-label">Read-only election status</span>
      </div>`
    : `<button class="stat-card status-card ${open ? "status-open" : "status-closed"}" id="statusCard">
        <span><span class="status-dot"></span><strong>${open ? "Voting OPEN" : "Voting CLOSED"}</strong></span>
        <span class="status-toggle-label">Click to ${open ? (voteDeskIsPersistent() ? "close and archive" : "close") : "open"} voting</span>
      </button>`;

  const chartTotal = Math.max(1, stats.total);
  const credentialAngle = (credentialsNotVoted / chartTotal) * 360;
  const votedAngle = credentialAngle + (stats.voted / chartTotal) * 360;
  const notRegistered = Math.max(0, stats.total - credentialsGenerated);
  document.getElementById("participationChart").style.background = `conic-gradient(var(--blue-light) 0deg ${credentialAngle}deg, var(--success) ${credentialAngle}deg ${votedAngle}deg, rgba(255,255,255,.16) ${votedAngle}deg 360deg)`;
  document.getElementById("participationChart").innerHTML = `<span class="participation-chart-center"><strong>${Math.round((stats.voted / chartTotal) * 100)}%</strong><small>voted</small></span>`;
  document.getElementById("participationLegend").innerHTML = [
    ["Credentials issued, not voted", credentialsNotVoted, "var(--blue-light)"],
    ["Voted", stats.voted, "var(--success)"],
    ["Credentials not issued", notRegistered, "rgba(255,255,255,.4)"],
  ].map(([label, value, color]) => `<div class="legend-item"><span class="legend-dot" style="background:${color}"></span><strong>${label}</strong><span>${Math.round((value / chartTotal) * 100)}% <small>(${value})</small></span></div>`).join("");

  if (!isStaffAccount()) document.getElementById("statusCard").onclick = async () => {
    try {
      if (voteDeskIsPersistent()) {
        await updateVoteDeskVoting(!open);
      } else {
        await api("/admin/settings/voting-open", { method: "POST", token: adminToken, body: { open: !open } });
        renderStatRow();
      }
    } catch (err) {
      alert(err.error || "Couldn't update election status.");
    }
  };
}

async function renderResultsPanel() {
  const el = document.getElementById("resultsCard");
  const electionName = voteDeskIsPersistent() ? voteDeskElection().title : "";
  const header = (updatedAt = "Waiting for results…") => `
    <div class="live-results-header">
      <div>
        <div class="live-results-title">
          <h3>Election results</h3>
          <span class="live-results-indicator">LIVE</span>
        </div>
        ${electionName ? `<p class="live-results-election-name">${escapeHtml(electionName)}</p>` : ""}
        <p class="live-results-meta" aria-live="polite">Auto-refreshes every 15 seconds · ${updatedAt}</p>
      </div>
      <button class="btn-gradient live-results-refresh" id="refreshLiveResults" type="button">Refresh now</button>
    </div>`;
  const bindRefresh = () => {
    document.getElementById("refreshLiveResults").onclick = refreshLiveDashboard;
  };
  let results;
  try {
    const data = await api(electionScopedAdminPath("/admin/results"), { token: adminToken });
    results = data.results || [];
  } catch (_err) {
    el.innerHTML = `${header("Update failed")}<p class="error-text">Couldn't load results.</p>`;
    bindRefresh();
    return;
  }
  const updatedAt = timeStamp(new Date());
  if (!results.length) {
    el.innerHTML = `${header(updatedAt)}<p class="panel-note">No positions set up yet. Add candidates first.</p>`;
    bindRefresh();
    return;
  }
  el.innerHTML = header(updatedAt) + results.map((race) => {
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
  bindRefresh();
}

/* ---- students: per-block summary cards + collapsible full roster ---- */
let cachedRoster = [];
let cachedRosterElectionId = null;
let rosterCacheValid = false;
let rosterLoadPromise = null;
let rosterLoadElectionId = null;
let selectedRosterBlock = null;
let studentStatusFilter = "All";
let studentRosterPage = 1;
let studentRosterSearch = "";

function currentRosterElectionId() {
  return voteDeskIsPersistent() ? voteDeskElection().id : "";
}

async function loadRoster() {
  const electionId = currentRosterElectionId();
  if (rosterCacheValid && cachedRosterElectionId === electionId) return true;
  if (rosterLoadPromise && rosterLoadElectionId === electionId) return rosterLoadPromise;

  rosterLoadElectionId = electionId;
  const request = api(electionScopedAdminPath("/admin/students"), { token: adminToken })
    .then((data) => {
      if (currentRosterElectionId() === electionId) {
        cachedRoster = data.students || [];
        cachedRosterElectionId = electionId;
        rosterCacheValid = true;
      }
      return currentRosterElectionId() === electionId;
    })
    .catch((error) => {
      if (currentRosterElectionId() === electionId) {
        cachedRoster = [];
        cachedRosterElectionId = electionId;
        rosterCacheValid = false;
        document.getElementById("studentLoadError").textContent = error.error || "Couldn't load the student list.";
        document.getElementById("studentLoadError").classList.remove("hidden");
      }
      return false;
    })
    .finally(() => {
      if (rosterLoadPromise === request) {
        rosterLoadPromise = null;
        rosterLoadElectionId = null;
      }
    });
  rosterLoadPromise = request;
  return request;
}

function studentRosterStatus(student) {
  if (!student.registered) return "No credentials";
  return student.voted ? "Voted" : "Not voted";
}

async function renderBlockGrid() {
  const loaded = await loadRoster();
  const summary = document.getElementById("studentSummary");
  const grid = document.getElementById("blockGrid");
  const directory = document.getElementById("studentDirectory");
  grid.classList.toggle("hidden", selectedRosterBlock !== null);
  directory.classList.toggle("hidden", selectedRosterBlock === null);
  if (!loaded) {
    summary.innerHTML = "";
    grid.innerHTML = `<p class="vd-empty-cell">Student data could not be loaded.</p>`;
    return;
  }
  document.getElementById("studentLoadError").classList.add("hidden");

  const blocks = {};
  cachedRoster.forEach((s) => {
    const key = s.block || "No block";
    if (!blocks[key]) blocks[key] = { total: 0, registered: 0, voted: 0 };
    blocks[key].total++;
    if (s.registered) blocks[key].registered++;
    if (s.voted) blocks[key].voted++;
  });

  const totals = {
    total: cachedRoster.length,
    registered: cachedRoster.filter((student) => student.registered).length,
    voted: cachedRoster.filter((student) => student.voted).length,
  };
  const memberLabel = voteDeskIsPersistent() ? "registered" : "students";
  summary.innerHTML = `${voteDeskStat(voteDeskIsPersistent() ? "Registered voters" : "Total students", totals.total.toLocaleString())}${voteDeskStat("Voted", totals.voted.toLocaleString())}${voteDeskStat("Credentials generated", totals.registered.toLocaleString())}`;
  const renderBlockCard = (name, counts, allStudents = false) => {
    const turnout = counts.total ? Math.round(counts.voted / counts.total * 100) : 0;
    const label = allStudents ? "All students" : name;
    return `<button type="button" class="vd-block-card" data-roster-block="${allStudents ? "*" : escapeHtml(name)}">
      <span class="vd-block-card-title">${escapeHtml(label)} <span aria-hidden="true">&#8594;</span></span>
      <span class="vd-block-card-metrics"><span><strong>${counts.total}</strong> ${memberLabel}</span><span><strong>${counts.voted}</strong> voted · ${turnout}%</span><span><strong>${counts.registered}</strong> credentials</span></span>
      <span class="vd-progress"><span style="width:${turnout}%"></span></span>
      <span class="vd-view-cue">View students</span>
    </button>`;
  };
  grid.innerHTML = [
    renderBlockCard("", totals, true),
    ...Object.keys(blocks).sort((a, b) => a.localeCompare(b)).map((name) => renderBlockCard(name, blocks[name])),
  ].join("");
}

async function renderRosterTable() {
  const directory = document.getElementById("studentDirectory");
  if (selectedRosterBlock === null) {
    directory.classList.add("hidden");
    return;
  }
  directory.classList.remove("hidden");
  if (!await loadRoster()) return;

  const allStudents = selectedRosterBlock === "*";
  const selectedBlockStudents = allStudents
    ? cachedRoster
    : cachedRoster.filter((student) => (student.block || "No block") === selectedRosterBlock);
  const search = studentRosterSearch.trim().toLocaleLowerCase();
  const searchedStudents = selectedBlockStudents.filter((student) =>
    [student.id_no, student.name, student.block, student.email, student.username]
      .some((value) => String(value || "").toLocaleLowerCase().includes(search))
  );
  const filters = ["All", "Voted", "Not voted", "No credentials"];
  const statusCounts = Object.fromEntries(filters.map((filter) => [
    filter,
    filter === "All" ? searchedStudents.length : searchedStudents.filter((student) => studentRosterStatus(student) === filter).length,
  ]));
  const filteredRoster = studentStatusFilter === "All"
    ? searchedStudents
    : searchedStudents.filter((student) => studentRosterStatus(student) === studentStatusFilter);
  const sortedRoster = filteredRoster.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  const totalPages = Math.max(1, Math.ceil(sortedRoster.length / 20));
  studentRosterPage = Math.min(studentRosterPage, totalPages);
  const start = (studentRosterPage - 1) * 20;
  const shown = sortedRoster.slice(start, start + 20);
  document.getElementById("studentListTitle").textContent = allStudents ? "All students" : selectedRosterBlock;
  document.getElementById("studentListSubtitle").textContent = `${voteDeskIsPersistent() ? voteDeskElection().title : "Student roster"} · sorted by student name`;
  document.getElementById("studentStatusFilters").innerHTML = filters.map((filter) =>
    `<button type="button" class="vd-filter ${studentStatusFilter === filter ? "is-active" : ""}" data-student-filter="${escapeHtml(filter)}">${escapeHtml(filter)} <span>${statusCounts[filter]}</span></button>`
  ).join("");
  document.getElementById("rosterPageSummary").textContent = `Showing ${filteredRoster.length ? start + 1 : 0} to ${Math.min(start + 20, filteredRoster.length)} of ${filteredRoster.length}`;
  document.getElementById("studentPreviousPage").disabled = studentRosterPage <= 1;
  document.getElementById("studentNextPage").disabled = studentRosterPage >= totalPages;
  const tbody = document.querySelector("#rosterTable tbody");
  tbody.innerHTML = shown.length
    ? shown.map((student) => {
      const status = studentRosterStatus(student);
      const hasCredentials = Boolean(student.registered);
      const id = String(student.id_no || "");
      const delivery = student.credentials_delivery || student.credentialDelivery;
      const credentialLabel = voteDeskIsPersistent()
        ? ({ sent: "Sent", failed: "Delivery failed", pending: "Pending", sample: "Sample only" }[delivery] || "Generated")
        : hasCredentials ? "Issued" : "Not issued";
      const credentialClass = delivery === "sent" || (!voteDeskIsPersistent() && hasCredentials)
        ? "vd-status-voted"
        : delivery === "failed" || (!voteDeskIsPersistent() && !hasCredentials)
          ? "vd-status-no-credentials"
          : "vd-status-pending";
      const resendButton = voteDeskIsPersistent()
        ? !voteDeskElection().sample
          ? `<button class="vd-button vd-resend-button" data-resend-election-credentials="${escapeHtml(encodeURIComponent(id))}" type="button">Resend</button>`
          : "—"
        : hasCredentials
          ? `<button class="vd-button vd-resend-button" data-resend-credentials="${escapeHtml(encodeURIComponent(id))}" type="button">Resend</button>`
          : "—";
      return `<tr>
        <td class="vd-mono">${escapeHtml(id || "—")}</td>
        <td>${escapeHtml(student.name || "—")}</td>
        <td>${escapeHtml(student.block || "—")}</td>
        <td>${escapeHtml(student.email || "—")}</td>
        <td class="vd-mono">${escapeHtml(student.username || "—")}</td>
        <td><span class="vd-status ${credentialClass}">${escapeHtml(credentialLabel)}</span></td>
        <td><span class="vd-status vd-status-${voteDeskStatusClass(status)}">${escapeHtml(status)}</span></td>
        <td>${resendButton}</td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="8" class="vd-empty-cell">No students match this filter.</td></tr>`;

  tbody.querySelectorAll("[data-resend-credentials], [data-resend-election-credentials]").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = "Sending...";
      try {
        const electionResend = button.hasAttribute("data-resend-election-credentials");
        const voterId = electionResend
          ? button.dataset.resendElectionCredentials
          : button.dataset.resendCredentials;
        const path = electionResend
          ? `/admin/elections/${encodeURIComponent(voteDeskElection().id)}/voters/${voterId}/resend-credentials`
          : `/admin/students/${voterId}/resend-credentials`;
        const result = await api(path, { method: "POST", token: adminToken });
        if (electionResend) {
          const voter = cachedRoster.find((student) => encodeURIComponent(student.id_no) === voterId);
          if (voter) voter.credentials_delivery = "sent";
          await renderRosterTable();
        }
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

document.getElementById("blockGrid").addEventListener("click", (event) => {
  const card = event.target.closest("[data-roster-block]");
  if (!card) return;
  selectedRosterBlock = card.dataset.rosterBlock;
  studentStatusFilter = "All";
  studentRosterPage = 1;
  studentRosterSearch = "";
  document.getElementById("studentSearch").value = "";
  renderBlockGrid();
  renderRosterTable();
});
document.getElementById("studentBackToBlocks").addEventListener("click", () => {
  selectedRosterBlock = null;
  studentStatusFilter = "All";
  studentRosterPage = 1;
  studentRosterSearch = "";
  document.getElementById("studentSearch").value = "";
  renderBlockGrid();
  renderRosterTable();
});
document.getElementById("studentSearch").addEventListener("input", (event) => {
  studentRosterSearch = event.target.value;
  studentRosterPage = 1;
  renderRosterTable();
});
document.getElementById("studentStatusFilters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-student-filter]");
  if (!button) return;
  studentStatusFilter = button.dataset.studentFilter;
  studentRosterPage = 1;
  renderRosterTable();
});
document.getElementById("studentPreviousPage").addEventListener("click", () => {
  studentRosterPage = Math.max(1, studentRosterPage - 1);
  renderRosterTable();
});
document.getElementById("studentNextPage").addEventListener("click", () => {
  studentRosterPage++;
  renderRosterTable();
});

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
  if (voteDeskIsPersistent()) {
    document.getElementById("rosterError").textContent = "Add students from the selected election's voter list instead.";
    return;
  }
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
    rosterCacheValid = false;
    selectedRosterBlock = null;
    renderRosterTable(); renderBlockGrid(); renderStatRow();
    addStudentOverlay.classList.remove("show");
  } catch (err) { errorEl.textContent = err.error || "Couldn't add that student."; }
};

document.getElementById("importCsvBtn").onclick = async () => {
  if (voteDeskIsPersistent()) {
    document.getElementById("csvError").textContent = "Import voters through Create new election for election-scoped records.";
    return;
  }
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
    rosterCacheValid = false;
    selectedRosterBlock = null;
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
    const candidateData = await api(electionScopedAdminPath("/admin/candidates"), { token: adminToken });
    candidates = candidateData.candidates || [];
  } catch (_err) {
    el.innerHTML = `<p class="error-text">Couldn't load candidates.</p>`;
    return;
  }
  try {
    const resultData = await api(electionScopedAdminPath("/admin/results"), { token: adminToken });
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
  const sortedPositions = Object.entries(byPosition).sort(([a], [b]) =>
    candidatePositionRank(a) - candidatePositionRank(b) || a.localeCompare(b)
  );
  el.innerHTML = `${resultsUnavailable ? `<p class="panel-note">Candidate profiles are available, but vote totals couldn't be loaded.</p>` : ""}` + sortedPositions.map(([position, list]) => `
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

function renderCandidateStudentSearch() {
  const query = candidateSearch.value.trim().toLocaleLowerCase();
  candidateStudentSelect.value = "";

  if (!query) {
    candidateStudentSelect.innerHTML = `<option value="">Start typing to see students</option>`;
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
  candidateStudentSelect.innerHTML = matches.length
    ? `<option value="">Select a student (${matches.length} match${matches.length === 1 ? "" : "es"})</option>` +
      matches.map((student) =>
        `<option value="${escapeHtml(student.id_no)}">${escapeHtml(student.name)} | ${escapeHtml(student.id_no)}${student.block ? ` | ${escapeHtml(student.block)}` : ""}</option>`
      ).join("")
    : `<option value="">No matching students</option>`;
  candidateStudentSelect.disabled = matches.length === 0;

  if (!matches.length) {
    candidateSearchStatus.textContent = "No candidates match. Try a different name, ID, or block.";
  } else {
    candidateSearchStatus.textContent = `${matches.length} candidate${matches.length === 1 ? "" : "s"} found.`;
  }
}

candidateSearch.addEventListener("input", renderCandidateStudentSearch);
candidateStudentSelect.addEventListener("change", () => {
  const selectedStudent = cachedRoster.find((student) => student.id_no === candidateStudentSelect.value);
  if (selectedStudent) candidateSearch.value = selectedStudent.name;
});

document.getElementById("openAddCandidateModal").onclick = async () => {
  if (voteDeskIsPersistent()) return;
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
  if (voteDeskIsPersistent()) {
    document.getElementById("candidateRosterError").textContent = "Add candidates when creating an election so they match its voter list.";
    return;
  }
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

/* ---- admin accounts: list + Add Staff modal (no public sign-up) ---- */
async function renderAdminList() {
  const el = document.getElementById("adminList");
  let admins;
  try {
    const data = await api("/admin/admins", { token: adminToken });
    admins = (data.admins || []).filter((account) => account.role === "staff");
  } catch (error) {
    el.innerHTML = `<p class="error-text">${escapeHtml(error.error || "Couldn't load admin accounts.")}</p>`;
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
                <span class="status-pill ${a.role === "staff" ? "" : "yes"}">${a.role === "staff" ? "Staff" : "Admin / Election Officer"}</span>
                ${isSelf ? '<span class="status-pill yes">You</span>' : ""}
              </div>
              <div class="admin-list-meta">${escapeHtml(a.username)} &middot; ${escapeHtml(a.email)}</div>
            </div>
          </div>`;
      }).join("")
    : `<p class="panel-note">No staff accounts have been added yet.</p>`;

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
  ["admName", "admEmail2", "admUsername2", "admPassword2"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  addAdminOverlay.classList.add("show");
};
function closeAddAdminModal() {
  addAdminOverlay.classList.remove("show");
  document.getElementById("admError2").textContent = "";
}
document.getElementById("closeAddAdminModal").onclick = closeAddAdminModal;
addAdminOverlay.addEventListener("click", (event) => {
  if (event.target === addAdminOverlay) closeAddAdminModal();
});
document.getElementById("addAdminBtn").onclick = async () => {
  const errorEl = document.getElementById("admError2");
  errorEl.textContent = "";
  const name = document.getElementById("admName").value.trim();
  const email = document.getElementById("admEmail2").value.trim();
  const username = document.getElementById("admUsername2").value.trim();
  const password = document.getElementById("admPassword2").value;
  try {
    await api("/admin/admins", { method: "POST", token: adminToken, body: { name, email, username, password, role: "staff" } });
    ["admName", "admEmail2", "admUsername2", "admPassword2"].forEach((id) => { document.getElementById(id).value = ""; });
    renderAdminList();
    closeAddAdminModal();
  } catch (err) {
    errorEl.textContent = err.error || "Couldn't add that admin.";
  }
};

/* ---------------- Boot ---------------- */
restoreSession();
