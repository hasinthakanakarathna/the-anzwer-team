document.getElementById('loginBtn').addEventListener('click', async () => {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const err = document.getElementById('loginError');
  err.classList.add('hidden');
  if (!username || !password) {
    err.textContent = 'Please enter a username and password';
    err.classList.remove('hidden');
    return;
  }
  try {
    const res = await CsrfClient.postJson('/api/login', { username, password });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = body.error || 'Login failed';
      err.classList.remove('hidden');
      return;
    }
    const user = body.user;
    window.location.href = user.accountType === 'CLIENT' ? '/client.html' : user.accountType === 'ADMIN' ? '/admin.html' : '/index.html';
  } catch (e) {
    err.textContent = 'Network error, please try again';
    err.classList.remove('hidden');
  }
});

document.getElementById('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('loginBtn').click();
});

// Disable "Manage Employees" link unless logged in as admin.
(async () => {
  const r = await fetch('/api/whoami', { credentials: 'include' });
  const j = await r.json();
  const manage = document.querySelector('a[href="employees.html"]');
  if (manage && (!j.user || j.user.role !== 'admin')) {
    manage.classList.add('pointer-events-none', 'opacity-40');
  }
})();
