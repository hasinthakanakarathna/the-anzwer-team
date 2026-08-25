const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const csurf = require('csurf');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Every request gets a traceable identifier for logs, errors, and audit events.
app.use((req, res, next) => {
  const supplied = req.get('X-Request-ID');
  req.requestId = supplied && /^[A-Za-z0-9_.-]{1,80}$/.test(supplied) ? supplied : `req_${crypto.randomUUID()}`;
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// ---------------------------------------------------------------------------
// Hard fail if a real secret hasn't been provided in production. Never ship
// with the fallback dev secret.
// ---------------------------------------------------------------------------
if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable must be set in production.');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

// Keep all persistent data (db + sessions) outside of anything web-servable.
// On Fly.io this points at the mounted volume; locally it defaults to ./data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// If behind a reverse proxy (nginx, Heroku, etc.) so secure cookies work.
if (IS_PROD) app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Security headers. Tailwind's CDN build and html2pdf.js both need to be
// explicitly allow-listed; everything else defaults to 'self'.
// ---------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind's CDN build injects inline <style>
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(cookieParser());

app.use(
  session({
    store: new FileStore({ path: path.join(DATA_DIR, 'sessions'), secret: SESSION_SECRET, logFn: () => {} }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'sid', // don't advertise "connect.sid" / express defaults
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD, // requires HTTPS in production
      maxAge: 8 * 60 * 60 * 1000, // 8 hour session
    },
  })
);

// CSRF protection, keyed off the session (no extra cookie needed).
// Safe methods (GET/HEAD/OPTIONS) are exempt automatically.
const csrfProtection = csurf({ cookie: false });
app.use(csrfProtection);

// Let the front-end fetch a token before making a state-changing request.
app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// ---------------------------------------------------------------------------
// Rate limiting on the auth endpoints most attractive to brute-force/credential
// stuffing. Keyed by IP; tune windowMs/max to your traffic.
// ---------------------------------------------------------------------------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const identityPreviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many identity previews. Please wait and try again.' },
});

// DB
const db = new Database(path.join(DATA_DIR, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee'
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('INCIDENT', 'REQUEST', 'PROBLEM', 'CHANGE', 'TASK')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'NEW',
  priority TEXT NOT NULL DEFAULT 'P3',
  impact INTEGER NOT NULL DEFAULT 2 CHECK (impact BETWEEN 1 AND 3),
  urgency INTEGER NOT NULL DEFAULT 2 CHECK (urgency BETWEEN 1 AND 3),
  requester_id INTEGER NOT NULL,
  assignee_id INTEGER,
  assigned_team TEXT,
  category TEXT,
  due_at DATETIME,
  resolution TEXT,
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  closed_at DATETIME,
  FOREIGN KEY (requester_id) REFERENCES users(id),
  FOREIGN KEY (assignee_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ticket_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (actor_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC', 'INTERNAL')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ticket_work_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  started_at DATETIME NOT NULL,
  ended_at DATETIME NOT NULL,
  activity TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  result TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  request_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ticket_sequences (
  year INTEGER NOT NULL,
  type TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (year, type)
);

CREATE TABLE IF NOT EXISTS identity_sequences (
  birth_year INTEGER NOT NULL,
  account_type TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (birth_year, account_type)
);

CREATE TABLE IF NOT EXISTS team_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_code TEXT UNIQUE NOT NULL,
  invited_name TEXT,
  invited_email TEXT,
  admin_access INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'USED', 'REVOKED')),
  created_by INTEGER NOT NULL,
  used_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  used_at DATETIME,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (used_by) REFERENCES users(id)
);
`);

const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
const addUserColumn = (definition, name) => {
  if (!userColumns.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${definition}`);
};
addUserColumn("account_type TEXT NOT NULL DEFAULT 'EMPLOYEE'", 'account_type');
addUserColumn("account_status TEXT NOT NULL DEFAULT 'ACTIVE'", 'account_status');
addUserColumn('employee_id TEXT', 'employee_id');
addUserColumn('customer_id TEXT', 'customer_id');
addUserColumn('full_name TEXT', 'full_name');
addUserColumn('email TEXT', 'email');
addUserColumn('phone TEXT', 'phone');
addUserColumn('department TEXT', 'department');
addUserColumn('job_title TEXT', 'job_title');
addUserColumn('location TEXT', 'location');
addUserColumn('shop_name TEXT', 'shop_name');
addUserColumn('linkedin_url TEXT', 'linkedin_url');
addUserColumn('instagram_url TEXT', 'instagram_url');
addUserColumn('whatsapp_url TEXT', 'whatsapp_url');
addUserColumn('github_url TEXT', 'github_url');
addUserColumn('verified_at DATETIME', 'verified_at');
addUserColumn('approved_by INTEGER', 'approved_by');
addUserColumn('force_password_reset INTEGER NOT NULL DEFAULT 0', 'force_password_reset');
db.exec("UPDATE users SET account_type = CASE WHEN role = 'admin' THEN 'ADMIN' ELSE 'EMPLOYEE' END WHERE account_type IS NULL OR account_type = ''");
db.exec("UPDATE users SET account_type = 'ADMIN' WHERE role = 'admin'");
db.exec("UPDATE users SET account_status = 'ACTIVE' WHERE account_status IS NULL OR account_status = ''");
db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (1)').run();
db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (2)').run();

const getUserByUsername = db.prepare(`SELECT id, username, password_hash, role, account_type, account_status,
  employee_id, customer_id, full_name, email, phone, department, job_title, force_password_reset
  FROM users WHERE username = ?`);
const createUser = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');

function identityId(prefix) {
  return `${prefix}-${new Date().getUTCFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function createTeamReference() {
  let code;
  do {
    code = `ANZ-TEAM-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  } while (db.prepare('SELECT 1 FROM team_invitations WHERE reference_code = ?').get(code));
  return code;
}

function extractBirthYear(nic) {
  if (typeof nic !== 'string') return null;
  const normalized = nic.replace(/\s|-/g, '');
  const year = Number(normalized.slice(0, 4));
  return /^\d{4}[A-Za-z0-9]{4,}$/.test(normalized) && year >= 1900 && year <= new Date().getUTCFullYear() ? year : null;
}

function createRecognizedIdentity(accountType, birthYear) {
  const prefix = accountType === 'EMPLOYEE' ? 'EMP' : 'CLI';
  const create = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO identity_sequences (birth_year, account_type) VALUES (?, ?)').run(birthYear, accountType);
    const current = db.prepare('SELECT next_value FROM identity_sequences WHERE birth_year = ? AND account_type = ?').get(birthYear, accountType).next_value;
    const existingIds = db.prepare(`SELECT employee_id AS identity FROM users WHERE account_type = 'EMPLOYEE' AND employee_id LIKE ?
      UNION ALL SELECT customer_id AS identity FROM users WHERE account_type = 'CLIENT' AND customer_id LIKE ?`).all(`${prefix}${birthYear}%`, `${prefix}${birthYear}%`);
    const highestExisting = existingIds.reduce((highest, row) => Math.max(highest, Number(String(row.identity || '').slice(7)) || 0), 0);
    const sequence = Math.max(current, highestExisting + 1);
    db.prepare('UPDATE identity_sequences SET next_value = ? WHERE birth_year = ? AND account_type = ?').run(sequence + 1, birthYear, accountType);
    return `${prefix}${birthYear}${String(sequence).padStart(4, '0')}`;
  });
  return create();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    accountType: user.account_type || (user.role === 'admin' ? 'ADMIN' : 'EMPLOYEE'),
    accountStatus: user.account_status || 'ACTIVE',
    employeeId: user.employee_id || null,
    customerId: user.customer_id || null,
    fullName: user.full_name || user.username,
    email: user.email || null,
    phone: user.phone || null,
    department: user.department || null,
    jobTitle: user.job_title || null,
    location: user.location || null,
    shopName: user.shop_name || null,
    linkedinUrl: user.linkedin_url || null,
    instagramUrl: user.instagram_url || null,
    whatsappUrl: user.whatsapp_url || null,
    githubUrl: user.github_url || null,
    forcePasswordReset: Boolean(user.force_password_reset),
  };
}

// Seed an admin if none exists
const adminExists = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get().c;
(async () => {
  if (!adminExists) {
    const pw = require('crypto').randomBytes(9).toString('base64url');
    const hash = await bcrypt.hash(pw, 12);
    createUser.run('admin', hash, 'admin');
    db.prepare("UPDATE users SET account_type = 'ADMIN', account_status = 'ACTIVE', full_name = 'System Administrator' WHERE username = 'admin'").run();
    console.log('Seeded admin user -> username: admin password:', pw);
    console.log('Please log in and change this password immediately.');
  }
})();

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function isValidUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username);
}

function isValidPassword(password) {
  // At least 8 chars, at least one letter and one number.
  return (
    typeof password === 'string' &&
    password.length >= 8 &&
    password.length <= 200 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const user = db.prepare('SELECT account_status FROM users WHERE id = ?').get(req.session.userId);
    if (user && user.account_status !== 'DISABLED') return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireRole(role) {
  return function (req, res, next) {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = db.prepare('SELECT role, account_status FROM users WHERE id = ?').get(req.session.userId);
    if (!user || user.account_status === 'DISABLED') return res.status(401).json({ error: 'Unauthorized' });
    if (user.role !== role && user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

const STAFF_ROLES = new Set(['admin', 'employee', 'SUPER_ADMIN', 'SYSTEM_ADMIN', 'IT_MANAGER', 'TEAM_LEAD', 'IT_SUPPORT', 'IT_ENGINEER', 'SECURITY_ANALYST']);
const TICKET_TYPES = new Set(['INCIDENT', 'REQUEST', 'PROBLEM', 'CHANGE', 'TASK']);
const TICKET_STATUSES = new Set(['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED', 'REOPENED']);
const STATUS_TRANSITIONS = {
  NEW: ['ASSIGNED', 'IN_PROGRESS'],
  ASSIGNED: ['IN_PROGRESS', 'PENDING'],
  IN_PROGRESS: ['PENDING', 'RESOLVED'],
  PENDING: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['CLOSED', 'REOPENED'],
  REOPENED: ['IN_PROGRESS'],
  CLOSED: [],
};

function isStaff(req) {
  return STAFF_ROLES.has(req.session?.role);
}

function requireStaff(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized', requestId: req.requestId });
  if (!isStaff(req)) return res.status(403).json({ error: 'Staff permission required', requestId: req.requestId });
  next();
}

function priorityFor(impact, urgency) {
  const highest = Math.max(impact, urgency);
  if (impact === 3 && urgency === 3) return 'P1';
  if (highest === 3) return 'P2';
  if (highest === 2) return 'P3';
  return 'P4';
}

function ticketPrefix(type) {
  return { INCIDENT: 'INC', REQUEST: 'REQ', PROBLEM: 'PRB', CHANGE: 'CHG', TASK: 'TASK' }[type];
}

function audit(req, action, resource, resourceId, oldValue, newValue, result = 'SUCCESS') {
  const actorExists = req.session?.userId && db.prepare('SELECT 1 FROM users WHERE id = ?').get(req.session.userId);
  db.prepare(`INSERT INTO audit_logs
    (actor_id, action, resource, resource_id, ip_address, user_agent, result, old_value, new_value, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    actorExists ? req.session.userId : null,
    action,
    resource,
    resourceId ? String(resourceId) : null,
    req.ip,
    req.get('user-agent') || null,
    result,
    oldValue ? JSON.stringify(oldValue) : null,
    newValue ? JSON.stringify(newValue) : null,
    req.requestId
  );
}

function ticketForUser(req, ticketId) {
  const ticket = db.prepare(`SELECT t.*, requester.username AS requester, assignee.username AS assignee
    FROM tickets t JOIN users requester ON requester.id = t.requester_id
    LEFT JOIN users assignee ON assignee.id = t.assignee_id WHERE t.id = ?`).get(ticketId);
  if (!ticket) return null;
  if (!isStaff(req) && ticket.requester_id !== req.session.userId) return null;
  return ticket;
}

// ITSM v1: additive API surface for the workbench.
app.get('/api/v1/dashboard', requireAuth, (req, res) => {
  const visibility = isStaff(req) ? '' : 'WHERE requester_id = @userId';
  const params = isStaff(req) ? {} : { userId: req.session.userId };
  const counts = db.prepare(`SELECT
    COUNT(*) AS total,
    SUM(status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'REOPENED')) AS open,
    SUM(status = 'IN_PROGRESS') AS in_progress,
    SUM(status = 'PENDING') AS pending,
    SUM(status = 'RESOLVED') AS resolved,
    SUM(priority = 'P1' AND status NOT IN ('CLOSED', 'RESOLVED')) AS critical
    FROM tickets ${visibility}`).get(params);
  const recent = db.prepare(`SELECT ticket_number, type, title, status, priority, updated_at
    FROM tickets ${visibility} ORDER BY updated_at DESC LIMIT 8`).all(params);
  res.json({ counts, recent, role: req.session.role, requestId: req.requestId });
});

app.get('/api/v1/tickets', requireAuth, (req, res) => {
  const filters = [];
  const params = {};
  if (!isStaff(req)) {
    filters.push('t.requester_id = @userId');
    params.userId = req.session.userId;
  }
  if (typeof req.query.status === 'string' && TICKET_STATUSES.has(req.query.status)) {
    filters.push('t.status = @status');
    params.status = req.query.status;
  }
  if (typeof req.query.priority === 'string' && /^P[1-4]$/.test(req.query.priority)) {
    filters.push('t.priority = @priority');
    params.priority = req.query.priority;
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT t.id, t.ticket_number, t.type, t.title, t.status, t.priority,
    t.created_at, t.updated_at, requester.username AS requester, assignee.username AS assignee
    FROM tickets t JOIN users requester ON requester.id = t.requester_id
    LEFT JOIN users assignee ON assignee.id = t.assignee_id ${where} ORDER BY t.updated_at DESC LIMIT 100`).all(params);
  res.json({ tickets: rows, requestId: req.requestId });
});

app.post('/api/v1/tickets', requireAuth, (req, res) => {
  const { type, title, description = '', impact = 2, urgency = 2, category = null } = req.body || {};
  const normalizedImpact = Number(impact);
  const normalizedUrgency = Number(urgency);
  if (!TICKET_TYPES.has(type) || typeof title !== 'string' || title.trim().length < 3 || title.length > 160) {
    return res.status(400).json({ error: 'Type and title are required', requestId: req.requestId });
  }
  if (![1, 2, 3].includes(normalizedImpact) || ![1, 2, 3].includes(normalizedUrgency)) {
    return res.status(400).json({ error: 'Impact and urgency must be between 1 and 3', requestId: req.requestId });
  }
  if (!isStaff(req) && !['INCIDENT', 'REQUEST'].includes(type)) {
    return res.status(403).json({ error: 'Clients can only raise incidents or service requests', requestId: req.requestId });
  }
  const priority = priorityFor(normalizedImpact, normalizedUrgency);
  const year = new Date().getUTCFullYear();
  const createTicket = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO ticket_sequences (year, type) VALUES (?, ?)').run(year, type);
    const sequence = db.prepare('SELECT next_value FROM ticket_sequences WHERE year = ? AND type = ?').get(year, type).next_value;
    db.prepare('UPDATE ticket_sequences SET next_value = next_value + 1 WHERE year = ? AND type = ?').run(year, type);
    const ticketNumber = `${ticketPrefix(type)}-${year}-${String(sequence).padStart(6, '0')}`;
    const result = db.prepare(`INSERT INTO tickets
      (ticket_number, type, title, description, priority, impact, urgency, requester_id, created_by, updated_by, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ticketNumber, type, title.trim(), String(description).slice(0, 20000), priority, normalizedImpact, normalizedUrgency, req.session.userId, req.session.userId, req.session.userId, category);
    db.prepare('INSERT INTO ticket_status_history (ticket_id, to_status, actor_id) VALUES (?, ?, ?)').run(result.lastInsertRowid, 'NEW', req.session.userId);
    return { id: result.lastInsertRowid, ticketNumber };
  });
  const created = createTicket();
  audit(req, 'TICKET_CREATED', 'ticket', created.id, null, { ticketNumber: created.ticketNumber, type, priority });
  res.status(201).json({ ticket: ticketForUser(req, created.id), requestId: req.requestId });
});

app.get('/api/v1/tickets/:id', requireAuth, (req, res) => {
  const ticket = ticketForUser(req, Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket not found', requestId: req.requestId });
  const comments = db.prepare(`SELECT c.id, c.body, c.visibility, c.created_at, u.username AS author
    FROM ticket_comments c JOIN users u ON u.id = c.author_id WHERE c.ticket_id = ? ${isStaff(req) ? '' : "AND c.visibility = 'PUBLIC'"} ORDER BY c.created_at`).all(ticket.id);
  const history = db.prepare(`SELECT h.from_status, h.to_status, h.created_at, u.username AS actor
    FROM ticket_status_history h JOIN users u ON u.id = h.actor_id WHERE h.ticket_id = ? ORDER BY h.created_at`).all(ticket.id);
  const workLogs = db.prepare(`SELECT w.started_at, w.ended_at, w.activity, w.created_at, u.username AS author
    FROM ticket_work_logs w JOIN users u ON u.id = w.author_id WHERE w.ticket_id = ? ORDER BY w.started_at`).all(ticket.id);
  res.json({ ticket, comments, history, workLogs, requestId: req.requestId });
});

app.patch('/api/v1/tickets/:id', requireAuth, (req, res) => {
  const ticket = ticketForUser(req, Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket not found', requestId: req.requestId });
  const nextStatus = req.body?.status;
  if (!TICKET_STATUSES.has(nextStatus) || !STATUS_TRANSITIONS[ticket.status].includes(nextStatus)) {
    return res.status(409).json({ error: `Invalid transition from ${ticket.status}`, requestId: req.requestId });
  }
  if (!isStaff(req) && nextStatus !== 'CLOSED' && nextStatus !== 'PENDING') {
    return res.status(403).json({ error: 'Staff permission required', requestId: req.requestId });
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE tickets SET status = ?, updated_by = ?, updated_at = ?,
      resolved_at = CASE WHEN ? = 'RESOLVED' THEN ? ELSE resolved_at END,
      closed_at = CASE WHEN ? = 'CLOSED' THEN ? ELSE closed_at END WHERE id = ?`).run(nextStatus, req.session.userId, now, nextStatus, now, nextStatus, now, ticket.id);
    db.prepare('INSERT INTO ticket_status_history (ticket_id, from_status, to_status, actor_id) VALUES (?, ?, ?, ?)').run(ticket.id, ticket.status, nextStatus, req.session.userId);
  })();
  audit(req, 'TICKET_STATUS_CHANGED', 'ticket', ticket.id, { status: ticket.status }, { status: nextStatus });
  res.json({ ticket: ticketForUser(req, ticket.id), requestId: req.requestId });
});

app.post('/api/v1/tickets/:id/comments', requireAuth, (req, res) => {
  const ticket = ticketForUser(req, Number(req.params.id));
  const { body, visibility = 'PUBLIC' } = req.body || {};
  if (!ticket) return res.status(404).json({ error: 'Ticket not found', requestId: req.requestId });
  if (typeof body !== 'string' || body.trim().length < 1 || body.length > 10000) return res.status(400).json({ error: 'Comment is required', requestId: req.requestId });
  if (!['PUBLIC', 'INTERNAL'].includes(visibility) || (visibility === 'INTERNAL' && !isStaff(req))) return res.status(403).json({ error: 'Internal notes require staff access', requestId: req.requestId });
  const result = db.prepare('INSERT INTO ticket_comments (ticket_id, author_id, body, visibility) VALUES (?, ?, ?, ?)').run(ticket.id, req.session.userId, body.trim(), visibility);
  audit(req, visibility === 'INTERNAL' ? 'TICKET_INTERNAL_NOTE_ADDED' : 'TICKET_COMMENT_ADDED', 'ticket', ticket.id, null, { commentId: result.lastInsertRowid });
  res.status(201).json({ id: result.lastInsertRowid, requestId: req.requestId });
});

app.post('/api/v1/tickets/:id/worklogs', requireStaff, (req, res) => {
  const ticket = ticketForUser(req, Number(req.params.id));
  const { startedAt, endedAt, activity } = req.body || {};
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found', requestId: req.requestId });
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || typeof activity !== 'string' || !activity.trim()) return res.status(400).json({ error: 'Valid times and activity are required', requestId: req.requestId });
  const result = db.prepare('INSERT INTO ticket_work_logs (ticket_id, author_id, started_at, ended_at, activity) VALUES (?, ?, ?, ?, ?)').run(ticket.id, req.session.userId, new Date(start).toISOString(), new Date(end).toISOString(), activity.trim().slice(0, 4000));
  audit(req, 'TICKET_WORKLOG_ADDED', 'ticket', ticket.id, null, { workLogId: result.lastInsertRowid });
  res.status(201).json({ id: result.lastInsertRowid, requestId: req.requestId });
});

app.get('/api/v1/audit-logs', requireRole('admin'), (req, res) => {
  const rows = db.prepare(`SELECT a.id, a.action, a.resource, a.resource_id, a.result, a.request_id, a.created_at, u.username AS actor
    FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 200`).all();
  res.json({ auditLogs: rows, requestId: req.requestId });
});

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = getUserByUsername.get(username);
  // Always run bcrypt.compare, even on unknown username, so response timing
  // doesn't reveal whether the account exists.
  const hashToCheck = user ? user.password_hash : '$2b$12$invalidsaltinvalidsaltinvalidsaltinvalidsaltinvalidsalt';
  const ok = await bcrypt.compare(password, hashToCheck);

  if (!user || !ok) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.account_status === 'PENDING') return res.status(403).json({ error: 'Your employee account is awaiting verification.' });
  if (user.account_status === 'DISABLED') return res.status(403).json({ error: 'This account has been disabled.' });

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Login failed' });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.accountType = user.account_type;
    res.json({ user: publicUser(user) });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.json({ ok: true });
  });
});

app.get('/api/whoami', (req, res) => {
  if (!req.session || !req.session.userId) return res.json({ user: null });
  const user = db.prepare(`SELECT id, username, role, account_type, account_status, employee_id, customer_id,
    full_name, email, phone, department, job_title, force_password_reset FROM users WHERE id = ?`).get(req.session.userId);
  if (!user || user.account_status === 'DISABLED') return res.json({ user: null });
  return res.json({ user: publicUser(user) });
});

// User management (admin)
app.get('/api/users', requireRole('admin'), (req, res) => {
  const rows = db.prepare(`SELECT id, username, role, account_type, account_status, employee_id, customer_id,
    full_name, email, phone, department, job_title, verified_at FROM users ORDER BY id DESC`).all();
  res.json(rows);
});

app.get('/api/users/invitations', requireRole('admin'), (req, res) => {
  const invitations = db.prepare(`SELECT id, reference_code, invited_name, invited_email, admin_access, status, created_at, used_at
    FROM team_invitations ORDER BY id DESC LIMIT 100`).all();
  res.json(invitations);
});

app.post('/api/users/invitations', requireRole('admin'), (req, res) => {
  const { invitedName = '', invitedEmail = '', adminAccess = false } = req.body || {};
  if (typeof invitedName !== 'string' || invitedName.length > 120 || typeof invitedEmail !== 'string' || invitedEmail.length > 160) {
    return res.status(400).json({ error: 'Invalid team member details' });
  }
  if (invitedEmail && !/^\S+@\S+\.\S+$/.test(invitedEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
  const referenceCode = createTeamReference();
  db.prepare(`INSERT INTO team_invitations (reference_code, invited_name, invited_email, admin_access, created_by)
    VALUES (?, ?, ?, ?, ?)`).run(referenceCode, invitedName.trim() || null, invitedEmail.trim().toLowerCase() || null, adminAccess ? 1 : 0, req.session.userId);
  audit(req, 'TEAM_INVITATION_CREATED', 'team_invitation', referenceCode, null, { adminAccess: Boolean(adminAccess) });
  res.status(201).json({ ok: true, referenceCode, adminAccess: Boolean(adminAccess) });
});

app.patch('/api/users/:id/verification', requireRole('admin'), (req, res) => {
  const userId = Number(req.params.id);
  const { status } = req.body || {};
  if (!Number.isInteger(userId) || !['ACTIVE', 'DISABLED'].includes(status)) return res.status(400).json({ error: 'Invalid verification update' });
  const target = db.prepare('SELECT id, account_type, account_status FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  db.prepare(`UPDATE users SET account_status = ?, verified_at = CASE WHEN ? = 'ACTIVE' THEN CURRENT_TIMESTAMP ELSE verified_at END,
    approved_by = CASE WHEN ? = 'ACTIVE' THEN ? ELSE approved_by END WHERE id = ?`).run(status, status, status, req.session.userId, userId);
  audit(req, status === 'ACTIVE' ? 'EMPLOYEE_VERIFIED' : 'ACCOUNT_DISABLED', 'user', userId, { status: target.account_status }, { status });
  res.json({ ok: true, status });
});

app.patch('/api/users/:id/admin-access', requireRole('admin'), (req, res) => {
  const userId = Number(req.params.id);
  const target = db.prepare('SELECT id, role, account_type, account_status FROM users WHERE id = ?').get(userId);
  if (!target || target.account_type !== 'EMPLOYEE' || target.account_status !== 'ACTIVE') return res.status(400).json({ error: 'Only verified employees can receive admin access' });
  db.prepare("UPDATE users SET role = 'admin', account_type = 'ADMIN' WHERE id = ?").run(userId);
  audit(req, 'ADMIN_ACCESS_GRANTED', 'user', userId, { role: target.role }, { role: 'admin' });
  res.json({ ok: true });
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars: letters, numbers, _ . -' });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: 'Password must be 8+ chars with a letter and a number' });
  }
  const safeRole = role === 'admin' ? 'admin' : 'employee';
  const hash = await bcrypt.hash(password, 12);
  try {
    const result = db.prepare(`INSERT INTO users
      (username, password_hash, role, account_type, account_status, employee_id, full_name)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`).run(username, hash, safeRole, safeRole === 'admin' ? 'ADMIN' : 'EMPLOYEE', safeRole === 'admin' ? null : identityId('EMP'), username);
    audit(req, 'ACCOUNT_CREATED_BY_ADMIN', 'user', result.lastInsertRowid, null, { role: safeRole });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'User exists or invalid' });
  }
});

app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  // Don't allow an admin to delete their own account by accident/self-lockout.
  if (id === req.session.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account while logged in' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/register/identity-preview', identityPreviewLimiter, (req, res) => {
  const { accountType = 'CLIENT', nicNumber } = req.body || {};
  const birthYear = extractBirthYear(nicNumber);
  if (!['CLIENT', 'EMPLOYEE'].includes(accountType) || !birthYear) {
    return res.status(400).json({ error: 'Enter a NIC beginning with a valid four-digit birth year' });
  }
  const id = createRecognizedIdentity(accountType, birthYear);
  req.session.registrationIdentity = { id, accountType, birthYear };
  res.json({ id });
});

// Public registration endpoint - create an employee account
app.post('/api/register', authLimiter, async (req, res) => {
  const { password, accountType = 'CLIENT', fullName, email, phone, department, jobTitle, location, shopName, nicNumber, referenceCode } = req.body || {};
  if (!isValidPassword(password)) {
    return res.status(400).json({ error: 'Password must be 8+ chars with a letter and a number' });
  }
  if (!['CLIENT', 'EMPLOYEE'].includes(accountType)) {
    return res.status(400).json({ error: 'Choose a client or employee account' });
  }
  const birthYear = extractBirthYear(nicNumber);
  if (!birthYear) return res.status(400).json({ error: 'NIC must begin with a four-digit birth year, for example 2004...' });
  let invitation = null;
  if (accountType === 'EMPLOYEE') {
    if (typeof referenceCode !== 'string' || !/^ANZ-TEAM-[A-F0-9]{10}$/.test(referenceCode.trim().toUpperCase())) {
      return res.status(400).json({ error: 'A valid team reference code is required for employee registration' });
    }
    invitation = db.prepare("SELECT id, admin_access, status FROM team_invitations WHERE reference_code = ?").get(referenceCode.trim().toUpperCase());
    if (!invitation || invitation.status !== 'AVAILABLE') return res.status(403).json({ error: 'That team reference code is invalid or has already been used' });
  }
  if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.length > 120) {
    return res.status(400).json({ error: 'Full name is required' });
  }
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || email.length > 160) {
    return res.status(400).json({ error: 'A valid email is required' });
  }
  if (accountType === 'CLIENT' && (typeof location !== 'string' || location.trim().length < 2 || location.length > 160 || typeof shopName !== 'string' || shopName.trim().length < 2 || shopName.length > 160)) {
    return res.status(400).json({ error: 'Location and shop/workspace name are required for clients' });
  }

  const hash = await bcrypt.hash(password, 12);
  try {
    const isEmployee = accountType === 'EMPLOYEE';
    const reserved = req.session.registrationIdentity;
    const username = reserved && reserved.accountType === accountType && reserved.birthYear === birthYear
      ? reserved.id
      : createRecognizedIdentity(accountType, birthYear);
    const employeeId = isEmployee ? username : null;
    const customerId = isEmployee ? null : username;
    const status = isEmployee ? 'ACTIVE' : 'ACTIVE';
    const role = isEmployee && invitation.admin_access ? 'admin' : isEmployee ? 'employee' : 'client';
    const registeredAccountType = isEmployee && invitation.admin_access ? 'ADMIN' : accountType;
    const result = db.prepare(`INSERT INTO users
      (username, password_hash, role, account_type, account_status, employee_id, customer_id, full_name, email, phone, department, job_title, location, shop_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(username, hash, role, registeredAccountType, status, employeeId, customerId, fullName.trim(), email.trim().toLowerCase(), phone || null, isEmployee ? department || null : null, isEmployee ? jobTitle || null : null, location || null, shopName || null);
    if (invitation) db.prepare("UPDATE team_invitations SET status = 'USED', used_by = ?, used_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'AVAILABLE'").run(result.lastInsertRowid, invitation.id);
    delete req.session.registrationIdentity;
    audit(req, 'ACCOUNT_REGISTERED', 'user', result.lastInsertRowid, null, { accountType: registeredAccountType, employeeId, customerId, status });
    return res.status(201).json({ ok: true, username, accountType: registeredAccountType, employeeId, customerId, status });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That generated identity is already in use. Please submit again.' });
    console.error('Registration failed:', e.code || 'unknown database error');
    return res.status(500).json({ error: 'We could not create the account. Please try again.', requestId: req.requestId });
  }
});

// Change password for authenticated user
app.post('/api/users/change-password', requireAuth, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !isValidPassword(newPassword)) {
    return res.status(400).json({ error: 'New password must be 8+ chars with a letter and a number' });
  }

  const userRow = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.session.userId);
  if (!userRow) return res.status(401).json({ error: 'Unauthorized' });

  const ok = await bcrypt.compare(currentPassword, userRow.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid current password' });

  const newHash = await bcrypt.hash(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.session.userId);
  res.json({ ok: true });
});

// Employee endpoints for reports
app.get('/api/reports', requireAuth, (req, res) => {
  const rows = isStaff(req)
    ? db.prepare(`SELECT r.id, r.user_id, r.content, r.created_at, u.username, u.full_name, u.employee_id
      FROM reports r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC`).all()
    : db.prepare('SELECT id, user_id, content, created_at FROM reports WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  res.json(rows);
});

app.post('/api/reports', requireAuth, (req, res) => {
  const { content } = req.body || {};
  if (!content || typeof content !== 'string' || content.length > 20000) {
    return res.status(400).json({ error: 'Missing or invalid content' });
  }
  db.prepare('INSERT INTO reports (user_id, content) VALUES (?, ?)').run(req.session.userId, content);
  audit(req, 'DAILY_REPORT_SUBMITTED', 'report', null, null, { length: content.length });
  res.json({ ok: true });
});

app.get('/api/v1/reports/management', requireStaff, (req, res) => {
  const rows = db.prepare(`SELECT r.id, r.content, r.created_at, u.username, u.full_name, u.employee_id
    FROM reports r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 100`).all();
  res.json({ reports: rows, requestId: req.requestId });
});

app.get('/api/v1/profile', requireAuth, (req, res) => {
  const user = db.prepare(`SELECT id, username, role, account_type, account_status, employee_id, customer_id,
    full_name, email, phone, department, job_title, location, shop_name, linkedin_url, instagram_url, whatsapp_url, github_url, verified_at
    FROM users WHERE id = ?`).get(req.session.userId);
  const tickets = db.prepare(`SELECT ticket_number, title, status, priority, created_at, updated_at
    FROM tickets WHERE requester_id = ? OR assignee_id = ? ORDER BY updated_at DESC LIMIT 50`).all(req.session.userId, req.session.userId);
  const reports = db.prepare(`SELECT id, created_at FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.session.userId);
  const auditEvents = db.prepare(`SELECT action, resource, resource_id, created_at FROM audit_logs
    WHERE actor_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.session.userId);
  res.json({ user: publicUser(user), timeline: { tickets, reports, auditEvents }, requestId: req.requestId });
});

app.patch('/api/v1/profile', requireAuth, (req, res) => {
  const { fullName, email, phone, department, jobTitle, location, shopName, linkedinUrl, instagramUrl, whatsappUrl, githubUrl } = req.body || {};
  if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.length > 120 || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Full name and valid email are required', requestId: req.requestId });
  }
  const links = { linkedinUrl, instagramUrl, whatsappUrl, githubUrl };
  for (const [name, value] of Object.entries(links)) {
    if (value && (typeof value !== 'string' || value.length > 300 || !/^https:\/\//i.test(value))) return res.status(400).json({ error: `${name} must be an HTTPS link`, requestId: req.requestId });
  }
  const before = db.prepare('SELECT full_name, email, phone, department, job_title, linkedin_url, instagram_url, whatsapp_url, github_url FROM users WHERE id = ?').get(req.session.userId);
  db.prepare(`UPDATE users SET full_name = ?, email = ?, phone = ?, department = ?, job_title = ?, location = ?, shop_name = ?,
    linkedin_url = ?, instagram_url = ?, whatsapp_url = ?, github_url = ? WHERE id = ?`).run(fullName.trim(), email.trim().toLowerCase(), phone || null, department || null, jobTitle || null, location || null, shopName || null, linkedinUrl || null, instagramUrl || null, whatsappUrl || null, githubUrl || null, req.session.userId);
  audit(req, 'PROFILE_UPDATED', 'user', req.session.userId, before, links);
  res.json({ ok: true, requestId: req.requestId });
});

// ---------------------------------------------------------------------------
// Serve ONLY the public/ directory. Server code, package.json, and the
// data/ directory (databases, sessions) are never web-servable.
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// CSRF errors -> clean 403 instead of a stack trace.
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
