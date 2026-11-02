const nodemailer = require("nodemailer");
const { Resend } = require("resend");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

async function sendMail({ to, subject, html, text }) {
  try {
    const smtpConfigured = process.env.SMTP_USER && process.env.SMTP_PASS;
    const defaultProvider = smtpConfigured ? "smtp" : process.env.RESEND_API_KEY ? "resend" : "smtp";
    const provider = String(process.env.EMAIL_PROVIDER || defaultProvider).toLowerCase();
    if (provider === "resend") {
      if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
        throw new Error("Resend email is not configured.");
      }
      const resend = new Resend(process.env.RESEND_API_KEY);
      const { data, error } = await resend.emails.send({
        from: process.env.RESEND_FROM,
        to,
        subject,
        html,
        text,
      });
      if (error) throw new Error(error.message);
      console.log(`[mailer] Email sent${data?.id ? ` (${data.id})` : ""}`);
      return { delivered: true, id: data?.id };
    }

    if (provider !== "smtp" && provider !== "mailjet") {
      throw new Error(`Unsupported email provider: ${provider}`);
    }
    const transporter = nodemailer.createTransport({
      host: provider === "mailjet"
        ? process.env.MAILJET_SMTP_HOST || "in-v3.mailjet.com"
        : process.env.SMTP_HOST || "smtp.gmail.com",
      port: Number(provider === "mailjet"
        ? process.env.MAILJET_SMTP_PORT || 587
        : process.env.SMTP_PORT || 587),
      secure: (provider === "mailjet" ? process.env.MAILJET_SMTP_SECURE : process.env.SMTP_SECURE) === "true",
      auth: {
        user: provider === "mailjet" ? process.env.MAILJET_API_KEY : process.env.SMTP_USER,
        pass: provider === "mailjet" ? process.env.MAILJET_SECRET_KEY : process.env.SMTP_PASS,
      },
    });
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
      text,
    });
    console.log(`[mailer] Email sent (${info.messageId})`);
    return { delivered: true, id: info.messageId };
  } catch (error) {
    console.error("[mailer] Email delivery failed:", error);
    return { delivered: false, error: error.message };
  }
}

function studentCredentialsEmail({ name, username, password }) {
  const safeName = escapeHtml(name);
  const safeUsername = escapeHtml(username);
  const safePassword = escapeHtml(password);
  return {
    subject: "Your CCDI Election voting credentials",
    text: `Hi ${name},\n\nYour voting credentials are:\nUsername: ${username}\nPassword: ${password}\n\nKeep this email private.`,
    html: `<p>Hi ${safeName},</p><p>Your CCDI Election voting credentials are:</p>` +
      `<p><strong>Username:</strong> ${safeUsername}<br><strong>Password:</strong> ${safePassword}</p>` +
      `<p>Keep this email private. You can log in once the election officer opens voting.</p>`,
  };
}

function adminOtpEmail({ name, code }) {
  const safeName = escapeHtml(name);
  return {
    subject: `Your CCDI Election Portal verification code: ${code}`,
    text:
      `Hi ${name},\n\n` +
      `Your one-time verification code is: ${code}\n\n` +
      `It expires in 5 minutes. If you didn't try to log in, you can ignore this email.`,
    html:
      `<p>Hi ${safeName},</p>` +
      `<p>Your one-time verification code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>` +
      `<p>It expires in 5 minutes. If you didn't try to log in, you can ignore this email.</p>`,
  };
}

module.exports = { sendMail, studentCredentialsEmail, adminOtpEmail };const nodemailer = require("nodemailer");
const { Resend } = require("resend");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

/* ---------------------------- SMTP transport ---------------------------- */

let smtpTransporter = null;

function getSmtpConfig() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  let pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    throw new Error("SMTP is not configured. Set SMTP_USER and SMTP_PASS.");
  }
  // Gmail app passwords are displayed with spaces; they must be removed.
  if (/gmail\.com$/i.test(host)) pass = pass.replace(/\s+/g, "");

  // Port 465 = implicit TLS. Anything else (587/2525) = STARTTLS.
  const secure =
    process.env.SMTP_SECURE !== undefined && process.env.SMTP_SECURE !== ""
      ? process.env.SMTP_SECURE === "true"
      : port === 465;

  return { host, port, secure, user, pass };
}

function getSmtpTransporter() {
  if (smtpTransporter) return smtpTransporter;

  const { host, port, secure, user, pass } = getSmtpConfig();
  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure, // force STARTTLS upgrade on 587/2525
    auth: { user, pass },
    pool: true, // reuse connections instead of reconnecting for every email
    maxConnections: 3,
    maxMessages: 100,
    // Fail fast instead of hanging until the platform returns a 502
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || 10000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 20000),
    tls: { minVersion: "TLSv1.2" },
  });
  return smtpTransporter;
}

function resetSmtpTransporter() {
  if (smtpTransporter) {
    try { smtpTransporter.close(); } catch (_) { /* ignore */ }
    smtpTransporter = null;
  }
}

function isTransientSmtpError(error) {
  const codes = ["ETIMEDOUT", "ECONNRESET", "ECONNECTION", "ESOCKET", "EDNS", "EAI_AGAIN"];
  return (
    codes.includes(error.code) ||
    (error.responseCode >= 400 && error.responseCode < 500)
  );
}

function smtpHint(error) {
  if (["ETIMEDOUT", "ECONNECTION", "ESOCKET"].includes(error.code)) {
    return "Could not reach the SMTP server. The host/port may be wrong, or the platform (e.g. Render free tier) blocks outbound SMTP. Try an HTTPS provider such as Resend.";
  }
  if (error.code === "EAUTH") {
    return "SMTP login rejected. Check SMTP_USER / SMTP_PASS (Gmail needs an App Password, not your normal password).";
  }
  return null;
}

async function sendViaSmtp({ to, subject, html, text }) {
  const from = process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER;
  const message = {
    from,
    to,
    subject,
    html,
    text,
    ...(process.env.MAIL_REPLY_TO ? { replyTo: process.env.MAIL_REPLY_TO } : {}),
  };

  const maxAttempts = 2;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const info = await getSmtpTransporter().sendMail(message);
      console.log(`[mailer] SMTP email sent (${info.messageId})`);
      return { delivered: true, id: info.messageId };
    } catch (error) {
      lastError = error;
      const retry = attempt < maxAttempts && isTransientSmtpError(error);
      console.error(
        `[mailer] SMTP attempt ${attempt}/${maxAttempts} failed (${error.code || error.responseCode || "ERR"}): ${error.message}`
      );
      resetSmtpTransporter(); // drop possibly dead pooled connections
      if (!retry) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const hint = smtpHint(lastError);
  if (hint) console.error(`[mailer] Hint: ${hint}`);
  throw lastError;
}

/* ----------------------------- Resend (HTTPS) ---------------------------- */

async function sendViaResend({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM) {
    throw new Error("Resend email is not configured. Set RESEND_API_KEY and RESEND_FROM.");
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: process.env.RESEND_FROM,
    to,
    subject,
    html,
    text,
  });
  if (error) throw new Error(error.message);
  console.log(`[mailer] Resend email sent${data?.id ? ` (${data.id})` : ""}`);
  return { delivered: true, id: data?.id };
}

/* -------------------------------- Public API ------------------------------ */

async function sendMail({ to, subject, html, text }) {
  try {
    const smtpConfigured = process.env.SMTP_USER && process.env.SMTP_PASS;
    const defaultProvider = smtpConfigured ? "smtp" : process.env.RESEND_API_KEY ? "resend" : "smtp";
    const provider = String(process.env.EMAIL_PROVIDER || defaultProvider).toLowerCase();

    if (provider === "resend") return await sendViaResend({ to, subject, html, text });
    if (provider === "smtp") return await sendViaSmtp({ to, subject, html, text });
    throw new Error(`Unsupported email provider: ${provider}`);
  } catch (error) {
    console.error("[mailer] Email delivery failed:", error.message);
    return { delivered: false, error: error.message };
  }
}

function studentCredentialsEmail({ name, username, password }) {
  const safeName = escapeHtml(name);
  const safeUsername = escapeHtml(username);
  const safePassword = escapeHtml(password);
  return {
    subject: "Your CCDI Election voting credentials",
    text: `Hi ${name},\n\nYour voting credentials are:\nUsername: ${username}\nPassword: ${password}\n\nKeep this email private.`,
    html: `<p>Hi ${safeName},</p><p>Your CCDI Election voting credentials are:</p>` +
      `<p><strong>Username:</strong> ${safeUsername}<br><strong>Password:</strong> ${safePassword}</p>` +
      `<p>Keep this email private. You can log in once the election officer opens voting.</p>`,
  };
}

function adminOtpEmail({ name, code }) {
  const safeName = escapeHtml(name);
  return {
    subject: `Your CCDI Election Portal verification code: ${code}`,
    text:
      `Hi ${name},\n\n` +
      `Your one-time verification code is: ${code}\n\n` +
      `It expires in 5 minutes. If you didn't try to log in, you can ignore this email.`,
    html:
      `<p>Hi ${safeName},</p>` +
      `<p>Your one-time verification code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>` +
      `<p>It expires in 5 minutes. If you didn't try to log in, you can ignore this email.</p>`,
  };
}

module.exports = { sendMail, studentCredentialsEmail, adminOtpEmail };