const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function sendMail({ to, subject, html, text }) {
  if (!resend) {
    console.warn(
      `[mailer] RESEND_API_KEY is missing — email NOT sent.\nTo: ${to}\nSubject: ${subject}`
    );
    return { delivered: false, reason: "not_configured" };
  }

  try {
    const data = await resend.emails.send({
      from: "CCDI Election <onboarding@resend.dev>", // Default testing domain
      to: [to],
      subject,
      html,
      text,
    });

    if (data.error) {
      console.error(`[mailer] Send failed:`, data.error);
      return { delivered: false, reason: "send_failed", error: data.error.message };
    }

    return { delivered: true };
  } catch (err) {
    console.error(`[mailer] Send failed: ${err.message}`);
    return { delivered: false, reason: "send_failed", error: err.message };
  }
}

function studentCredentialsEmail({ name, username, password }) {
  return {
    subject: "Your CCDI SSG Election voting login",
    text: `Hi ${name},\n\nYou're registered to vote in the CCDI Supreme Student Government Election.\n\nUsername: ${username}\nPassword: ${password}\n\nKeep this email — you'll use these to log in and vote once the election officer opens voting.\n\nIf you didn't request this, please contact the election officer.`,
    html: `<p>Hi ${name},</p><p>You're registered to vote in the <strong>CCDI Supreme Student Government Election</strong>.</p><p><strong>Username:</strong> ${username}<br><strong>Password:</strong> ${password}</p><p>Keep this email — you'll use these to log in and vote once the election officer opens voting.</p>`,
  };
}

function adminOtpEmail({ name, code }) {
  return {
    subject: `Your CCDI Election Portal verification code: ${code}`,
    text: `Hi ${name},\n\nYour one-time verification code is: ${code}\n\nIt expires in 5 minutes.`,
    html: `<p>Hi ${name},</p><p>Your one-time verification code is:</p><p style="font-size:28px;font-weight:700;">${code}</p>`,
  };
}

module.exports = { sendMail, studentCredentialsEmail, adminOtpEmail };