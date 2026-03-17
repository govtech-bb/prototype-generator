/**
 * Amazon SES email integration.
 *
 * Sends two emails per form submission:
 *  1. Confirmation to the applicant
 *  2. Notification to the MDA inbox
 */

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { confirmationEmail } = require('./templates/confirmation');
const { notificationEmail } = require('./templates/notification');

const REGION = process.env.AWS_REGION || 'us-east-1';
const ses = new SESClient({ region: REGION });

const FROM = process.env.FROM_EMAIL || 'noreply@example.com';
const MDA  = process.env.MDA_EMAIL  || 'admin@example.com';

/**
 * Send an email via SES.
 * @param {string} to — recipient email
 * @param {string} subject — email subject
 * @param {string} html — HTML body
 * @returns {Promise<{messageId: string}|null>}
 */
async function sendEmail(to, subject, html) {
  const resp = await ses.send(new SendEmailCommand({
    Source: FROM,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: html, Charset: 'UTF-8' },
      },
    },
  }));
  return { messageId: resp.MessageId };
}

/**
 * Send the confirmation email to the applicant.
 * Silently skips if no userEmail is provided.
 */
async function sendConfirmation(userEmail, formName, referenceNumber) {
  if (!userEmail) {
    console.log('  ↳ No user email — skipping confirmation email');
    return null;
  }

  try {
    const result = await sendEmail(
      userEmail,
      `Application received – ${referenceNumber}`,
      confirmationEmail(formName, referenceNumber),
    );

    console.log(`  ✓ Confirmation email sent to ${userEmail} (id: ${result.messageId})`);
    return result;
  } catch (err) {
    console.error('  ✗ Confirmation email failed:', err.message);
    return null;
  }
}

/**
 * Send the notification email to the MDA inbox with all form data.
 */
async function sendNotification(formName, formData, referenceNumber, userEmail) {
  try {
    const result = await sendEmail(
      MDA,
      `New submission: ${formName} – ${referenceNumber}`,
      notificationEmail(formName, formData, referenceNumber, userEmail),
    );

    console.log(`  ✓ MDA notification sent to ${MDA} (id: ${result.messageId})`);
    return result;
  } catch (err) {
    console.error('  ✗ MDA notification failed:', err.message);
    return null;
  }
}

module.exports = { sendConfirmation, sendNotification };
