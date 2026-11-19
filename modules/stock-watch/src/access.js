'use strict';
const crypto = require('node:crypto');
/*
 * Who may do what (SW-029, ADR-0011). Two shared passwords, no user database:
 *   ADMIN_PASSWORD → role "admin": sees and changes everything.
 *   VIEW_PASSWORD  → role "view":  sees every number, changes nothing. Every write to /api is refused (403).
 * No ADMIN_PASSWORD at all → no sign-in, everyone is admin (local dev / demo only).
 * Pure helpers; server.js wires them into sign-in, the session cookie and the API.
 */

const ADMIN = 'admin';
const VIEW = 'view';
const READ_ONLY = 'View-only sign-in: ask an admin to make this change';

/** Problems that should stop the server from starting (VIEW_PASSWORD without, or equal to, ADMIN_PASSWORD). */
function configProblem({ admin = '', view = '' } = {}) {
  if (!view) return null;
  if (!admin) return 'VIEW_PASSWORD is set but ADMIN_PASSWORD is not: set ADMIN_PASSWORD too (without it nobody has to sign in).';
  if (view === admin) return 'VIEW_PASSWORD must differ from ADMIN_PASSWORD.';
  return null;
}

/** The role a typed password gives, or null. Admin is checked first. `eq` is a constant-time compare. */
function roleForPassword(pass, { admin = '', view = '' }, eq) {
  if (admin && eq(pass, admin)) return ADMIN;
  if (view && eq(pass, view)) return VIEW;
  return null;
}

/* Session cookie value. Admin keeps the old "exp.sig" form (existing sign-ins stay valid);
 * a view session is "exp.view.sig" with the role and a fingerprint of VIEW_PASSWORD inside the signed
 * text: it can't be edited into admin, and changing VIEW_PASSWORD signs every view session out. */
const fingerprint = (view) => crypto.createHash('sha256').update('view-password|' + view).digest('hex').slice(0, 16);
const signedText = (exp, role, view) => (role === VIEW ? `${exp}|${VIEW}|${fingerprint(view)}` : String(exp));
function cookieValue(exp, role, sign, view = '') {
  return role === VIEW ? `${exp}.${VIEW}.${sign(signedText(exp, VIEW, view))}` : `${exp}.${sign(signedText(exp, ADMIN))}`;
}
/** Role from a cookie value, or null when missing, expired, not signed by us, or a view session after VIEW_PASSWORD changed or was removed. */
function cookieRole(value, sign, eq, { view = '', now = Date.now() } = {}) {
  const parts = String(value || '').split('.');
  let exp, role, sig;
  if (parts.length === 2) [exp, sig, role] = [parts[0], parts[1], ADMIN];
  else if (parts.length === 3 && parts[1] === VIEW) [exp, sig, role] = [parts[0], parts[2], VIEW];
  else return null;
  if (!/^\d+$/.test(exp) || +exp <= now || !sig || (role === VIEW && !view)) return null;
  return eq(sig, sign(signedText(exp, role, view))) ? role : null;
}

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** True when this role may not make this request: a view session writing to /api. Reads are always allowed. */
function refused(role, method, pathname) {
  return role !== ADMIN && WRITES.has(String(method).toUpperCase()) && String(pathname).startsWith('/api/');
}

/** Settings as a role may see them: a view session never gets the ingest key (it would let them write via /ingest). */
function visibleSettings(settings, role) {
  if (role === ADMIN) return { ...settings };
  const { ingestKey, ...rest } = settings;   // eslint-disable-line no-unused-vars
  return rest;
}

module.exports = { ADMIN, VIEW, READ_ONLY, configProblem, roleForPassword, cookieValue, cookieRole, refused, visibleSettings };
