const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*[0-9]).{8,200}$/;

function getBirthYear() {
  const value = document.getElementById('nicNumber').value.replace(/\s|-/g, '');
  const year = Number(value.slice(0, 4));
  return /^\d{4}/.test(value) && year >= 1900 && year <= new Date().getFullYear() ? year : null;
}

let previewRequest = 0;
let previewTimer;
async function updateIdentityPreview() {
  const type = document.querySelector('input[name="accountType"]:checked').value === 'EMPLOYEE' ? 'EMP' : 'CLI';
  const year = getBirthYear();
  const preview = document.getElementById('generatedIdentity');
  preview.textContent = year ? `${type}${year}....` : `${type}YYYY....`;
  if (!year) return;
  const requestNumber = ++previewRequest;
  try {
    const response = await CsrfClient.postJson('/api/register/identity-preview', {
      accountType: document.querySelector('input[name="accountType"]:checked').value,
      nicNumber: document.getElementById('nicNumber').value,
    });
    const data = await response.json().catch(() => ({}));
    if (requestNumber === previewRequest && response.ok) preview.textContent = data.id;
  } catch (error) {
    if (requestNumber === previewRequest) preview.textContent = `${type}${year}....`;
  }
}

function showMsg(text, isError = true) {
  const msg = document.getElementById('regMsg');
  msg.textContent = text;
  msg.className = 'form-message ' + (isError ? 'error' : 'success');
}

function updateAccountType() {
  const accountType = document.querySelector('input[name="accountType"]:checked').value;
  document.getElementById('clientFields').classList.toggle('hidden', accountType !== 'CLIENT');
  document.getElementById('employeeFields').classList.toggle('hidden', accountType !== 'EMPLOYEE');
  document.getElementById('accountHint').textContent = accountType === 'CLIENT'
    ? 'For customers requesting support. We will link your requests to this workspace.'
    : 'For invited staff. Enter the one-time team reference code provided by your manager.';
  document.getElementById('shopName').required = accountType === 'CLIENT';
  document.getElementById('location').required = accountType === 'CLIENT';
  updateIdentityPreview();
}

document.querySelectorAll('input[name="accountType"]').forEach((input) => input.addEventListener('change', updateAccountType));
updateAccountType();
document.getElementById('nicNumber').addEventListener('input', () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updateIdentityPreview, 450);
});

document.getElementById('regForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const password = document.getElementById('password').value;
  const accountType = document.querySelector('input[name="accountType"]:checked').value;
  const fullName = document.getElementById('fullName').value.trim();
  const email = document.getElementById('email').value.trim();

  if (!getBirthYear()) return showMsg('Enter a NIC beginning with a valid four-digit birth year');
  const referenceCode = document.getElementById('referenceCode').value.trim().toUpperCase();
  if (accountType === 'EMPLOYEE' && !/^ANZ-TEAM-[A-F0-9]{10}$/.test(referenceCode)) return showMsg('Enter the valid team reference code from your manager');
  if (!PASSWORD_RE.test(password)) {
    return showMsg('Password must be 8+ chars with a letter and a number');
  }
  if (!fullName || !email) return showMsg('Full name and email are required');

  try {
    const res = await CsrfClient.postJson('/api/register', { nicNumber: document.getElementById('nicNumber').value, referenceCode, password, accountType, fullName, email, phone: document.getElementById('phone').value.trim(), department: document.getElementById('department').value.trim(), jobTitle: document.getElementById('jobTitle').value.trim(), location: document.getElementById('location').value.trim(), shopName: document.getElementById('shopName').value.trim() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return showMsg(body.error || 'Registration failed');
    }
    showMsg(accountType === 'EMPLOYEE' ? `Employee identity ${body.employeeId} created. You can now sign in.` : `Customer identity ${body.customerId} created. You can now sign in.`, false);
  } catch (e) {
    showMsg('Network error, please try again');
  }
});
