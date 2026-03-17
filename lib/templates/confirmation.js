/**
 * HTML email template sent to the applicant confirming receipt.
 */

function confirmationEmail(formName, referenceNumber) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Figtree,-apple-system,system-ui,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.6;color:#000;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;">
    <tr><td align="center" style="padding:24px 16px;">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;">

        <!-- Blue top bar -->
        <tr><td style="background:#00267f;padding:8px 24px;color:#fff;font-size:13px;">
          Official communication from the Government of Barbados
        </td></tr>

        <!-- Yellow header -->
        <tr><td style="background:#ffc726;padding:16px 24px;">
          <strong style="font-size:18px;color:#000;">Government of Barbados</strong>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px 24px;">
          <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#000;">
            Your request has been received
          </h1>
          <p style="margin:0 0 24px;">
            Thank you for submitting your <strong>${formName}</strong>. We have received your application and it is now being processed.
          </p>

          <!-- Reference box -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#eaf9f9;border-left:4px solid #0e5f64;border-radius:4px;margin-bottom:24px;">
            <tr><td style="padding:16px 20px;">
              <p style="margin:0 0 4px;font-size:14px;color:#595959;">Your reference number</p>
              <p style="margin:0;font-size:28px;font-weight:700;color:#0e5f64;">${referenceNumber}</p>
              <p style="margin:8px 0 0;font-size:14px;color:#595959;">Please keep this for your records.</p>
            </td></tr>
          </table>

          <h2 style="margin:0 0 12px;font-size:18px;font-weight:700;color:#000;">What happens next</h2>
          <p style="margin:0 0 8px;">Your request will be reviewed by the Barbados Licensing Authority. You will be contacted if any further information is required.</p>
          <p style="margin:0 0 24px;">If you have any questions, please contact the Barbados Licensing Authority and quote your reference number.</p>

          <p style="margin:0;font-size:14px;color:#595959;">
            This is an automated email. Please do not reply directly to this message.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#00267f;padding:16px 24px;color:#fff;font-size:13px;">
          &copy; ${new Date().getFullYear()} Government of Barbados. All rights reserved.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { confirmationEmail };
