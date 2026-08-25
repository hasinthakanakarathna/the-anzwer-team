async function loadAutomaticActivity() {
  if (!document.getElementById('taskText')) return;
  const response = await CsrfClient.getJson('/api/v1/tickets');
  if (!response.ok) return;
  const { tickets } = await response.json();
  const today = new Date().toISOString().slice(0, 10);
  const activity = tickets.filter((ticket) => String(ticket.updated_at || ticket.created_at).slice(0, 10) === today).slice(0, 20).map((ticket) => `${ticket.ticket_number} - ${ticket.title} [${ticket.status}]`);
  const taskText = document.getElementById('taskText');
  taskText.value = activity.join('\n');
  document.getElementById('modeSelect').value = 'WORKING DAY - ACTIVE';
  document.getElementById('activityStatus').textContent = activity.length ? `${activity.length} ticket${activity.length === 1 ? '' : 's'} captured automatically. Add missing work below.` : 'No ticket activity captured yet. Add any work completed outside the system.';
  taskText.dispatchEvent(new Event('input'));
}

document.getElementById('submitReport')?.addEventListener('click', async () => {
  const message = document.getElementById('submitMessage');
  const response = await CsrfClient.postJson('/api/reports', { content: buildReportText() });
  const data = await response.json().catch(() => ({}));
  message.textContent = response.ok ? 'Daily report submitted to management.' : (data.error || 'Report could not be submitted.');
  message.className = `form-message ${response.ok ? 'success' : 'error'}`;
});

loadAutomaticActivity();
