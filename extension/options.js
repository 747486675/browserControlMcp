import { DEFAULT_PORT, DEFAULT_SENSITIVE } from './defaults.js';

const $ = (id) => document.getElementById(id);
const lines = (t) => t.split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

async function load() {
  const s = await chrome.storage.local.get(['port', 'sensitive', 'trusted', 'audit']);
  $('port').value = s.port || DEFAULT_PORT;
  $('sensitive').value = (s.sensitive || DEFAULT_SENSITIVE).join('\n');
  $('trusted').value = (s.trusted || []).join('\n');
  const tbody = $('audit');
  tbody.textContent = '';
  for (const e of (s.audit || []).slice(-100).reverse()) {
    const tr = document.createElement('tr');
    for (const v of [new Date(e.time).toLocaleString(), e.host, e.action, e.target, e.answer]) {
      const td = document.createElement('td');
      td.textContent = v ?? '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

$('save').addEventListener('click', async () => {
  const port = Number($('port').value) || DEFAULT_PORT;
  const sensitive = lines($('sensitive').value);
  const trusted = lines($('trusted').value).filter((h) => !sensitive.some((d) => h === d || h.endsWith('.' + d)));
  await chrome.storage.local.set({ port, sensitive, trusted });
  await chrome.runtime.sendMessage({ type: 'settings-changed' });
  $('saved').textContent = '已保存';
  setTimeout(() => ($('saved').textContent = ''), 2000);
  await load();
});

$('reset').addEventListener('click', () => {
  $('sensitive').value = DEFAULT_SENSITIVE.join('\n');
});

void load();
