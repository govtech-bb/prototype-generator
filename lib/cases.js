/**
 * In-memory case/submission store for the Case Management System.
 *
 * Every form submission (from the form UI or chat) creates a case.
 * Caseworkers can view, approve, or reject cases via the CMS.
 */

'use strict';

/* ═══════════════════════════════════════════════
   Case store
   ═══════════════════════════════════════════════ */

const cases = new Map();

/* ═══════════════════════════════════════════════
   Mock caseworker accounts
   ═══════════════════════════════════════════════ */

const CASEWORKERS = {
  'admin': {
    username: 'admin',
    password: 'admin123',
    name: 'Admin User',
    role: 'Administrator',
  },
  'officer1': {
    username: 'officer1',
    password: 'officer123',
    name: 'Keisha Williams',
    role: 'Case Officer',
  },
  'officer2': {
    username: 'officer2',
    password: 'officer123',
    name: 'Marcus Thompson',
    role: 'Senior Case Officer',
  },
};

// Simple session tokens (in-memory)
const sessions = new Map();

/* ═══════════════════════════════════════════════
   Authentication
   ═══════════════════════════════════════════════ */

function login(username, password) {
  const worker = CASEWORKERS[username];
  if (!worker || worker.password !== password) {
    return null;
  }
  const token = 'cms_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 10);
  sessions.set(token, {
    username: worker.username,
    name: worker.name,
    role: worker.role,
    createdAt: Date.now(),
  });
  return { token, name: worker.name, role: worker.role };
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  // Sessions expire after 8 hours
  if (Date.now() - session.createdAt > 8 * 60 * 60 * 1000) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function logout(token) {
  sessions.delete(token);
}

/* ═══════════════════════════════════════════════
   Case management
   ═══════════════════════════════════════════════ */

/**
 * Create a new case from a form submission.
 *
 * @param {Object} params
 * @param {string} params.referenceNumber - The generated reference (e.g. CVC-2026-A8K3)
 * @param {string} params.formName - The form title
 * @param {Object} params.formData - All submitted field values
 * @param {string} [params.userEmail] - Applicant email
 * @param {string} [params.channel] - 'form' or 'chat'
 * @returns {Object} The created case
 */
function createCase({ referenceNumber, formName, formData, userEmail, channel }) {
  const caseRecord = {
    id: referenceNumber,
    formName,
    formData: { ...formData },
    userEmail: userEmail || formData['contact-email'] || formData['email'] || null,
    channel: channel || 'form',
    status: 'pending', // pending, approved, rejected
    submittedAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    decisionNotes: '',
    credentialId: null,
    credentialDelivered: false,
  };
  cases.set(referenceNumber, caseRecord);
  return caseRecord;
}

/**
 * Get all cases, newest first.
 * @param {Object} [filters] - Optional filters
 * @param {string} [filters.status] - Filter by status
 * @param {string} [filters.formName] - Filter by form name
 * @returns {Array} Array of case records
 */
function listCases(filters) {
  let result = Array.from(cases.values());

  if (filters) {
    if (filters.status) {
      result = result.filter(c => c.status === filters.status);
    }
    if (filters.formName) {
      result = result.filter(c => c.formName === filters.formName);
    }
  }

  // Sort newest first
  result.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  return result;
}

/**
 * Get a single case by reference number.
 */
function getCase(referenceNumber) {
  return cases.get(referenceNumber) || null;
}

/**
 * Approve a case. Returns the updated case.
 */
function approveCase(referenceNumber, decidedBy, notes) {
  const c = cases.get(referenceNumber);
  if (!c) return null;
  c.status = 'approved';
  c.decidedAt = new Date().toISOString();
  c.decidedBy = decidedBy;
  c.decisionNotes = notes || '';
  return c;
}

/**
 * Reject a case. Returns the updated case.
 */
function rejectCase(referenceNumber, decidedBy, notes) {
  const c = cases.get(referenceNumber);
  if (!c) return null;
  c.status = 'rejected';
  c.decidedAt = new Date().toISOString();
  c.decidedBy = decidedBy;
  c.decisionNotes = notes || '';
  return c;
}

/**
 * Record that a credential was issued for a case.
 */
function recordCredential(referenceNumber, credentialId, delivered) {
  const c = cases.get(referenceNumber);
  if (!c) return null;
  c.credentialId = credentialId;
  c.credentialDelivered = delivered;
  return c;
}

/**
 * Get distinct form names for filtering.
 */
function getFormNames() {
  const names = new Set();
  for (const c of cases.values()) {
    names.add(c.formName);
  }
  return Array.from(names).sort();
}

/**
 * Get case counts by status.
 */
function getCaseCounts() {
  const counts = { total: 0, pending: 0, approved: 0, rejected: 0 };
  for (const c of cases.values()) {
    counts.total++;
    counts[c.status]++;
  }
  return counts;
}

module.exports = {
  login,
  getSession,
  logout,
  createCase,
  listCases,
  getCase,
  approveCase,
  rejectCase,
  recordCredential,
  getFormNames,
  getCaseCounts,
};
