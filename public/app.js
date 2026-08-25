const CONTENT_WIDTH = 46;
const DEFAULT_TITLE = 'THE ANZWER IT SUPPORT';
const DEFAULT_SHIFT_START = '9 A.M';
const DEFAULT_STATUS = 'RUNNING';
const DEFAULT_MODE = 'WORKING DAY - LOW ACTIVITY';
const DEFAULT_TASKS = [
  'NO ASSIGNED TASKS',
  'NO PENDING TASKS',
  'NO TASKS IN PROGRESS',
  'NO CLIENT INTERACTION',
];

const refs = {
  titleInput: document.getElementById('titleInput'),
  shiftStartInput: document.getElementById('shiftStartInput'),
  statusSelect: document.getElementById('statusSelect'),
  modeSelect: document.getElementById('modeSelect'),
  taskText: document.getElementById('taskText'),
  activeTaskWrap: document.getElementById('activeTaskWrap'),
  resetButton: document.getElementById('resetButton'),
  copyButton: document.getElementById('copyButton'),
  downloadPdf: document.getElementById('downloadPdf'),
  previewText: document.getElementById('previewText'),
  toast: document.getElementById('toast'),
};

const state = {
  title: DEFAULT_TITLE,
  shiftStart: DEFAULT_SHIFT_START,
  status: DEFAULT_STATUS,
  mode: DEFAULT_MODE,
  tasks: [...DEFAULT_TASKS],
  employeeName: '',
  employeeRole: '',
};

initialize();

function initialize() {
  if (!refs.previewText || !refs.titleInput || !refs.taskText) return;
  refs.titleInput.value = state.title;
  refs.shiftStartInput.value = state.shiftStart;
  refs.statusSelect.value = state.status;
  refs.modeSelect.value = state.mode;
  refs.taskText.value = DEFAULT_TASKS.join('\n');

  bindEvents();
  updateModeVisibility();
  updatePreview();
}

function bindEvents() {
  refs.statusSelect?.addEventListener('change', () => {
    state.status = refs.statusSelect.value || DEFAULT_STATUS;
    updatePreview();
  });

  refs.modeSelect?.addEventListener('change', () => {
    state.mode = refs.modeSelect.value || DEFAULT_MODE;
    updateModeVisibility();
    updatePreview();
  });

  refs.taskText?.addEventListener('input', () => {
    const value = refs.taskText.value;
    state.tasks = value
      .split(/\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    updatePreview();
  });

  refs.resetButton?.addEventListener('click', resetForm);
  refs.copyButton?.addEventListener('click', copyToClipboard);
  refs.downloadPdf?.addEventListener('click', downloadPdf);
}

function updateModeVisibility() {
  if (refs.activeTaskWrap) refs.activeTaskWrap.classList.remove('hidden');
}

function centerText(text, width = CONTENT_WIDTH) {
  const safe = String(text ?? '').slice(0, width);
  const pad = Math.max(0, width - safe.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + safe + ' '.repeat(right);
}

function leftAlignText(text, width = CONTENT_WIDTH) {
  const safe = String(text ?? '').slice(0, width);
  return safe + ' '.repeat(Math.max(0, width - safe.length));
}

function formatCenterBar(width = CONTENT_WIDTH) {
  return '+' + '-'.repeat(width) + '+';
}

function formatBorderLine() {
  return `|${'-'.repeat(CONTENT_WIDTH)}|`;
}

function formatStatusLine(text) {
  const value = String(text ?? '').slice(0, CONTENT_WIDTH).toUpperCase();
  const available = CONTENT_WIDTH - value.length;
  const left = Math.floor(available / 2);
  const right = available - left;
  return '-'.repeat(left) + value + '-'.repeat(right);
}

function formatDateTime(dateObj = new Date()) {
  const month = dateObj.getMonth() + 1;
  const day = dateObj.getDate();
  const year = dateObj.getFullYear();
  const hour = dateObj.getHours();
  const minute = String(dateObj.getMinutes()).padStart(2, '0');
  const meridian = hour >= 12 ? 'P.M' : 'A.M';
  const normalizedHour = hour % 12 || 12;
  return `${month}-${day}-${year} ${normalizedHour}:${minute} ${meridian}`;
}

function formatWeekday(dateObj = new Date()) {
  return dateObj.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
}

function getDateKey(dateObj) {
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getNthWeekdayOfMonth(year, month, weekday, occurrence) {
  const date = new Date(year, month, 1);
  const offset = (weekday - date.getDay() + 7) % 7;
  date.setDate(1 + offset + (occurrence - 1) * 7);
  return date;
}

function getLastWeekdayOfMonth(year, month, weekday) {
  const date = new Date(year, month + 1, 0);
  const offset = (date.getDay() - weekday + 7) % 7;
  date.setDate(date.getDate() - offset);
  return date;
}

function getHolidayName(dateObj = new Date()) {
  const year = dateObj.getFullYear();
  const holidays = [
    [new Date(year, 0, 1), "NEW YEAR'S DAY"],
    [getNthWeekdayOfMonth(year, 0, 1, 3), 'MARTIN LUTHER KING JR. DAY'],
    [getNthWeekdayOfMonth(year, 1, 1, 3), "PRESIDENTS' DAY"],
    [getLastWeekdayOfMonth(year, 4, 1), 'MEMORIAL DAY'],
    [new Date(year, 5, 19), 'JUNETEENTH'],
    [new Date(year, 6, 4), 'INDEPENDENCE DAY'],
    [getNthWeekdayOfMonth(year, 8, 1, 1), 'LABOR DAY'],
    [getNthWeekdayOfMonth(year, 9, 1, 2), 'COLUMBUS DAY'],
    [new Date(year, 10, 11), "VETERANS' DAY"],
    [getNthWeekdayOfMonth(year, 10, 4, 4), 'THANKSGIVING DAY'],
    [new Date(year, 11, 25), 'CHRISTMAS DAY'],
  ];

  const holiday = holidays.find(([holidayDate]) => getDateKey(holidayDate) === getDateKey(dateObj));
  if (holiday) return holiday[1];

  const observedHoliday = holidays.find(([holidayDate]) => {
    const observedDate = new Date(holidayDate);
    if (holidayDate.getDay() === 6) observedDate.setDate(observedDate.getDate() - 1);
    if (holidayDate.getDay() === 0) observedDate.setDate(observedDate.getDate() + 1);
    return getDateKey(observedDate) === getDateKey(dateObj);
  });

  return observedHoliday ? `${observedHoliday[1]} (OBSERVED)` : '';
}

function getAutomaticMode(dateObj = new Date()) {
  return dateObj.getDay() === 0 ? 'SUNDAY - IDLE' : DEFAULT_MODE;
}

function wrapTaskLine(line, width = CONTENT_WIDTH - 6) {
  const normalized = String(line ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return [''];
  }

  const words = normalized.split(' ');
  const wrapped = [];
  let current = '';

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;

    if (candidate.length <= width) {
      current = candidate;
      return;
    }

    if (current) {
      wrapped.push(current);
    }

    if (word.length > width) {
      let chunk = word;
      while (chunk.length > width) {
        wrapped.push(chunk.slice(0, width));
        chunk = chunk.slice(width);
      }
      current = chunk;
    } else {
      current = word;
    }
  });

  if (current) {
    wrapped.push(current);
  }

  return wrapped.length > 0 ? wrapped : [''];
}

function buildTaskLines() {
  const sourceLines = refs.taskText.value
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const wrappedLines = [];
  sourceLines.forEach((line) => {
    const pieces = wrapTaskLine(line, CONTENT_WIDTH - 6);
    pieces.forEach((piece) => wrappedLines.push(piece));
  });

  return wrappedLines.length > 0 ? wrappedLines : ['NO ADDITIONAL ACTIVITY'];
}

function resetForm() {
  state.title = DEFAULT_TITLE;
  state.shiftStart = DEFAULT_SHIFT_START;
  state.status = DEFAULT_STATUS;
  state.mode = DEFAULT_MODE;
  state.tasks = [...DEFAULT_TASKS];

  refs.titleInput.value = state.title;
  refs.shiftStartInput.value = state.shiftStart;
  refs.statusSelect.value = state.status;
  refs.modeSelect.value = state.mode;
  refs.taskText.value = DEFAULT_TASKS.join('\n');

  updateModeVisibility();
  updatePreview();
}

function buildEmployeeLine() {
  if (!state.employeeName) return null;
  const role = state.employeeRole ? ` (${state.employeeRole.toUpperCase()})` : '';
  return ` EMPLOYEE: ${state.employeeName.toUpperCase()}`;
}

function buildReportText() {
  const title = (state.title || DEFAULT_TITLE).toUpperCase();
  const reportDate = new Date();
  const dateTime = formatDateTime(reportDate);
  const weekday = formatWeekday(reportDate);
  const holidayName = getHolidayName(reportDate);
  const statusLine = state.status || DEFAULT_STATUS;
  const labelLine = state.mode || DEFAULT_MODE;
  const taskLines = buildTaskLines();
  const employeeLine = buildEmployeeLine();

  const lines = [
    formatCenterBar(),
    `|${centerText(title)}|`,
    `|${centerText(dateTime)}|`,
    formatBorderLine(),
    `|${leftAlignText(` ${weekday} (${holidayName || 'NO HOLIDAY DETECTED'})`, CONTENT_WIDTH)}|`,
    `|${leftAlignText(` ${labelLine}`, CONTENT_WIDTH)}|`,
    formatBorderLine(),
    `|${leftAlignText(` SINCE ${state.shiftStart || DEFAULT_SHIFT_START}`, CONTENT_WIDTH)}|`,
  ];

  if (employeeLine) {
    lines.push(`|${leftAlignText(employeeLine, CONTENT_WIDTH)}|`);
  }

  lines.push(formatBorderLine());

  taskLines.forEach((line) => {
    const content = `   ${line}`.slice(0, CONTENT_WIDTH);
    lines.push(`|${leftAlignText(content, CONTENT_WIDTH)}|`);
  });

  lines.push(`|${leftAlignText('', CONTENT_WIDTH)}|`);
  lines.push(`|${formatStatusLine(statusLine).padEnd(CONTENT_WIDTH, '-')}|`);
  lines.push(formatCenterBar());

  return lines.join('\n');
}

function updatePreview() {
  const safeTitle = DEFAULT_TITLE.toUpperCase();
  state.title = safeTitle;
  refs.titleInput.value = safeTitle;

  const now = new Date();
  state.mode = refs.modeSelect.value || getAutomaticMode(now);
  refs.modeSelect.value = state.mode;
  updateModeVisibility();

  if (!refs.statusSelect.value) {
    state.status = DEFAULT_STATUS;
    refs.statusSelect.value = DEFAULT_STATUS;
  }

  refs.previewText.textContent = buildReportText();
}

// Called by index-page.js once the logged-in user is known (whoami resolves
// asynchronously, after this script has already run initialize()).
function setReportEmployee(name, role) {
  state.employeeName = name || '';
  state.employeeRole = role || '';
  updatePreview();
}
window.setReportEmployee = setReportEmployee;

async function copyToClipboard() {
  const text = buildReportText();

  try {
    await navigator.clipboard.writeText(text);
    showToast();
  } catch (error) {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
  showToast();
}

function showToast() {
  refs.toast.classList.remove('hidden');
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    refs.toast.classList.add('hidden');
  }, 2000);
}

function downloadPdf() {
  const printable = document.createElement('pre');
  printable.textContent = buildReportText();
  printable.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  printable.style.padding = '24px';
  printable.style.lineHeight = '1.5';
  printable.style.whiteSpace = 'pre';
  printable.style.color = '#111827';
  printable.style.background = '#ffffff';

  const opt = {
    margin: 0.2,
    filename: 'daily-work-report.pdf',
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
  };

  const html2pdf = window.html2pdf || (window.jsPDF ? window.jspdf : null);
  if (!html2pdf) {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
    script.onload = () => {
      window.html2pdf().set(opt).from(printable).save();
    };
    document.body.appendChild(script);
    return;
  }

  window.html2pdf().set(opt).from(printable).save();
}
