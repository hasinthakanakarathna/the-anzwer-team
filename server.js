require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const csurf = require('csurf');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const crypto = require('crypto');
const { firestore, nextCounter, getDoc, queryOne } = require('./firestore');
const FirestoreSessionStore = require('./firestore-session-store');
const { analyzeWorkInterval } = require('./shifts');
const { registerOperations, startChatRetentionScheduler } = require('./operations');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

app.use((req, res, next) => {
  const supplied = req.get('X-Request-ID');
  req.requestId = supplied && /^[A-Za-z0-9_.-]{1,80}$/.test(supplied) ? supplied : `req_${crypto.randomUUID()}`;
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable must be set in production.');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

if (IS_PROD) app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.tailwindcss.com', 'https://cdnjs.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
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
    store: new FirestoreSessionStore(session, { firestore, collection: 'sessions' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

const csrfProtection = csurf({ cookie: false });
app.use(csrfProtection);

app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

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

function nowIso() {
  return new Date().toISOString();
}

function identityId(prefix) {
  return `${prefix}-${new Date().getUTCFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function createTeamReference() {
  let code;
  do {
    code = `ANZ-TEAM-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  } while (await queryOne('team_invitations', 'reference_code', code));
  return code;
}

function extractBirthYear(nic) {
  if (typeof nic !== 'string') return null;
  const normalized = nic.replace(/\s|-/g, '');
  const year = Number(normalized.slice(0, 4));
  return /^\d{4}[A-Za-z0-9]{4,}$/.test(normalized) && year >= 1900 && year <= new Date().getUTCFullYear() ? year : null;
}

async function createRecognizedIdentity(accountType, birthYear) {
  const prefix = accountType === 'EMPLOYEE' ? 'EMP' : 'CLI';
  const seqRef = firestore.collection('identity_sequences').doc(`${birthYear}_${accountType}`);
  return firestore.runTransaction(async (tx) => {
    const seqSnap = await tx.get(seqRef);
    const sequence = seqSnap.exists ? Number(seqSnap.data().next_value || 1) : 1;
    tx.set(seqRef, { birth_year: birthYear, account_type: accountType, next_value: sequence + 1 }, { merge: true });
    return `${prefix}${birthYear}${String(sequence).padStart(4, '0')}`;
  });
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

async function seedAdminIfNeeded() {
  const admins = await firestore.collection('users').where('role', '==', 'admin').limit(1).get();
  if (!admins.empty) return;
  const pw = crypto.randomBytes(9).toString('base64url');
  const hash = await bcrypt.hash(pw, 12);
  const id = await nextCounter('users');
  await firestore.collection('users').doc(id).set({
    username: 'admin',
    password_hash: hash,
    role: 'admin',
    account_type: 'ADMIN',
    account_status: 'ACTIVE',
    full_name: 'System Administrator',
    employee_id: null,
    customer_id: null,
    email: null,
    phone: null,
    department: null,
    job_title: null,
    location: null,
    shop_name: null,
    linkedin_url: null,
    instagram_url: null,
    whatsapp_url: null,
    github_url: null,
    verified_at: nowIso(),
    approved_by: null,
    force_password_reset: 0,
    created_at: nowIso(),
  });
  console.log('Seeded admin user -> username: admin password:', pw);
  console.log('Please log in and change this password immediately.');
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function isValidUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username);
}

function isValidPassword(password) {
  return (
    typeof password === 'string' &&
    password.length >= 8 &&
    password.length <= 200 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password)
  );
}

async function requireAuth(req, res, next) {
  try {
    if (req.session?.userId) {
      const user = await getDoc('users', req.session.userId);
      if (user && user.account_status !== 'DISABLED') return next();
    }
    return res.status(401).json({ error: 'Unauthorized' });
  } catch (error) {
    return next(error);
  }
}

function requireRole(role) {
  return async function (req, res, next) {
    try {
      if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
      const user = await getDoc('users', req.session.userId);
      if (!user || user.account_status === 'DISABLED') return res.status(401).json({ error: 'Unauthorized' });
      if (user.role !== role && user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
      return next();
    } catch (error) {
      return next(error);
    }
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

async function requireStaff(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized', requestId: req.requestId });
  if (!isStaff(req)) return res.status(403).json({ error: 'Staff permission required', requestId: req.requestId });
  return next();
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

async function audit(req, action, resource, resourceId, oldValue, newValue, result = 'SUCCESS') {
  const actorId = req.session?.userId || null;
  let actorExists = false;
  if (actorId) {
    const actor = await getDoc('users', actorId);
    actorExists = Boolean(actor);
  }
  const id = await nextCounter('audit_logs');
  await firestore.collection('audit_logs').doc(id).set({
    actor_id: actorExists ? String(actorId) : null,
    action,
    resource,
    resource_id: resourceId ? String(resourceId) : null,
    ip_address: req.ip || null,
    user_agent: req.get('user-agent') || null,
    result,
    old_value: oldValue ? JSON.stringify(oldValue) : null,
    new_value: newValue ? JSON.stringify(newValue) : null,
    request_id: req.requestId,
    created_at: nowIso(),
  });
}

async function usernameFor(userId) {
  if (!userId) return null;
  const user = await getDoc('users', userId);
  return user?.username || null;
}

async function ticketForUser(req, ticketId) {
  const ticket = await getDoc('tickets', ticketId);
  if (!ticket) return null;
  if (!isStaff(req) && String(ticket.requester_id) !== String(req.session.userId)) return null;
  return {
    ...ticket,
    requester: await usernameFor(ticket.requester_id),
    assignee: await usernameFor(ticket.assignee_id),
  };
}

async function assertActiveStaff(userId) {
  const user = await getDoc('users', userId);
  if (!user || user.account_status !== 'ACTIVE') return null;
  if (!['EMPLOYEE', 'ADMIN'].includes(user.account_type) && !['admin', 'employee'].includes(user.role)) return null;
  return user;
}

async function nextTicketNumber(type) {
  const year = new Date().getUTCFullYear();
  const seqRef = firestore.collection('ticket_sequences').doc(`${year}_${type}`);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(seqRef);
    const sequence = snap.exists ? Number(snap.data().next_value || 1) : 1;
    tx.set(seqRef, { year, type, next_value: sequence + 1 }, { merge: true });
    return `${ticketPrefix(type)}-${year}-${String(sequence).padStart(6, '0')}`;
  });
}

app.get('/api/v1/dashboard', requireAuth, async (req, res, next) => {
  try {
    let ticketsSnap;
    if (isStaff(req)) {
      ticketsSnap = await firestore.collection('tickets').get();
    } else {
      ticketsSnap = await firestore.collection('tickets').where('requester_id', '==', String(req.session.userId)).get();
    }
    const tickets = ticketsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const counts = {
      total: tickets.length,
      open: tickets.filter((t) => ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', 'REOPENED'].includes(t.status)).length,
      in_progress: tickets.filter((t) => t.status === 'IN_PROGRESS').length,
      pending: tickets.filter((t) => t.status === 'PENDING').length,
      resolved: tickets.filter((t) => t.status === 'RESOLVED').length,
      critical: tickets.filter((t) => t.priority === 'P1' && !['CLOSED', 'RESOLVED'].includes(t.status)).length,
    };
    const recent = tickets
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, 8)
      .map(({ ticket_number, type, title, status, priority, updated_at }) => ({
        ticket_number, type, title, status, priority, updated_at,
      }));
    res.json({ counts, recent, role: req.session.role, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/tickets', requireAuth, async (req, res, next) => {
  try {
    let query = firestore.collection('tickets');
    if (!isStaff(req)) query = query.where('requester_id', '==', String(req.session.userId));
    const snap = await query.get();
    let rows = await Promise.all(snap.docs.map(async (doc) => {
      const ticket = { id: doc.id, ...doc.data() };
      return {
        id: ticket.id,
        ticket_number: ticket.ticket_number,
        type: ticket.type,
        title: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
        created_at: ticket.created_at,
        updated_at: ticket.updated_at,
        requester: await usernameFor(ticket.requester_id),
        assignee: await usernameFor(ticket.assignee_id),
      };
    }));
    if (typeof req.query.status === 'string' && TICKET_STATUSES.has(req.query.status)) {
      rows = rows.filter((ticket) => ticket.status === req.query.status);
    }
    if (typeof req.query.priority === 'string' && /^P[1-4]$/.test(req.query.priority)) {
      rows = rows.filter((ticket) => ticket.priority === req.query.priority);
    }
    rows = rows
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, 100);
    res.json({ tickets: rows, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/tickets', requireAuth, async (req, res, next) => {
  try {
    const { type, title, description = '', impact = 2, urgency = 2, category = null, assigneeId = null } = req.body || {};
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

    let assignee = null;
    let normalizedAssigneeId = null;
    if (assigneeId != null && assigneeId !== '') {
      assignee = await assertActiveStaff(String(assigneeId));
      if (!assignee) return res.status(400).json({ error: 'Selected assignee must be an active company member', requestId: req.requestId });
      normalizedAssigneeId = String(assignee.id);
    }

    const priority = priorityFor(normalizedImpact, normalizedUrgency);
    const ticketNumber = await nextTicketNumber(type);
    const id = await nextCounter('tickets');
    const stamp = nowIso();
    const initialStatus = normalizedAssigneeId ? 'ASSIGNED' : 'NEW';
    await firestore.collection('tickets').doc(id).set({
      ticket_number: ticketNumber,
      type,
      title: title.trim(),
      description: String(description).slice(0, 20000),
      status: initialStatus,
      priority,
      impact: normalizedImpact,
      urgency: normalizedUrgency,
      requester_id: String(req.session.userId),
      assignee_id: normalizedAssigneeId,
      assigned_team: assignee?.department || assignee?.job_title || null,
      category,
      due_at: null,
      resolution: null,
      created_by: String(req.session.userId),
      updated_by: String(req.session.userId),
      created_at: stamp,
      updated_at: stamp,
      resolved_at: null,
      closed_at: null,
    });
    const historyId = await nextCounter('ticket_status_history');
    await firestore.collection('tickets').doc(id).collection('history').doc(historyId).set({
      from_status: null,
      to_status: initialStatus,
      actor_id: String(req.session.userId),
      created_at: stamp,
    });
    await audit(req, 'TICKET_CREATED', 'ticket', id, null, { ticketNumber, type, priority, assigneeId: normalizedAssigneeId });
    res.status(201).json({ ticket: await ticketForUser(req, id), requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/tickets/:id', requireAuth, async (req, res, next) => {
  try {
    const ticket = await ticketForUser(req, req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found', requestId: req.requestId });

    const [commentsSnap, historySnap, workLogsSnap] = await Promise.all([
      firestore.collection('tickets').doc(String(ticket.id)).collection('comments').orderBy('created_at').get(),
      firestore.collection('tickets').doc(String(ticket.id)).collection('history').orderBy('created_at').get(),
      firestore.collection('tickets').doc(String(ticket.id)).collection('workLogs').orderBy('started_at').get(),
    ]);

    const comments = [];
    for (const doc of commentsSnap.docs) {
      const comment = { id: doc.id, ...doc.data() };
      if (!isStaff(req) && comment.visibility !== 'PUBLIC') continue;
      comments.push({
        id: comment.id,
        body: comment.body,
        visibility: comment.visibility,
        created_at: comment.created_at,
        author: await usernameFor(comment.author_id),
      });
    }

    const history = await Promise.all(historySnap.docs.map(async (doc) => {
      const item = doc.data();
      return {
        from_status: item.from_status,
        to_status: item.to_status,
        created_at: item.created_at,
        actor: await usernameFor(item.actor_id),
      };
    }));

    const workLogs = await Promise.all(workLogsSnap.docs.map(async (doc) => {
      const item = doc.data();
      return {
        started_at: item.started_at,
        ended_at: item.ended_at,
        activity: item.activity,
        created_at: item.created_at,
        author: await usernameFor(item.author_id),
        regular_minutes: item.regular_minutes || 0,
        overtime_minutes: item.overtime_minutes || 0,
        total_minutes: item.total_minutes || 0,
        is_overtime: Boolean(item.is_overtime),
        shift_window: item.shift_window || 'Mon–Sat 09:00–17:00',
      };
    }));

    res.json({ ticket, comments, history, workLogs, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/v1/tickets/:id', requireAuth, async (req, res, next) => {
  try {
    const ticket = await ticketForUser(req, req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found', requestId: req.requestId });
    const nextStatus = req.body?.status;
    if (!TICKET_STATUSES.has(nextStatus) || !STATUS_TRANSITIONS[ticket.status].includes(nextStatus)) {
      return res.status(409).json({ error: `Invalid transition from ${ticket.status}`, requestId: req.requestId });
    }
    if (!isStaff(req) && nextStatus !== 'CLOSED' && nextStatus !== 'PENDING') {
      return res.status(403).json({ error: 'Staff permission required', requestId: req.requestId });
    }

    const stamp = nowIso();
    const update = {
      status: nextStatus,
      updated_by: String(req.session.userId),
      updated_at: stamp,
    };
    if (nextStatus === 'RESOLVED') update.resolved_at = stamp;
    if (nextStatus === 'CLOSED') update.closed_at = stamp;
    await firestore.collection('tickets').doc(String(ticket.id)).update(update);

    const historyId = await nextCounter('ticket_status_history');
    await firestore.collection('tickets').doc(String(ticket.id)).collection('history').doc(historyId).set({
      from_status: ticket.status,
      to_status: nextStatus,
      actor_id: String(req.session.userId),
      created_at: stamp,
    });

    await audit(req, 'TICKET_STATUS_CHANGED', 'ticket', ticket.id, { status: ticket.status }, { status: nextStatus });
    res.json({ ticket: await ticketForUser(req, ticket.id), requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/tickets/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const ticket = await ticketForUser(req, req.params.id);
    const { body, visibility = 'PUBLIC' } = req.body || {};
    if (!ticket) return res.status(404).json({ error: 'Ticket not found', requestId: req.requestId });
    if (typeof body !== 'string' || body.trim().length < 1 || body.length > 10000) {
      return res.status(400).json({ error: 'Comment is required', requestId: req.requestId });
    }
    if (!['PUBLIC', 'INTERNAL'].includes(visibility) || (visibility === 'INTERNAL' && !isStaff(req))) {
      return res.status(403).json({ error: 'Internal notes require staff access', requestId: req.requestId });
    }
    const id = await nextCounter('ticket_comments');
    await firestore.collection('tickets').doc(String(ticket.id)).collection('comments').doc(id).set({
      author_id: String(req.session.userId),
      body: body.trim(),
      visibility,
      created_at: nowIso(),
    });
    await audit(req, visibility === 'INTERNAL' ? 'TICKET_INTERNAL_NOTE_ADDED' : 'TICKET_COMMENT_ADDED', 'ticket', ticket.id, null, { commentId: id });
    res.status(201).json({ id, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/tickets/:id/worklogs', requireStaff, async (req, res, next) => {
  try {
    const ticket = await ticketForUser(req, req.params.id);
    const { startedAt, endedAt, activity } = req.body || {};
    const start = Date.parse(startedAt);
    const end = Date.parse(endedAt);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found', requestId: req.requestId });
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || typeof activity !== 'string' || !activity.trim()) {
      return res.status(400).json({ error: 'Valid times and activity are required', requestId: req.requestId });
    }
    const startedIso = new Date(start).toISOString();
    const endedIso = new Date(end).toISOString();
    const shift = analyzeWorkInterval(startedIso, endedIso);
    const id = await nextCounter('ticket_work_logs');
    await firestore.collection('tickets').doc(String(ticket.id)).collection('workLogs').doc(id).set({
      author_id: String(req.session.userId),
      started_at: startedIso,
      ended_at: endedIso,
      activity: activity.trim().slice(0, 4000),
      created_at: nowIso(),
      regular_minutes: shift.regular_minutes,
      overtime_minutes: shift.overtime_minutes,
      total_minutes: shift.total_minutes,
      is_overtime: shift.is_overtime,
      shift_timezone: shift.shift_timezone,
      shift_window: shift.shift_window,
    });
    await audit(req, 'TICKET_WORKLOG_ADDED', 'ticket', ticket.id, null, {
      workLogId: id,
      regular_minutes: shift.regular_minutes,
      overtime_minutes: shift.overtime_minutes,
    });
    res.status(201).json({ id, shift, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/audit-logs', requireRole('admin'), async (req, res, next) => {
  try {
    const snap = await firestore.collection('audit_logs').get();
    const auditLogs = (await Promise.all(snap.docs.map(async (doc) => {
      const row = { id: doc.id, ...doc.data() };
      return {
        id: row.id,
        action: row.action,
        resource: row.resource,
        resource_id: row.resource_id,
        result: row.result,
        request_id: row.request_id,
        created_at: row.created_at,
        actor: await usernameFor(row.actor_id),
      };
    })))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 200);
    res.json({ auditLogs, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

app.post('/api/login', authLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const user = await queryOne('users', 'username', username);
    // Dummy hash keeps compare timing similar when the username is unknown.
    const hashToCheck = user ? user.password_hash : '$2b$12$C6UzMDM.H6dfI/f/IKcEe.OwqQxqQxqQxqQxqQxqQxqQxqQxqQxqQ';
    let ok = false;
    try {
      ok = await bcrypt.compare(password, hashToCheck);
    } catch {
      ok = false;
    }

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
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.json({ ok: true });
  });
});

app.get('/api/whoami', async (req, res, next) => {
  try {
    if (!req.session?.userId) return res.json({ user: null });
    const user = await getDoc('users', req.session.userId);
    if (!user || user.account_status === 'DISABLED') return res.json({ user: null });
    return res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/users', requireRole('admin'), async (req, res, next) => {
  try {
    const snap = await firestore.collection('users').get();
    const rows = snap.docs
      .map((doc) => {
        const user = { id: doc.id, ...doc.data() };
        return {
          id: user.id,
          username: user.username,
          role: user.role,
          account_type: user.account_type,
          account_status: user.account_status,
          employee_id: user.employee_id,
          customer_id: user.customer_id,
          full_name: user.full_name,
          email: user.email,
          phone: user.phone,
          department: user.department,
          job_title: user.job_title,
          verified_at: user.verified_at,
        };
      })
      .sort((a, b) => String(b.id).localeCompare(String(a.id), undefined, { numeric: true }));
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.get('/api/users/invitations', requireRole('admin'), async (req, res, next) => {
  try {
    const snap = await firestore.collection('team_invitations').get();
    const invitations = snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 100)
      .map((invite) => ({
        id: invite.id,
        reference_code: invite.reference_code,
        invited_name: invite.invited_name,
        invited_email: invite.invited_email,
        admin_access: invite.admin_access,
        status: invite.status,
        created_at: invite.created_at,
        used_at: invite.used_at,
      }));
    res.json(invitations);
  } catch (error) {
    next(error);
  }
});

app.post('/api/users/invitations', requireRole('admin'), async (req, res, next) => {
  try {
    const { invitedName = '', invitedEmail = '', adminAccess = false } = req.body || {};
    if (typeof invitedName !== 'string' || invitedName.length > 120 || typeof invitedEmail !== 'string' || invitedEmail.length > 160) {
      return res.status(400).json({ error: 'Invalid team member details' });
    }
    if (invitedEmail && !/^\S+@\S+\.\S+$/.test(invitedEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
    const referenceCode = await createTeamReference();
    const id = await nextCounter('team_invitations');
    await firestore.collection('team_invitations').doc(id).set({
      reference_code: referenceCode,
      invited_name: invitedName.trim() || null,
      invited_email: invitedEmail.trim().toLowerCase() || null,
      admin_access: adminAccess ? 1 : 0,
      status: 'AVAILABLE',
      created_by: String(req.session.userId),
      used_by: null,
      created_at: nowIso(),
      used_at: null,
    });
    await audit(req, 'TEAM_INVITATION_CREATED', 'team_invitation', referenceCode, null, { adminAccess: Boolean(adminAccess) });
    res.status(201).json({ ok: true, referenceCode, adminAccess: Boolean(adminAccess) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/users/:id/verification', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = String(req.params.id);
    const { status } = req.body || {};
    if (!['ACTIVE', 'DISABLED'].includes(status)) return res.status(400).json({ error: 'Invalid verification update' });
    const target = await getDoc('users', userId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const update = { account_status: status };
    if (status === 'ACTIVE') {
      update.verified_at = nowIso();
      update.approved_by = String(req.session.userId);
      if (target.pending_admin_access) {
        update.role = 'admin';
        update.account_type = 'ADMIN';
        update.pending_admin_access = 0;
      }
    }
    await firestore.collection('users').doc(userId).update(update);
    await audit(req, status === 'ACTIVE' ? 'EMPLOYEE_VERIFIED' : 'ACCOUNT_DISABLED', 'user', userId, { status: target.account_status }, {
      status,
      role: update.role || target.role,
      account_type: update.account_type || target.account_type,
    });
    res.json({ ok: true, status, role: update.role || target.role, accountType: update.account_type || target.account_type });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/users/:id/admin-access', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = String(req.params.id);
    const target = await getDoc('users', userId);
    if (!target || target.account_type !== 'EMPLOYEE' || target.account_status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Only verified employees can receive admin access' });
    }
    await firestore.collection('users').doc(userId).update({ role: 'admin', account_type: 'ADMIN' });
    await audit(req, 'ADMIN_ACCESS_GRANTED', 'user', userId, { role: target.role }, { role: 'admin' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/users', requireRole('admin'), async (req, res, next) => {
  try {
    const { username, password, role } = req.body || {};
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Username must be 3-32 chars: letters, numbers, _ . -' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: 'Password must be 8+ chars with a letter and a number' });
    }
    const existing = await queryOne('users', 'username', username);
    if (existing) return res.status(400).json({ error: 'User exists or invalid' });

    const safeRole = role === 'admin' ? 'admin' : 'employee';
    const hash = await bcrypt.hash(password, 12);
    const id = await nextCounter('users');
    await firestore.collection('users').doc(id).set({
      username,
      password_hash: hash,
      role: safeRole,
      account_type: safeRole === 'admin' ? 'ADMIN' : 'EMPLOYEE',
      account_status: 'ACTIVE',
      employee_id: safeRole === 'admin' ? null : identityId('EMP'),
      customer_id: null,
      full_name: username,
      email: null,
      phone: null,
      department: null,
      job_title: null,
      location: null,
      shop_name: null,
      linkedin_url: null,
      instagram_url: null,
      whatsapp_url: null,
      github_url: null,
      verified_at: nowIso(),
      approved_by: String(req.session.userId),
      force_password_reset: 0,
      created_at: nowIso(),
    });
    await audit(req, 'ACCOUNT_CREATED_BY_ADMIN', 'user', id, null, { role: safeRole });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/users/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (id === String(req.session.userId)) {
      return res.status(400).json({ error: 'Cannot delete your own account while logged in' });
    }
    await firestore.collection('users').doc(id).delete();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/register/identity-preview', identityPreviewLimiter, async (req, res, next) => {
  try {
    const { accountType = 'CLIENT', nicNumber } = req.body || {};
    const birthYear = extractBirthYear(nicNumber);
    if (!['CLIENT', 'EMPLOYEE'].includes(accountType) || !birthYear) {
      return res.status(400).json({ error: 'Enter a NIC beginning with a valid four-digit birth year' });
    }
    const id = await createRecognizedIdentity(accountType, birthYear);
    req.session.registrationIdentity = { id, accountType, birthYear };
    res.json({ id });
  } catch (error) {
    next(error);
  }
});

app.post('/api/register', authLimiter, async (req, res, next) => {
  try {
    const {
      password, accountType = 'CLIENT', fullName, email, phone, department, jobTitle,
      location, shopName, nicNumber, referenceCode,
    } = req.body || {};
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
      invitation = await queryOne('team_invitations', 'reference_code', referenceCode.trim().toUpperCase());
      if (!invitation || invitation.status !== 'AVAILABLE') {
        return res.status(403).json({ error: 'That team reference code is invalid or has already been used' });
      }
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
    const isEmployee = accountType === 'EMPLOYEE';
    const reserved = req.session.registrationIdentity;
    const username = reserved && reserved.accountType === accountType && reserved.birthYear === birthYear
      ? reserved.id
      : await createRecognizedIdentity(accountType, birthYear);
    const employeeId = isEmployee ? username : null;
    const customerId = isEmployee ? null : username;
    // Employees stay PENDING until a system admin verifies them.
    // Admin-access invites are applied only after verification.
    const pendingAdminAccess = Boolean(isEmployee && invitation?.admin_access);
    const role = isEmployee ? 'employee' : 'client';
    const registeredAccountType = isEmployee ? 'EMPLOYEE' : 'CLIENT';
    const accountStatus = isEmployee ? 'PENDING' : 'ACTIVE';
    const id = await nextCounter('users');

    try {
      await firestore.collection('users').doc(id).set({
        username,
        password_hash: hash,
        role,
        account_type: registeredAccountType,
        account_status: accountStatus,
        pending_admin_access: pendingAdminAccess ? 1 : 0,
        employee_id: employeeId,
        customer_id: customerId,
        full_name: fullName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone || null,
        department: isEmployee ? department || null : null,
        job_title: isEmployee ? jobTitle || null : null,
        location: location || null,
        shop_name: shopName || null,
        linkedin_url: null,
        instagram_url: null,
        whatsapp_url: null,
        github_url: null,
        verified_at: isEmployee ? null : nowIso(),
        approved_by: null,
        force_password_reset: 0,
        created_at: nowIso(),
      });
    } catch (error) {
      if (String(error.message || '').includes('already exists')) {
        return res.status(409).json({ error: 'That generated identity is already in use. Please submit again.' });
      }
      throw error;
    }

    const usernameClash = await firestore.collection('users').where('username', '==', username).get();
    if (usernameClash.size > 1) {
      await firestore.collection('users').doc(id).delete();
      return res.status(409).json({ error: 'That generated identity is already in use. Please submit again.' });
    }

    if (invitation) {
      await firestore.collection('team_invitations').doc(String(invitation.id)).update({
        status: 'USED',
        used_by: id,
        used_at: nowIso(),
      });
    }
    delete req.session.registrationIdentity;
    await audit(req, 'ACCOUNT_REGISTERED', 'user', id, null, {
      accountType: registeredAccountType,
      employeeId,
      customerId,
      status: accountStatus,
      pendingAdminAccess,
    });
    return res.status(201).json({
      ok: true,
      username,
      accountType: registeredAccountType,
      employeeId,
      customerId,
      status: accountStatus,
      requiresVerification: isEmployee,
    });
  } catch (error) {
    console.error('Registration failed:', error.code || error.message || 'unknown error');
    return res.status(500).json({ error: 'We could not create the account. Please try again.', requestId: req.requestId });
  }
});

app.post('/api/users/change-password', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be 8+ chars with a letter and a number' });
    }
    const userRow = await getDoc('users', req.session.userId);
    if (!userRow) return res.status(401).json({ error: 'Unauthorized' });
    const ok = await bcrypt.compare(currentPassword, userRow.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid current password' });
    const newHash = await bcrypt.hash(newPassword, 12);
    await firestore.collection('users').doc(String(req.session.userId)).update({ password_hash: newHash });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reports', requireAuth, async (req, res, next) => {
  try {
    const snap = isStaff(req)
      ? await firestore.collection('reports').get()
      : await firestore.collection('reports').where('user_id', '==', String(req.session.userId)).get();
    let rows = await Promise.all(snap.docs.map(async (doc) => {
      const report = { id: doc.id, ...doc.data() };
      if (!isStaff(req)) {
        return { id: report.id, user_id: report.user_id, content: report.content, created_at: report.created_at };
      }
      const user = await getDoc('users', report.user_id);
      return {
        id: report.id,
        user_id: report.user_id,
        content: report.content,
        created_at: report.created_at,
        username: user?.username,
        full_name: user?.full_name,
        employee_id: user?.employee_id,
      };
    }));
    rows = rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    res.json(rows);
  } catch (error) {
    next(error);
  }
});

app.post('/api/reports', requireAuth, async (req, res, next) => {
  try {
    const { content } = req.body || {};
    if (!content || typeof content !== 'string' || content.length > 20000) {
      return res.status(400).json({ error: 'Missing or invalid content' });
    }
    const id = await nextCounter('reports');
    await firestore.collection('reports').doc(id).set({
      user_id: String(req.session.userId),
      content,
      created_at: nowIso(),
    });
    await audit(req, 'DAILY_REPORT_SUBMITTED', 'report', id, null, { length: content.length });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/reports/management', requireStaff, async (req, res, next) => {
  try {
    const snap = await firestore.collection('reports').get();
    const reports = (await Promise.all(snap.docs.map(async (doc) => {
      const report = { id: doc.id, ...doc.data() };
      const user = await getDoc('users', report.user_id);
      return {
        id: report.id,
        content: report.content,
        created_at: report.created_at,
        username: user?.username,
        full_name: user?.full_name,
        employee_id: user?.employee_id,
      };
    })))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 100);
    res.json({ reports, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/profile', requireAuth, async (req, res, next) => {
  try {
    const user = await getDoc('users', req.session.userId);
    const ticketsSnap = await firestore.collection('tickets').get();
    const tickets = ticketsSnap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((ticket) => String(ticket.requester_id) === String(req.session.userId) || String(ticket.assignee_id) === String(req.session.userId))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, 50)
      .map(({ ticket_number, title, status, priority, created_at, updated_at }) => ({
        ticket_number, title, status, priority, created_at, updated_at,
      }));
    const reportsSnap = await firestore.collection('reports').where('user_id', '==', String(req.session.userId)).get();
    const reports = reportsSnap.docs
      .map((doc) => ({ id: doc.id, created_at: doc.data().created_at }))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 20);
    const auditSnap = await firestore.collection('audit_logs').where('actor_id', '==', String(req.session.userId)).get();
    const auditEvents = auditSnap.docs
      .map((doc) => {
        const item = doc.data();
        return { action: item.action, resource: item.resource, resource_id: item.resource_id, created_at: item.created_at };
      })
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 20);
    res.json({ user: publicUser(user), timeline: { tickets, reports, auditEvents }, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/v1/profile', requireAuth, async (req, res, next) => {
  try {
    const { fullName, email, phone, department, jobTitle, location, shopName, linkedinUrl, instagramUrl, whatsappUrl, githubUrl } = req.body || {};
    if (typeof fullName !== 'string' || fullName.trim().length < 2 || fullName.length > 120 || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Full name and valid email are required', requestId: req.requestId });
    }
    const links = { linkedinUrl, instagramUrl, whatsappUrl, githubUrl };
    for (const [name, value] of Object.entries(links)) {
      if (value && (typeof value !== 'string' || value.length > 300 || !/^https:\/\//i.test(value))) {
        return res.status(400).json({ error: `${name} must be an HTTPS link`, requestId: req.requestId });
      }
    }
    const before = await getDoc('users', req.session.userId);
    await firestore.collection('users').doc(String(req.session.userId)).update({
      full_name: fullName.trim(),
      email: email.trim().toLowerCase(),
      phone: phone || null,
      department: department || null,
      job_title: jobTitle || null,
      location: location || null,
      shop_name: shopName || null,
      linkedin_url: linkedinUrl || null,
      instagram_url: instagramUrl || null,
      whatsapp_url: whatsappUrl || null,
      github_url: githubUrl || null,
    });
    await audit(req, 'PROFILE_UPDATED', 'user', req.session.userId, {
      full_name: before.full_name,
      email: before.email,
      phone: before.phone,
      department: before.department,
      job_title: before.job_title,
      linkedin_url: before.linkedin_url,
      instagram_url: before.instagram_url,
      whatsapp_url: before.whatsapp_url,
      github_url: before.github_url,
    }, links);
    res.json({ ok: true, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

registerOperations(app, {
  firestore,
  nextCounter,
  getDoc,
  requireAuth,
  requireStaff,
  requireRole,
  isStaff,
  audit,
  nowIso,
  ticketForUser,
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  console.error(`[${req.requestId || 'no-req'}]`, err);
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
});

seedAdminIfNeeded()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT} (Firestore)`);
      startChatRetentionScheduler(firestore);
    });
  })
  .catch((error) => {
    console.error('FATAL: could not initialize Firestore seed:', error);
    process.exit(1);
  });
