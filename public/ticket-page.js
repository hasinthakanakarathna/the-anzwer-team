const STATUS_TRANSITIONS = {
  NEW: ['ASSIGNED', 'IN_PROGRESS'],
  ASSIGNED: ['IN_PROGRESS', 'PENDING'],
  IN_PROGRESS: ['PENDING', 'RESOLVED'],
  PENDING: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['CLOSED', 'REOPENED'],
  REOPENED: ['IN_PROGRESS'],
  CLOSED: [],
};

const STAFF_ROLES = new Set([
  'admin', 'employee', 'SUPER_ADMIN', 'SYSTEM_ADMIN', 'IT_MANAGER',
  'TEAM_LEAD', 'IT_SUPPORT', 'IT_ENGINEER', 'SECURITY_ANALYST',
]);

const state = {
  ticketId: new URLSearchParams(window.location.search).get('id'),
  user: null,
  ticket: null,
};

function text(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function labelStatus(status) {
  return String(status || '').replaceAll('_', ' ');
}

function formatWhen(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function isStaff() {
  return STAFF_ROLES.has(state.user?.role);
}

function isAdmin() {
  return state.user?.role === 'admin' || state.user?.accountType === 'ADMIN';
}

function showMessage(id, message, ok = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.className = `form-message ${ok ? 'success' : 'error'}`;
}

function allowedTransitions(status) {
  const next = STATUS_TRANSITIONS[status] || [];
  if (isStaff()) return next;
  return next.filter((item) => item === 'CLOSED' || item === 'PENDING');
}

function configureClientShell() {
  if (!state.user || state.user.accountType !== 'CLIENT') return;
  document.getElementById('backLink').href = 'client.html';
  document.getElementById('backLink').textContent = '← Back to my requests';
  const nav = document.getElementById('ticketNav');
  nav.innerHTML = `
    <a href="client.html">My service</a>
    <a class="active" href="client.html#requests">My requests</a>
    <a href="profile.html">My profile</a>
  `;
  document.querySelector('.brand small').textContent = 'Client portal';
  document.getElementById('worklogPanel').classList.add('hidden');
  document.getElementById('assignPanel')?.classList.add('hidden');
  document.getElementById('commentVisibility').innerHTML = '<option value="PUBLIC">Public update</option>';
}

async function loadAssignable(role = '') {
  if (!isAdmin()) {
    document.getElementById('assignPanel')?.classList.add('hidden');
    return;
  }
  document.getElementById('assignPanel')?.classList.remove('hidden');
  const query = role ? `?role=${encodeURIComponent(role)}` : '';
  const response = await CsrfClient.getJson(`/api/v1/assignable-employees${query}`);
  if (!response.ok) return;
  const data = await response.json();
  const roleFilter = document.getElementById('assignRoleFilter');
  if (roleFilter.options.length <= 1) {
    roleFilter.innerHTML = '<option value="">All roles</option>' + (data.roles || []).map((item) =>
      `<option value="${text(item)}">${text(item)}</option>`
    ).join('');
  }
  document.getElementById('assignEmployee').innerHTML = '<option value="">Select employee</option>' +
    data.employees.map((employee) =>
      `<option value="${text(employee.id)}">${text(employee.fullName)} · ${text(employee.role)}${employee.jobTitle ? ` · ${text(employee.jobTitle)}` : ''}</option>`
    ).join('');
}

async function loadSession() {
  const response = await fetch('/api/whoami', { credentials: 'include' });
  const data = await response.json().catch(() => ({}));
  state.user = data.user || null;
  if (!state.user) {
    window.location.href = '/login.html';
    return false;
  }
  configureClientShell();
  return true;
}

function renderStatusOptions() {
  const select = document.getElementById('nextStatus');
  const options = allowedTransitions(state.ticket.status);
  const form = document.getElementById('statusForm');
  if (!options.length) {
    form.classList.add('hidden');
    document.getElementById('statusHint').textContent = 'No further status changes are available.';
    return;
  }
  form.classList.remove('hidden');
  document.getElementById('statusHint').textContent = isStaff()
    ? 'Choose the next allowed state for this ticket.'
    : 'You can mark this request pending or close it once the work is done.';
  select.innerHTML = options.map((status) => `<option value="${status}">${text(labelStatus(status))}</option>`).join('');
}

function renderComments(comments) {
  const list = document.getElementById('commentList');
  list.innerHTML = comments.length
    ? comments.map((comment) => `
      <article class="stream-item">
        <div class="stream-meta">
          <strong>${text(comment.author || 'Unknown')}</strong>
          <span>${text(comment.visibility === 'INTERNAL' ? 'INTERNAL' : 'PUBLIC')}</span>
        </div>
        <p>${text(comment.body)}</p>
        <time>${text(formatWhen(comment.created_at))}</time>
      </article>`).join('')
    : '<p class="empty-state">No comments yet.</p>';
}

function renderHistory(history) {
  const list = document.getElementById('historyList');
  list.innerHTML = history.length
    ? history.map((item) => `
      <article class="stream-item">
        <div class="stream-meta">
          <strong>${text(labelStatus(item.from_status || 'START'))} → ${text(labelStatus(item.to_status))}</strong>
          <span>${text(item.actor || 'System')}</span>
        </div>
        <time>${text(formatWhen(item.created_at))}</time>
      </article>`).join('')
    : '<p class="empty-state">No status changes recorded.</p>';
}

function renderWorkLogs(workLogs) {
  const list = document.getElementById('worklogList');
  list.innerHTML = workLogs.length
    ? workLogs.map((item) => `
      <article class="stream-item">
        <div class="stream-meta">
          <strong>${text(item.author || 'Staff')}</strong>
          <span>${text(formatWhen(item.started_at))} – ${text(formatWhen(item.ended_at))}</span>
        </div>
        <p>${text(item.activity)}</p>
        <p class="form-note">${item.is_overtime ? 'Includes overtime' : 'Within shift'} · regular ${text(item.regular_minutes || 0)}m · OT ${text(item.overtime_minutes || 0)}m</p>
        <time>${text(formatWhen(item.created_at))}</time>
      </article>`).join('')
    : '<p class="empty-state">No work logged yet.</p>';
}

function renderTicket(payload) {
  const ticket = payload.ticket;
  state.ticket = ticket;
  document.title = `${ticket.ticket_number} | ANZWER`;
  document.getElementById('ticketDetail').classList.remove('hidden');
  document.getElementById('ticketHeading').textContent = ticket.ticket_number;
  document.getElementById('ticketSubheading').textContent = `${labelStatus(ticket.type)} · ${ticket.priority}`;
  document.getElementById('ticketMeta').textContent = `${labelStatus(ticket.type)} / ${ticket.ticket_number}`;
  document.getElementById('ticketTitle').textContent = ticket.title;
  document.getElementById('ticketStatus').textContent = labelStatus(ticket.status);
  const priority = document.getElementById('ticketPriority');
  priority.textContent = ticket.priority;
  priority.className = `priority ${String(ticket.priority || '').toLowerCase()}`;
  document.getElementById('ticketDescription').textContent = ticket.description || 'No description provided.';
  document.getElementById('ticketRequester').textContent = ticket.requester || '—';
  document.getElementById('ticketAssignee').textContent = ticket.assignee || 'Unassigned';
  document.getElementById('ticketOpened').textContent = formatWhen(ticket.created_at);
  document.getElementById('ticketUpdated').textContent = formatWhen(ticket.updated_at);
  renderStatusOptions();
  renderComments(payload.comments || []);
  renderHistory(payload.history || []);
  renderWorkLogs(payload.workLogs || []);
}

async function loadTicket() {
  if (!state.ticketId) {
    document.getElementById('ticketHeading').textContent = 'Ticket not found';
    showMessage('pageMessage', 'Open a ticket from the queue to see its detail.', false);
    return;
  }
  const response = await CsrfClient.getJson(`/api/v1/tickets/${encodeURIComponent(state.ticketId)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    document.getElementById('ticketHeading').textContent = 'Ticket unavailable';
    showMessage('pageMessage', data.error || 'This ticket could not be loaded.', false);
    return;
  }
  document.getElementById('pageMessage').classList.add('hidden');
  renderTicket(data);
}

document.getElementById('statusForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('nextStatus').value;
  const response = await CsrfClient.request(`/api/v1/tickets/${encodeURIComponent(state.ticketId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  const data = await response.json().catch(() => ({}));
  showMessage('statusMessage', response.ok ? `Moved to ${labelStatus(status)}.` : (data.error || 'Status update failed.'), response.ok);
  if (response.ok) await loadTicket();
});

document.getElementById('commentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = document.getElementById('commentBody').value.trim();
  const visibility = document.getElementById('commentVisibility').value;
  const response = await CsrfClient.postJson(`/api/v1/tickets/${encodeURIComponent(state.ticketId)}/comments`, { body, visibility });
  const data = await response.json().catch(() => ({}));
  showMessage('commentMessage', response.ok ? 'Comment posted.' : (data.error || 'Comment could not be posted.'), response.ok);
  if (response.ok) {
    event.target.reset();
    await loadTicket();
  }
});

document.getElementById('worklogForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const startedAt = document.getElementById('workStarted').value;
  const endedAt = document.getElementById('workEnded').value;
  const activity = document.getElementById('workActivity').value.trim();
  const response = await CsrfClient.postJson(`/api/v1/tickets/${encodeURIComponent(state.ticketId)}/worklogs`, {
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    endedAt: endedAt ? new Date(endedAt).toISOString() : null,
    activity,
  });
  const data = await response.json().catch(() => ({}));
  const shiftNote = data.shift
    ? ` Regular ${data.shift.regular_minutes}m / OT ${data.shift.overtime_minutes}m.`
    : '';
  showMessage('worklogMessage', response.ok ? `Work log added.${shiftNote}` : (data.error || 'Work log could not be saved.'), response.ok);
  if (response.ok) {
    event.target.reset();
    await loadTicket();
  }
});

document.getElementById('assignRoleFilter')?.addEventListener('change', (event) => {
  loadAssignable(event.target.value);
});

document.getElementById('assignForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const assigneeId = document.getElementById('assignEmployee').value;
  const requiredRole = document.getElementById('assignRoleFilter').value || undefined;
  const response = await CsrfClient.request(`/api/v1/tickets/${encodeURIComponent(state.ticketId)}/assign`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assigneeId, requiredRole }),
  });
  const data = await response.json().catch(() => ({}));
  showMessage('assignMessage', response.ok ? 'Ticket assigned.' : (data.error || 'Assignment failed.'), response.ok);
  if (response.ok) await loadTicket();
});

(async () => {
  if (!(await loadSession())) return;
  await loadAssignable();
  await loadTicket();
})();
