const rateLimit = require('express-rate-limit');
const { analyzeWorkInterval } = require('./shifts');
const { runChatRetention, driveConfigured, RETENTION_DAYS, DRIVE_SHARE_EMAIL } = require('./drive-archive');

function publicMember(user) {
  return {
    id: user.id,
    fullName: user.full_name || user.username,
    employeeId: user.employee_id || null,
    role: user.role,
    accountType: user.account_type,
    department: user.department || null,
    jobTitle: user.job_title || null,
    phone: user.phone || null,
    email: user.email || null,
  };
}

function chatIdFor(clientId, employeeId) {
  return `chat_${clientId}_${employeeId}`;
}

function registerOperations(app, ctx) {
  const {
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
  } = ctx;

  const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many chat requests. Please wait a moment.' },
  });

  async function listActiveStaff() {
    const snap = await firestore.collection('users').get();
    return snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((user) => {
        const type = user.account_type;
        const active = user.account_status === 'ACTIVE';
        return active && (type === 'EMPLOYEE' || type === 'ADMIN' || user.role === 'admin' || user.role === 'employee');
      })
      .sort((a, b) => String(a.full_name || a.username).localeCompare(String(b.full_name || b.username)));
  }

  async function assertActiveStaff(userId) {
    const user = await getDoc('users', userId);
    if (!user || user.account_status !== 'ACTIVE') return null;
    if (!['EMPLOYEE', 'ADMIN'].includes(user.account_type) && !['admin', 'employee'].includes(user.role)) return null;
    return user;
  }

  // Directory of company members for clients (and staff).
  app.get('/api/v1/company-members', requireAuth, async (req, res, next) => {
    try {
      const members = (await listActiveStaff()).map(publicMember);
      const role = typeof req.query.role === 'string' ? req.query.role.trim() : '';
      const filtered = role
        ? members.filter((member) => member.role === role || member.jobTitle === role || member.department === role)
        : members;
      res.json({
        members: filtered,
        shift: { days: 'Monday–Saturday', hours: '09:00–17:00', timezone: process.env.COMPANY_TIMEZONE || 'Asia/Colombo' },
        requestId: req.requestId,
      });
    } catch (error) {
      next(error);
    }
  });

  // Admin assignable list, optionally filtered by role / department / job title.
  app.get('/api/v1/assignable-employees', requireRole('admin'), async (req, res, next) => {
    try {
      const role = typeof req.query.role === 'string' ? req.query.role.trim() : '';
      let employees = await listActiveStaff();
      if (role) {
        employees = employees.filter((user) =>
          user.role === role || user.job_title === role || user.department === role || user.account_type === role
        );
      }
      res.json({
        employees: employees.map(publicMember),
        roles: [...new Set(employees.map((user) => user.role).filter(Boolean))],
        requestId: req.requestId,
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/v1/tickets/:id/assign', requireRole('admin'), async (req, res, next) => {
    try {
      const ticket = await ticketForUser(req, req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found', requestId: req.requestId });
      const assigneeId = req.body?.assigneeId == null || req.body?.assigneeId === ''
        ? null
        : String(req.body.assigneeId);
      let assignee = null;
      if (assigneeId) {
        assignee = await assertActiveStaff(assigneeId);
        if (!assignee) return res.status(400).json({ error: 'Assignee must be an active company employee', requestId: req.requestId });
        const requiredRole = typeof req.body?.requiredRole === 'string' ? req.body.requiredRole.trim() : '';
        if (requiredRole && assignee.role !== requiredRole && assignee.job_title !== requiredRole && assignee.department !== requiredRole) {
          return res.status(400).json({ error: `Assignee does not match required role ${requiredRole}`, requestId: req.requestId });
        }
      }

      const stamp = nowIso();
      const update = {
        assignee_id: assigneeId,
        assigned_team: assignee?.department || assignee?.job_title || null,
        updated_by: String(req.session.userId),
        updated_at: stamp,
      };
      if (assigneeId && ticket.status === 'NEW') update.status = 'ASSIGNED';
      await firestore.collection('tickets').doc(String(ticket.id)).update(update);
      if (update.status === 'ASSIGNED') {
        const historyId = await nextCounter('ticket_status_history');
        await firestore.collection('tickets').doc(String(ticket.id)).collection('history').doc(historyId).set({
          from_status: ticket.status,
          to_status: 'ASSIGNED',
          actor_id: String(req.session.userId),
          created_at: stamp,
        });
      }
      await audit(req, 'TICKET_ASSIGNED', 'ticket', ticket.id, { assignee_id: ticket.assignee_id }, { assignee_id: assigneeId, role: assignee?.role || null });
      res.json({ ticket: await ticketForUser(req, ticket.id), requestId: req.requestId });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/v1/chats', requireAuth, async (req, res, next) => {
    try {
      const uid = String(req.session.userId);
      const field = isStaff(req) ? 'employee_id' : 'client_id';
      const snap = await firestore.collection('chats').where(field, '==', uid).get();
      const chats = await Promise.all(snap.docs.map(async (doc) => {
        const chat = { id: doc.id, ...doc.data() };
        const otherId = isStaff(req) ? chat.client_id : chat.employee_id;
        const other = await getDoc('users', otherId);
        return {
          id: chat.id,
          clientId: chat.client_id,
          employeeId: chat.employee_id,
          lastMessageAt: chat.last_message_at,
          lastMessagePreview: chat.last_message_preview || null,
          updatedAt: chat.updated_at,
          peer: other ? publicMember(other) : null,
        };
      }));
      chats.sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
      res.json({ chats, retentionDays: RETENTION_DAYS, requestId: req.requestId });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/v1/chats', requireAuth, chatLimiter, async (req, res, next) => {
    try {
      const employeeId = String(req.body?.employeeId || '');
      if (!employeeId) return res.status(400).json({ error: 'employeeId is required', requestId: req.requestId });

      let clientId;
      let staffId;
      if (isStaff(req)) {
        clientId = String(req.body?.clientId || '');
        staffId = String(req.session.userId);
        if (!clientId) return res.status(400).json({ error: 'clientId is required for staff-started chats', requestId: req.requestId });
        const client = await getDoc('users', clientId);
        if (!client || client.account_type !== 'CLIENT') return res.status(400).json({ error: 'Valid client required', requestId: req.requestId });
      } else {
        clientId = String(req.session.userId);
        staffId = employeeId;
        const employee = await assertActiveStaff(staffId);
        if (!employee) return res.status(400).json({ error: 'Select an active company member', requestId: req.requestId });
      }

      if (isStaff(req) && staffId !== String(req.session.userId) && req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden', requestId: req.requestId });
      }

      const id = chatIdFor(clientId, staffId);
      const existing = await getDoc('chats', id);
      if (existing) return res.json({ chat: existing, requestId: req.requestId });

      const stamp = nowIso();
      const chat = {
        client_id: clientId,
        employee_id: staffId,
        participant_ids: [clientId, staffId],
        created_at: stamp,
        updated_at: stamp,
        last_message_at: stamp,
        last_message_preview: null,
        created_by: String(req.session.userId),
      };
      await firestore.collection('chats').doc(id).set(chat);
      await audit(req, 'CHAT_STARTED', 'chat', id, null, { clientId, employeeId: staffId });
      res.status(201).json({ chat: { id, ...chat }, requestId: req.requestId });
    } catch (error) {
      next(error);
    }
  });

  async function requireChatParticipant(req, chatId) {
    const chat = await getDoc('chats', chatId);
    if (!chat) return { error: { status: 404, body: { error: 'Chat not found', requestId: req.requestId } } };
    const uid = String(req.session.userId);
    const allowed = uid === String(chat.client_id) || uid === String(chat.employee_id) || req.session.role === 'admin';
    if (!allowed) return { error: { status: 403, body: { error: 'Forbidden', requestId: req.requestId } } };
    return { chat };
  }

  app.get('/api/v1/chats/:id/messages', requireAuth, async (req, res, next) => {
    try {
      const result = await requireChatParticipant(req, req.params.id);
      if (result.error) return res.status(result.error.status).json(result.error.body);
      const snap = await firestore.collection('chats').doc(String(result.chat.id)).collection('messages').orderBy('created_at').limit(500).get();
      const messages = snap.docs.map((doc) => {
        const item = doc.data();
        return {
          id: doc.id,
          senderId: item.sender_id,
          body: item.body,
          createdAt: item.created_at,
        };
      });
      res.json({ chat: result.chat, messages, requestId: req.requestId });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/v1/chats/:id/messages', requireAuth, chatLimiter, async (req, res, next) => {
    try {
      const result = await requireChatParticipant(req, req.params.id);
      if (result.error) return res.status(result.error.status).json(result.error.body);
      const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
      if (!body || body.length > 4000) return res.status(400).json({ error: 'Message must be 1–4000 characters', requestId: req.requestId });

      const stamp = nowIso();
      const id = await nextCounter('chat_messages');
      await firestore.collection('chats').doc(String(result.chat.id)).collection('messages').doc(id).set({
        sender_id: String(req.session.userId),
        body,
        created_at: stamp,
      });
      await firestore.collection('chats').doc(String(result.chat.id)).update({
        updated_at: stamp,
        last_message_at: stamp,
        last_message_preview: body.slice(0, 160),
      });
      await audit(req, 'CHAT_MESSAGE_SENT', 'chat', result.chat.id, null, { messageId: id });
      res.status(201).json({ id, createdAt: stamp, requestId: req.requestId });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/v1/admin/chat-retention/run', requireRole('admin'), async (req, res, next) => {
    try {
      const result = await runChatRetention(firestore);
      await audit(req, 'CHAT_RETENTION_RUN', 'chat_archives', null, null, result);
      res.json({ ...result, shareEmail: DRIVE_SHARE_EMAIL, driveConfigured: driveConfigured(), requestId: req.requestId });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/v1/shift-policy', requireAuth, (req, res) => {
    res.json({
      days: 'Monday–Saturday',
      hours: '09:00–17:00',
      timezone: process.env.COMPANY_TIMEZONE || 'Asia/Colombo',
      overtimeRule: 'Work logged outside Mon–Sat 09:00–17:00 is recorded as overtime on the ticket work log.',
      chatRetentionDays: RETENTION_DAYS,
      requestId: req.requestId,
    });
  });
}

function startChatRetentionScheduler(firestore) {
  const run = () => {
    runChatRetention(firestore).catch((error) => console.error('Chat retention job failed:', error.message));
  };
  // First pass shortly after boot, then hourly.
  setTimeout(run, 15 * 1000);
  setInterval(run, 60 * 60 * 1000);
}

module.exports = {
  registerOperations,
  startChatRetentionScheduler,
  analyzeWorkInterval,
  publicMember,
  assertActiveStaffHelper: null,
};
