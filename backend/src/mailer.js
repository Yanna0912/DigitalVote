const nodemailer = require("nodemailer");

// Create SMTP Transporter using environment variables
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_SECURE === "true", // true for 465, false for 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS, // App password for Gmail
  },
});

async function sendMail({ to, subject, html }) {
  try {
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || `"DigitalVote Admin" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });

    console.log(`[mailer] Email sent successfully to \({to}:\){info.messageId}`);
    return { delivered: true, id: info.messageId };
  } catch (error) {
    console.error(`[mailer] SMTP Error:`, error);
    return { delivered: false, reason: error.message };
  }
}

function adminOtpEmail({ name, code }) {
  return {
    subject: `${code} is your DigitalVote admin verification code`,
    html: `<p>Hi ${name},</p>` +
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