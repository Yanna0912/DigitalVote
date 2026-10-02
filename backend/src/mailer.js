const nodemailer = require("nodemailer");
const { Resend } = require("resend");
const dns = require("dns");

// Force Node.js to resolve IPv4 addresses first globally
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder("ipv4first");
}

let transporter = null;
let resendClient = null;

function selectedEmailProvider() {
  return String(process.env.EMAIL_PROVIDER || "resend").trim().toLowerCase();
}

function getResendClient() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  resendClient = new Resend(process.env.RESEND_API_KEY.trim());
  return resendClient;
}

function getTransporter() {
  if (transporter) return transporter;
  const useMailjet = selectedEmailProvider() === "mailjet";
  const host = useMailjet ? (process.env.MAILJET_SMTP_HOST || "in-v3.mailjet.com") : process.env.SMTP_HOST;
  const user = useMailjet ? process.env.MAILJET_API_KEY : process.env.SMTP_USER;
  const pass = useMailjet ? process.env.MAILJET_SECRET_KEY : process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    return null;
  }
  try {
    transporter = nodemailer.createTransport({
      host,
      port: Number(useMailjet ? (process.env.MAILJET_SMTP_PORT || 587) : (process.env.SMTP_PORT || 2587)),
      secure: useMailjet
        ? String(process.env.MAILJET_SMTP_SECURE || "false") === "true"
        : String(process.env.SMTP_SECURE || "true") === "true",
      family: 4,
      // Custom lookup wrapper to strictly force IPv4 resolution
      lookup: (hostname, options, callback) => {
        dns.lookup(hostname, { family: 4 }, callback);
      },
      auth: {
        user: user.trim(),
        pass: pass.replace(/\s/g, ""),
      },
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
  const resend = getResendClient();
  let resendError = null;
  const provider = selectedEmailProvider();
  if (provider !== "mailjet" && provider !== "smtp" && resend) {
    try {
      const { data, error } = await resend.emails.send({
        from: process.env.RESEND_FROM || "onboarding@resend.dev",
        to: [to],
        subject,
        html,
        text,
      });
      if (error) {
        resendError = error.message || String(error);
        console.error(`[mailer] Resend rejected email to ${to}:`, error.message || error);
      } else {
        return { delivered: true, provider: "resend", id: data?.id };
      }
    } catch (err) {
      resendError = err.message;
      console.error(`[mailer] Resend failed for ${to}:`, err.message);
    }
    console.warn(`[mailer] Falling back to SMTP for ${to}.`);
  }

  const t = getTransporter();
  if (!t) {
    // eslint-disable-next-line no-console
    console.warn(
      `[mailer] SMTP is not configured — email NOT actually sent.\n` +
      `  To: ${to}\n  Subject: ${subject}\n  Body:\n${text || html}\n`
    );
    return {
      delivered: false,
      reason: resendError ? "providers_failed" : "not_configured",
      error: resendError || (provider === "mailjet"
        ? "Mailjet is selected but MAILJET_API_KEY or MAILJET_SECRET_KEY is missing."
        : "No email provider is configured."),
    };
  }
  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
      text,
    });
    return { delivered: true, provider: provider === "mailjet" ? "mailjet" : "smtp" };
  } catch (err) {
    // A bad SMTP password/host, or the provider rejecting the message,
    // should degrade to the dev-preview fallback — not 500 the request.
    // eslint-disable-next-line no-console
    console.error(`[mailer] Send failed: ${err.message}\n  To: ${to}\n  Subject: ${subject}`);
    const providerError = resendError
      ? `Resend: ${resendError}; SMTP: ${err.message}`
      : err.message;
    return { delivered: false, reason: "send_failed", error: providerError };
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