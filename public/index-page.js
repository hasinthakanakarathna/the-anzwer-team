async function whoami() {
  const res = await fetch('/api/whoami', { credentials: 'include' });
  if (!res.ok) return null;
  const j = await res.json();
  return j.user || null;
}

(async () => {
  const user = await whoami();
  if (!user) {
    window.location.href = '/login.html';
    return;
  }
  const page = window.location.pathname.split('/').pop();
  if (user.accountType === 'CLIENT' && !['client.html', 'profile.html', 'ticket.html'].includes(page)) {
    window.location.href = '/client.html';
    return;
  }
  if (page === 'client.html' && user.accountType !== 'CLIENT') {
    window.location.href = user.accountType === 'ADMIN' ? '/admin.html' : '/index.html';
    return;
  }
  if (user.accountType === 'ADMIN' && page === 'client.html') {
    window.location.href = '/admin.html';
    return;
  }
  if (page === 'admin.html' && user.accountType !== 'ADMIN') {
    window.location.href = '/index.html';
    return;
  }
  if (page === 'employees.html' && user.accountType !== 'ADMIN') {
    window.location.href = '/index.html';
    return;
  }
  const display = document.getElementById('employeeDisplay');
  if (display) display.textContent = `Signed in: ${user.username}`;

  const navToggle = document.getElementById('navToggle');
  const sidebar = document.querySelector('.overview-sidebar');
  if (navToggle && sidebar) {
    navToggle.addEventListener('click', () => {
      const isOpen = sidebar.classList.toggle('menu-open');
      navToggle.setAttribute('aria-expanded', String(isOpen));
    });
  }

  const navigation = document.querySelector('.main-nav');
  const teamLink = navigation?.querySelector('a[href="employees.html"]');
  if (teamLink && user.accountType !== 'ADMIN') teamLink.remove();
  if (navigation && !navigation.querySelector('a[href="profile.html"]')) {
    const profileLink = document.createElement('a');
    profileLink.href = 'profile.html';
    profileLink.textContent = 'My profile';
    navigation.appendChild(profileLink);
  }

  if (typeof window.setReportEmployee === 'function') {
    window.setReportEmployee(user.username, user.role);
  }

  const logout = document.getElementById('logoutButton');
  if (logout) {
    logout.addEventListener('click', async () => {
      await CsrfClient.postJson('/api/logout', {});
      window.location.href = '/login.html';
    });
  }
})();
