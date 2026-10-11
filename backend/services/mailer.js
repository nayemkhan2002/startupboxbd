/**
 * Outgoing email.
 *
 * BREVO_API_KEY set -> Brevo HTTPS API (port 443, never blocked by hosts)
 * EMAIL_USER/PASS   -> SMTP, retrying Brevo's alternate ports when the
 *                      configured one is unreachable (shared hosts often
 *                      block outbound 587)
 * neither           -> returns { sent: false } so callers can log instead
 */
const nodemailer = require('nodemailer');

const DEFAULT_FROM = { name: 'Startup Box Bangladesh', email: 'no-reply@startupboxbd.com' };

/** '"Name" <addr@x.com>' | 'Name <addr>' | 'addr' -> { name, email } */
const parseFrom = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_FROM;
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || DEFAULT_FROM.name, email: m[2].trim() };
  return { name: DEFAULT_FROM.name, email: raw };
};

const sendViaBrevoApi = async ({ to, subject, html }) => {
  const from = parseFrom(process.env.EMAIL_FROM);
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: from,
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo API ${res.status}: ${body.slice(0, 300)}`);
  }
  return { sent: true, via: 'brevo-api' };
};

// Errors that mean the server was reached; another port won't help
const isServerRejection = (err) =>
  err && (err.code === 'EAUTH' || err.code === 'EENVELOPE' || err.code === 'EMESSAGE' ||
    (typeof err.responseCode === 'number' && err.responseCode >= 400));

const sendViaSmtp = async ({ to, subject, html }) => {
  const host = process.env.EMAIL_HOST || 'smtp-relay.brevo.com';
  const configured = Number(process.env.EMAIL_PORT) || 587;
  const ports = [...new Set([configured, 2525, 465, 587])];
  const from = process.env.EMAIL_FROM || `"${DEFAULT_FROM.name}" <${process.env.EMAIL_USER}>`;
  const failures = [];

  for (const port of ports) {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000
    });
    try {
      await transporter.sendMail({ from, to, subject, html });
      if (port !== configured) {
        console.warn(`Email sent on port ${port}; port ${configured} is unreachable — set EMAIL_PORT=${port}`);
      }
      return { sent: true, via: `smtp:${port}` };
    } catch (err) {
      failures.push(`port ${port}: ${err.code || ''} ${err.response || err.message}`.trim());
      if (isServerRejection(err)) break;
    }
  }
  throw new Error(`SMTP send failed (${failures.join(' | ')})`);
};

/** Send one HTML email. Resolves { sent, via }; throws with the provider's reason on failure. */
const sendMail = async ({ to, subject, html }) => {
  if (process.env.BREVO_API_KEY) return sendViaBrevoApi({ to, subject, html });
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) return sendViaSmtp({ to, subject, html });
  return { sent: false, via: 'none' };
};

const isEmailConfigured = () =>
  Boolean(process.env.BREVO_API_KEY || (process.env.EMAIL_USER && process.env.EMAIL_PASS));

module.exports = { sendMail, isEmailConfigured, parseFrom };
