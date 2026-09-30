const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');

const ACTIONS = { click: '点击', type: '输入文字', press_key: '按键', select_option: '选择下拉选项', hover: '悬停' };

async function answer(a) {
  await chrome.runtime.sendMessage({ type: 'confirm-answer', id, answer: a });
  window.close();
}

(async () => {
  const { req } = await chrome.runtime.sendMessage({ type: 'confirm-get', id });
  if (!req) {
    window.close();
    return;
  }
  $('host').textContent = req.host || req.url || '';
  $('action').textContent = ACTIONS[req.action] || req.action;
  $('target').textContent = req.target || '(未知元素)';
  if (req.value) $('value').textContent = req.value;
  else {
    $('value').remove();
    $('valueLabel').remove();
  }
  $('reason').textContent = req.reason || '';
  if (req.sensitive) $('trustRow').remove(); // 敏感网站不能设为信任
  let left = Math.round((req.timeoutMs || 45000) / 1000) - 1;
  const tick = () => ($('countdown').textContent = `${left}s`);
  tick();
  setInterval(() => {
    left = Math.max(0, left - 1);
    tick();
  }, 1000);
})();

$('allow').addEventListener('click', () => answer('allow'));
$('deny').addEventListener('click', () => answer('deny'));
$('trust')?.addEventListener('click', () => answer('trust'));
