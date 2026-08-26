function clientText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

const chatState = {
  chatId: null,
  employeeId: null,
  pollTimer: null,
};

async function loadClientTickets() {
  const response = await CsrfClient.getJson('/api/v1/tickets');
  if (!response.ok) return;
  const data = await response.json();
  const rows = document.getElementById('clientTicketRows');
  rows.innerHTML = data.tickets.length
    ? data.tickets.map((ticket) => `
      <tr class="table-row ticket-link" data-id="${clientText(ticket.id)}" tabindex="0" role="link">
        <td class="ticket-ref">${clientText(ticket.ticket_number)}</td>
        <td><strong>${clientText(ticket.title)}</strong><small>${clientText(ticket.type)}</small></td>
        <td><span class="badge">${clientText(ticket.status.replace('_', ' '))}</span></td>
        <td><span class="priority ${clientText(ticket.priority.toLowerCase())}">${clientText(ticket.priority)}</span></td>
        <td class="muted">${clientText(ticket.assignee || 'Unassigned')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty-state">You have no requests yet.</td></tr>';
}

function openTicket(id) {
  if (!id) return;
  window.location.href = `ticket.html?id=${encodeURIComponent(id)}`;
}

async function loadMembers() {
  const response = await CsrfClient.getJson('/api/v1/company-members');
  if (!response.ok) return;
  const data = await response.json();
  const select = document.getElementById('clientAssignee');
  select.innerHTML = '<option value="">Any available team member</option>' + data.members.map((member) =>
    `<option value="${clientText(member.id)}">${clientText(member.fullName)} · ${clientText(member.role)}${member.jobTitle ? ` · ${clientText(member.jobTitle)}` : ''}</option>`
  ).join('');

  document.getElementById('memberList').innerHTML = data.members.length
    ? data.members.map((member) => `
      <article class="member-card">
        <div>
          <strong>${clientText(member.fullName)}</strong>
          <small>${clientText(member.role)}${member.department ? ` · ${clientText(member.department)}` : ''}</small>
          <p>${clientText(member.jobTitle || member.employeeId || 'Company member')}</p>
        </div>
        <div class="member-actions">
          ${member.phone ? `<a class="button-secondary" href="tel:${clientText(member.phone)}">Call</a>` : '<span class="muted">No phone</span>'}
          <button type="button" class="button-primary chat-start" data-id="${clientText(member.id)}" data-name="${clientText(member.fullName)}">Chat</button>
          <button type="button" class="button-secondary assign-pick" data-id="${clientText(member.id)}">Assign ticket</button>
        </div>
      </article>`).join('')
    : '<p class="empty-state">No active company members are available yet.</p>';

  document.querySelectorAll('.chat-start').forEach((button) => {
    button.addEventListener('click', () => startChat(button.dataset.id, button.dataset.name));
  });
  document.querySelectorAll('.assign-pick').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById('clientAssignee').value = button.dataset.id;
      document.getElementById('clientTicketTitle').focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

async function startChat(employeeId, name) {
  const response = await CsrfClient.postJson('/api/v1/chats', { employeeId });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    document.getElementById('chatMessageStatus').textContent = data.error || 'Could not open chat.';
    document.getElementById('chatMessageStatus').className = 'form-message error';
    return;
  }
  chatState.chatId = data.chat.id;
  chatState.employeeId = employeeId;
  document.getElementById('chatHeading').textContent = `Chat with ${name}`;
  document.getElementById('chatPeer').textContent = 'Private conversation · messages archive after 7 idle days';
  document.getElementById('chatForm').classList.remove('hidden');
  await loadChatMessages();
  if (chatState.pollTimer) clearInterval(chatState.pollTimer);
  chatState.pollTimer = setInterval(loadChatMessages, 8000);
}

async function loadChatMessages() {
  if (!chatState.chatId) return;
  const response = await CsrfClient.getJson(`/api/v1/chats/${encodeURIComponent(chatState.chatId)}/messages`);
  if (!response.ok) return;
  const data = await response.json();
  const me = (await (await fetch('/api/whoami', { credentials: 'include' })).json()).user?.id;
  document.getElementById('chatMessages').innerHTML = data.messages.length
    ? data.messages.map((message) => `
      <article class="chat-bubble ${message.senderId === me ? 'mine' : 'theirs'}">
        <p>${clientText(message.body)}</p>
        <time>${clientText(new Date(message.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }))}</time>
      </article>`).join('')
    : '<p class="empty-state">No messages yet. Say hello.</p>';
  const box = document.getElementById('chatMessages');
  box.scrollTop = box.scrollHeight;
}

document.getElementById('clientTicketRows').addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-id]');
  if (row) openTicket(row.dataset.id);
});

document.getElementById('clientTicketRows').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('tr[data-id]');
  if (!row) return;
  event.preventDefault();
  openTicket(row.dataset.id);
});

document.getElementById('clientTicketForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const assigneeId = document.getElementById('clientAssignee').value || null;
  const response = await CsrfClient.postJson('/api/v1/tickets', {
    type: document.getElementById('clientTicketType').value,
    title: document.getElementById('clientTicketTitle').value,
    description: document.getElementById('clientTicketDescription').value,
    impact: 2,
    urgency: 2,
    assigneeId,
  });
  const data = await response.json().catch(() => ({}));
  const message = document.getElementById('clientTicketMessage');
  message.textContent = response.ok
    ? `${data.ticket.ticket_number} raised${data.ticket.assignee ? ` for ${data.ticket.assignee}` : ''}.`
    : (data.error || 'Could not raise ticket.');
  message.className = `form-message ${response.ok ? 'success' : 'error'}`;
  if (response.ok) {
    event.target.reset();
    loadClientTickets();
  }
});

document.getElementById('chatForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!chatState.chatId) return;
  const body = document.getElementById('chatBody').value.trim();
  const response = await CsrfClient.postJson(`/api/v1/chats/${encodeURIComponent(chatState.chatId)}/messages`, { body });
  const data = await response.json().catch(() => ({}));
  const status = document.getElementById('chatMessageStatus');
  status.textContent = response.ok ? 'Sent.' : (data.error || 'Message failed.');
  status.className = `form-message ${response.ok ? 'success' : 'error'}`;
  if (response.ok) {
    document.getElementById('chatBody').value = '';
    await loadChatMessages();
  }
});

loadMembers();
loadClientTickets();
