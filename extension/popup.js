const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  if (!s) return;
  $('aiTabs').textContent = s.aiTabs;
  $('attached').textContent = s.attached;
  $('port').textContent = s.port;
  $('err').textContent = s.paused ? '' : s.lastError || '';
  if (s.paused) {
    $('status').textContent = '已暂停：AI 无法操作浏览器';
    $('dot').style.background = 'var(--danger)';
    $('toggle').textContent = '恢复';
    $('toggle').className = 'primary';
  } else {
    $('status').textContent = s.connected ? '已连接 MCP' : '未连接（MCP 未运行）';
    $('dot').style.background = s.connected ? 'var(--ok)' : 'var(--muted)';
    $('toggle').textContent = '全部停止';
    $('toggle').className = 'danger';
  }
  $('toggle').dataset.paused = s.paused ? '1' : '';
}

$('toggle').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: $('toggle').dataset.paused ? 'resume' : 'pause' });
  await refresh();
});
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

void refresh();
setInterval(refresh, 1000);
