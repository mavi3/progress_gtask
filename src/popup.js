const TASK_PREFIX = 'gtp:task:';
const SETTINGS_KEY = 'gtp:settings';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const debugEl = document.getElementById('debug');
const clearEl = document.getElementById('clear');

const dateFormat = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' });
let taskKeys = [];
let clearArmed = false;

function renderItem(storageKey, record) {
  const li = document.createElement('li');
  li.className = 'item';

  const pie = document.createElement('span');
  pie.className = 'pie';

  const text = document.createElement('div');
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = record.title || storageKey.slice(TASK_PREFIX.length);
  const since = document.createElement('span');
  since.className = 'since';
  since.textContent = record.since ? `desde el ${dateFormat.format(new Date(record.since))}` : '';
  text.append(title, since);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link';
  remove.textContent = 'Quitar';
  remove.title = 'Vuelve a dejarla como incompleta';
  remove.addEventListener('click', () => chrome.storage.local.remove(storageKey));

  li.append(pie, text, remove);
  return li;
}

async function refresh() {
  const items = await chrome.storage.local.get(null);
  const tasks = Object.entries(items)
    .filter(([k]) => k.startsWith(TASK_PREFIX))
    .sort(([, a], [, b]) => (b.since || 0) - (a.since || 0));

  taskKeys = tasks.map(([k]) => k);
  listEl.replaceChildren(...tasks.map(([k, v]) => renderItem(k, v)));
  emptyEl.hidden = tasks.length > 0;
  clearEl.hidden = tasks.length === 0;
  countEl.textContent = tasks.length ? `(${tasks.length})` : '';
  debugEl.checked = Boolean(items[SETTINGS_KEY] && items[SETTINGS_KEY].debug);
  disarmClear();
}

function disarmClear() {
  clearArmed = false;
  clearEl.textContent = 'Quitar todas';
  clearEl.classList.remove('danger');
}

clearEl.addEventListener('click', () => {
  if (!clearArmed) {
    clearArmed = true;
    clearEl.textContent = '¿Seguro? Confirmar';
    clearEl.classList.add('danger');
    return;
  }
  chrome.storage.local.remove(taskKeys);
});

debugEl.addEventListener('change', async () => {
  const items = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = { ...(items[SETTINGS_KEY] || {}), debug: debugEl.checked };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') refresh();
});

refresh();
