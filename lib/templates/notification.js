/**
 * HTML email template sent to the MDA inbox with full submission data.
 */

/**
 * Convert a field key like "full-name" or "firstName" to "Full Name".
 */
function humanise(key) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase → camel Case
    .replace(/[-_]/g, ' ')                   // kebab-case / snake_case → spaces
    .replace(/\b\w/g, c => c.toUpperCase()); // capitalise each word
}

function notificationEmail(formName, formData, referenceNumber, userEmail) {
  const now = new Date();
  const timestamp = now.toLocaleString('en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'America/Barbados',
  });

  // Build data rows, skipping empty values
  const rows = Object.entries(formData)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([key, value], i) => {
      const bg = i % 2 === 0 ? '#f9f9f9' : '#ffffff';
      return `<tr style="background:${bg};">
        <td style="padding:10px 14px;border-bottom:1px solid #e0e4e9;font-weight:600;vertical-align:top;width:40%;color:#000;">${humanise(key)}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e0e4e9;color:#000;">${String(value)}</td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Figtree,-apple-system,system-ui,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.6;color:#000;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;">
    <tr><td align="center" style="padding:24px 16px;">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;">

        <!-- Blue top bar -->
        <tr><td style="background:#00267f;padding:8px 24px;color:#fff;font-size:13px;">
          Form Submission Notification
        </td></tr>

        <!-- Yellow header -->
        <tr><td style="background:#ffc726;padding:16px 24px;">
          <strong style="font-size:18px;color:#000;">Government of Barbados</strong>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px 24px;">
          <h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#000;">
            New Submission: ${formName}
          </h1>
          <p style="margin:0 0 4px;font-size:14px;color:#595959;">
            Reference: <strong style="color:#0e5f64;">${referenceNumber}</strong>
          </p>
          <p style="margin:0 0 4px;font-size:14px;color:#595959;">
            Submitted: ${timestamp}
          </p>
          ${userEmail ? `<p style="margin:0 0 24px;font-size:14px;color:#595959;">Applicant email: <a href="mailto:${userEmail}" style="color:#0e5f64;">${userEmail}</a></p>` : '<p style="margin:0 0 24px;font-size:14px;color:#595959;">Applicant email: Not provided</p>'}

          <!-- Data table -->
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e4e9;border-radius:4px;border-collapse:collapse;margin-bottom:24px;">
            <tr style="background:#00267f;">
              <th style="padding:10px 14px;text-align:left;color:#fff;font-size:14px;font-weight:600;">Field</th>
              <th style="padding:10px 14px;text-align:left;color:#fff;font-size:14px;font-weight:600;">Value</th>
            </tr>
            ${rows}
          </table>

          <p style="margin:0;font-size:14px;color:#595959;">
            This is an automated submission from the online forms system.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#00267f;padding:16px 24px;color:#fff;font-size:13px;">
          &copy; ${new Date().getFullYear()} Government of Barbados &middot; GovTech Barbados
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { notificationEmail };
