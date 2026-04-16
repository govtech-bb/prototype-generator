/**
 * Generate a unique reference number for a form submission.
 *
 * Format: {PREFIX}-{YEAR}-{4 random alphanumeric}
 * Example: VP-2026-A8K3, VR-2026-9MFD, CVC-2026-X2LQ
 */

const PREFIXES = {
  'Apply for an Approved Vanity Plate': 'VP',
  'Register a Motor Vehicle': 'VR',
  'Request to Change the Colour of Vehicle': 'CVC',
  'Business Tax Clearance Certificate': 'BTC',
  'Direct Deposit Form': 'DD',
};

function generateReference(formName) {
  // Use known prefix, or auto-generate from form name initials
  let prefix = PREFIXES[formName];
  if (!prefix) {
    prefix = formName
      .split(/[\s\-_]+/)
      .filter(w => w.length > 0 && /^[A-Z]/i.test(w))
      .map(w => w[0].toUpperCase())
      .join('')
      .substring(0, 4) || 'REF';
  }
  const year = new Date().getFullYear();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O, 1/I
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}-${year}-${suffix}`;
}

module.exports = { generateReference };
