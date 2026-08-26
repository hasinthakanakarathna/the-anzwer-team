function ticketText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

async function refreshTickets() {
  const query = new URLSearchParams();
  const status = document.getElementById('statusFilter').value;
  const priority = document.getElementById('priorityFilter').value;
  if (status) query.set('status', status);
  if (priority) query.set('priority', priority);
  const response = await CsrfClient.getJson(`/api/v1/tickets?${query}`);
  if (!response.ok) return;
  const data = await response.json();
  document.getElementById('ticketRows').innerHTML = data.tickets.length
    ? data.tickets.map((ticket) => `
      <tr class="table-row ticket-link" data-id="${ticketText(ticket.id)}" tabindex="0" role="link">
        <td class="ticket-ref">${ticketText(ticket.ticket_number)}</td>
        <td><strong>${ticketText(ticket.title)}</strong><small>${ticketText(ticket.type)}</small></td>
        <td><span class="badge">${ticketText(ticket.status.replace('_', ' '))}</span></td>
        <td><span class="priority ${ticketText(ticket.priority.toLowerCase())}">${ticketText(ticket.priority)}</span></td>
        <td>${ticketText(ticket.requester)}</td>
        <td class="muted">${ticketText(ticket.assignee || 'Unassigned')}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty-state">No tickets match these filters.</td></tr>';
}

function openTicket(id) {
  if (!id) return;
  window.location.href = `ticket.html?id=${encodeURIComponent(id)}`;
}

document.getElementById('ticketRows').addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-id]');
  if (row) openTicket(row.dataset.id);
});

document.getElementById('ticketRows').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('tr[data-id]');
  if (!row) return;
  event.preventDefault();
  openTicket(row.dataset.id);
});

document.getElementById('ticketForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await CsrfClient.postJson('/api/v1/tickets', {
    type: document.getElementById('ticketType').value,
    title: document.getElementById('ticketTitle').value,
    description: document.getElementById('ticketDescription').value,
    impact: Number(document.getElementById('ticketImpact').value),
    urgency: Number(document.getElementById('ticketUrgency').value),
  });
  const data = await response.json().catch(() => ({}));
  const message = document.getElementById('ticketMessage');
  message.textContent = response.ok ? `${data.ticket.ticket_number} created.` : (data.error || 'Ticket could not be created.');
  message.className = `form-message ${response.ok ? 'success' : 'error'}`;
  if (response.ok) {
    event.target.reset();
    refreshTickets();
  }
});

document.getElementById('statusFilter').addEventListener('change', refreshTickets);
document.getElementById('priorityFilter').addEventListener('change', refreshTickets);
refreshTickets();
