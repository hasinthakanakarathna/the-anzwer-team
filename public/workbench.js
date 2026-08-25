const metricLabels = [
  ['total', 'Total tickets'],
  ['open', 'Open'],
  ['in_progress', 'In progress'],
  ['pending', 'Pending'],
  ['resolved', 'Resolved'],
  ['critical', 'Critical'],
];

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function showTicketMessage(text, error = false) {
  const message = document.getElementById('ticketMessage');
  message.textContent = text;
  message.className = `text-sm ${error ? 'text-rose-400' : 'text-emerald-400'}`;
}

async function loadDashboard() {
  const dashboardResponse = await CsrfClient.getJson('/api/v1/dashboard');
  if (!dashboardResponse.ok) return;
  const dashboard = await dashboardResponse.json();
  document.getElementById('metricGrid').innerHTML = metricLabels.map(([key, label]) => `
    <article class="metric"><div class="metric-label">${label}</div><div class="metric-value">${dashboard.counts[key] || 0}</div></article>`).join('');
  await loadTickets();
}

async function loadTickets() {
  const statusFilter = document.getElementById('statusFilter');
  const status = statusFilter ? statusFilter.value : '';
  const response = await CsrfClient.getJson(`/api/v1/tickets${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  if (!response.ok) return;
  const data = await response.json();
  const rows = document.getElementById('ticketRows');
  rows.innerHTML = data.tickets.length ? data.tickets.map((ticket) => `
    <tr class="table-row"><td class="font-mono text-xs text-emerald-400">${escapeText(ticket.ticket_number)}</td><td><div class="font-medium">${escapeText(ticket.title)}</div><div class="mt-1 text-xs text-slate-500">${escapeText(ticket.type)} · ${escapeText(ticket.requester)}</div></td><td><span class="badge">${escapeText(ticket.status.replace('_', ' '))}</span></td><td><span class="priority ${escapeText(ticket.priority.toLowerCase())}">${escapeText(ticket.priority)}</span></td><td class="text-slate-400">${escapeText(ticket.assignee || 'Unassigned')}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-state">No tickets match this queue.</td></tr>';
}

document.getElementById('ticketForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    type: document.getElementById('ticketType').value,
    title: document.getElementById('ticketTitle').value,
    description: document.getElementById('ticketDescription').value,
    impact: Number(document.getElementById('ticketImpact').value),
    urgency: Number(document.getElementById('ticketUrgency').value),
  };
  const response = await CsrfClient.postJson('/api/v1/tickets', payload);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showTicketMessage(data.error || 'Ticket could not be created.', true);
  event.target.reset();
  showTicketMessage(`${data.ticket.ticket_number} created at ${data.ticket.priority}.`);
  await loadDashboard();
});

const statusFilter = document.getElementById('statusFilter');
if (statusFilter) statusFilter.addEventListener('change', loadTickets);
const terminalToggle = document.getElementById('terminalToggle');
if (terminalToggle) terminalToggle.addEventListener('click', () => document.getElementById('terminalPanel').classList.toggle('hidden'));
loadDashboard();
