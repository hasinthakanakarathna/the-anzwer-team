function clientText(value) { return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])); }
async function loadClientTickets() {
  const response = await CsrfClient.getJson('/api/v1/tickets');
  if (!response.ok) return;
  const data = await response.json();
  document.getElementById('clientTicketRows').innerHTML = data.tickets.length ? data.tickets.map((ticket) => `<tr class="table-row"><td class="ticket-ref">${clientText(ticket.ticket_number)}</td><td><strong>${clientText(ticket.title)}</strong><small>${clientText(ticket.type)}</small></td><td><span class="badge">${clientText(ticket.status.replace('_', ' '))}</span></td><td><span class="priority ${clientText(ticket.priority.toLowerCase())}">${clientText(ticket.priority)}</span></td></tr>`).join('') : '<tr><td colspan="4" class="empty-state">You have no requests yet.</td></tr>';
}
document.getElementById('clientTicketForm').addEventListener('submit', async (event) => { event.preventDefault(); const response = await CsrfClient.postJson('/api/v1/tickets', { type: document.getElementById('clientTicketType').value, title: document.getElementById('clientTicketTitle').value, description: document.getElementById('clientTicketDescription').value, impact: 2, urgency: 2 }); const data = await response.json().catch(() => ({})); const message = document.getElementById('clientTicketMessage'); message.textContent = response.ok ? `${data.ticket.ticket_number} raised successfully.` : (data.error || 'Could not raise ticket.'); message.className = `form-message ${response.ok ? 'success' : 'error'}`; if (response.ok) { event.target.reset(); loadClientTickets(); } });
loadClientTickets();
