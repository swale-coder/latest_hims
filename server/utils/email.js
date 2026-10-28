const db = require('../db');

// No real email provider is configured out of the box, matching the SMS-simulation pattern
// already used elsewhere in this app (see server/utils/helpers.js:sendSMS). Every email is
// still generated with real content and recorded in email_log so nothing is silently lost -
// this is the ONLY function that would need to change to plug in a real provider
// (SendGrid, AWS SES, Postmark, etc). Nothing else in the codebase should call an email API
// directly.
//
// To wire in a real provider, set EMAIL_PROVIDER=<name> and the matching API key in .env,
// then replace the body of this function with that provider's send call - every caller
// (password reset, staff invitations) already passes everything needed (to, subject, body).
async function sendEmail(orgId, to, subject, body, eventType) {
  const configured = !!process.env.EMAIL_PROVIDER_API_KEY;
  (await db.prepare(`INSERT INTO email_log (organization_id, to_email, subject, body, event_type, status) VALUES (?,?,?,?,?,?)`)
    .run(orgId || null, to, subject, body, eventType || null, configured ? 'Sent' : 'Sent (Simulated)'));

  if (!configured && process.env.NODE_ENV !== 'test') {
    // Local/dev visibility - the actual reset/invite link is otherwise only in the DB.
    console.log(`\n[EMAIL - SIMULATED, no EMAIL_PROVIDER_API_KEY set]\nTo: ${to}\nSubject: ${subject}\n${body}\n`);
  }
}

module.exports = { sendEmail };
