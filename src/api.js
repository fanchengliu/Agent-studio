let sessionToken = '';
export async function initSession() {
  const r = await fetch('/api/session');
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  sessionToken = d.token;
}
export async function api(path, body, method) {
  const r = await fetch('/api' + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': sessionToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '请求失败');
  return data;
}
export const statusLabels = {
  queued: '等待执行',
  running: '执行中',
  waiting_approval: '等待你',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
  blocked: '上游阻塞',
};
export const dateTime = (value) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Hong_Kong',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(value))
    : '—';
export const duration = (task) => {
  if (!task?.startedAt) return '—';
  const seconds = Math.max(
    0,
    Math.round(
      ((task.endedAt ? new Date(task.endedAt) : Date.now()) - new Date(task.startedAt)) / 1000,
    ),
  );
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
export function download(path) {
  const a = document.createElement('a');
  a.href = '/api' + path;
  a.click();
}
