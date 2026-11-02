const nodemailer = require("nodemailer");
const { Resend } = require("resend");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]);
}

async function sendMail({ to, subject, html, text }) {
  try {
    const defaultProvider = process.env.RESEND_API_KEY ? "resend" : "smtp";
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

module.exports = { sendMail, studentCredentialsEmail, adminOtpEmail };