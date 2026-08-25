function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function render() {
  const list = document.getElementById('employeeList');
  list.innerHTML = '';
  const [usersResponse, invitationsResponse] = await Promise.all([
    CsrfClient.getJson('/api/users'),
    CsrfClient.getJson('/api/users/invitations'),
  ]);
  if (!usersResponse.ok || !invitationsResponse.ok) {
    list.appendChild(el('li', 'form-message error', 'Team access is unavailable.'));
    return;
  }
  const users = await usersResponse.json();
  const invitations = await invitationsResponse.json();
  users.filter((user) => user.account_type === 'EMPLOYEE' || user.account_type === 'ADMIN').forEach((user) => {
    const row = el('li', 'person-row');
    const label = el('span', 'person-label', `${user.full_name || user.username} (${user.username})`);
    label.appendChild(el('span', 'text-xs text-gray-400', `${user.role === 'admin' ? 'Admin access' : 'Team member'} / ${user.account_status}`));
    row.appendChild(label);
    list.appendChild(row);
  });
  invitations.filter((invite) => invite.status === 'AVAILABLE').forEach((invite) => {
    const row = el('li', 'person-row');
    const label = el('span', 'person-label', invite.invited_name || 'Unassigned invitation');
    label.appendChild(el('span', 'text-xs text-gray-400', `${invite.admin_access ? 'Admin access' : 'Team member'} / available`));
    const code = el('strong', 'invite-code', invite.reference_code);
    row.appendChild(label);
    row.appendChild(code);
    list.appendChild(row);
  });
  if (!list.children.length) list.appendChild(el('li', 'empty-state', 'No team members or invitations yet.'));
}

document.getElementById('addForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('addError');
  const result = document.getElementById('inviteResult');
  error.classList.add('hidden');
  result.classList.add('hidden');
  const response = await CsrfClient.postJson('/api/users/invitations', {
    invitedName: document.getElementById('employeeNameInput').value.trim(),
    invitedEmail: document.getElementById('employeeEmailInput').value.trim(),
    adminAccess: document.getElementById('adminAccessInput').checked,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    error.textContent = body.error || 'Could not create invitation';
    error.classList.remove('hidden');
    return;
  }
  result.textContent = `Reference code: ${body.referenceCode}. Share it securely with the new team member.`;
  result.classList.remove('hidden');
  event.target.reset();
  await render();
});

render();
