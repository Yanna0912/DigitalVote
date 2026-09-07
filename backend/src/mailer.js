const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASS,
  },
});

async function sendMail({ to, subject, html, text }) {
  try {
    const info = await transporter.sendMail({
      from: `"CCDI SSG Elections" <${process.env.GMAIL_USER}>`,
      to: to, // Sends directly to whichever email the user inputs
      subject: subject,
      text: text,
      html: html,
    });

    console.log("[mailer] Email sent successfully:", info.messageId);
    return { delivered: true, messageId: info.messageId };
  } catch (error) {
    console.error("[mailer] Failed to send email:", error);
    return { delivered: false, error: error.message };
  }
}

module.exports = { sendMail };