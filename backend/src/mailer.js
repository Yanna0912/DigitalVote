const nodemailer = require("nodemailer");
const dns = require("dns");

// Force Node.js to resolve IPv4 addresses first globally
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  try {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || "true") === "true",
      family: 4,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    return transporter;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[mailer] Failed to create transporter:", err.message);
    return null;
  }
}
/**
 * Sends an email. If SMTP isn't configured yet, logs the message to the
 * server console instead of throwing, so the rest of the app (and local
 * development) keeps working while you're still setting up email.
 */
async function sendMail({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) {
    // eslint-disable-next-line no-console
    console.warn(
      `[mailer] SMTP is not configured — email NOT actually sent.\n` +
      `  To: ${to}\n  Subject: ${subject}\n  Body:\n${text || html}\n`
    );
    return { delivered: false, reason: "not_configured" };
  }
  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
      text,
    });
    return { delivered: true };
  } catch (err) {
    // A bad SMTP password/host, or the provider rejecting the message,
    // should degrade to the dev-preview fallback — not 500 the request.
    // eslint-disable-next-line no-console
    console.error(`[mailer] Send failed: ${err.message}\n  To: ${to}\n  Subject: ${subject}`);
    return { delivered: false, reason: "send_failed", error: err.message };
  }
}

function studentCredentialsEmail({ name, username, password }) {
  return {
    subject: "Your CCDI SSG Election voting login",
    text:
      `Hi ${name},\n\n` +
      `You're registered to vote in the CCDI Supreme Student Government Election.\n\n` +
      `Username: ${username}\n` +
      `Password: ${password}\n\n` +
      `Keep this email — you'll use these to log in and vote once the election officer opens voting.\n\n` +
      `If you didn't request this, please contact the election officer.`,
    html:
      `<p>Hi ${name},</p>` +
      `<p>You're registered to vote in the <strong>CCDI Supreme Student Government Election</strong>.</p>` +
      `<p><strong>Username:</strong> ${username}<br><strong>Password:</strong> ${password}</p>` +
      `<p>Keep this email — you'll use these to log in and vote once the election officer opens voting.</p>` +
      `<p style="color:#888;font-size:12px;">If you didn't request this, please contact the election officer.</p>`,
  };
}

function adminOtpEmail({ name, code }) {
  return {
    subject: `Your CCDI Election Portal verification code: ${code}`,
    text:
      `Hi ${name},\n\n` +
      `Your one-time verification code is: ${code}\n\n` +
      `It expires in 5 minutes. If you didn't try to log in, you can ignore this email.`,
    html:
      `<p>Hi ${name},</p>` +
      `<p>Your one-time verification code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>` +
      `<p>It expires in 5 minutes. If you didn't try to log in, you can ignore this email.</p>`,
  };
}

module.exports = { sendMail, studentCredentialsEmail, adminOtpEmail };