export function nextScheduled(schedule, from = Date.now()) {
  if (schedule.kind === 'once') {
    const at = Date.parse(schedule.at);
    return Number.isFinite(at) && at > from ? at : null;
  }
  if (schedule.kind === 'interval' || !schedule.kind)
    return from + Math.max(1, Number(schedule.minutes) || 60) * 60000;
  if (!/^\d{2}:\d{2}$/.test(schedule.time || '')) throw new Error('时间格式为 HH:mm');
  const [hour, minute] = schedule.time.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new Error('时间超出范围');
  const offset = Number(schedule.offsetMinutes ?? 480);
  if (!Number.isFinite(offset) || Math.abs(offset) > 840) throw new Error('时区偏移无效');
  const local = new Date(from + offset * 60000);
  for (let day = 0; day < 9; day++) {
    const candidate =
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate() + day,
        hour,
        minute,
      ) -
      offset * 60000;
    const weekDay = new Date(candidate + offset * 60000).getUTCDay();
    if (candidate > from && (schedule.kind === 'daily' || (schedule.days || [1]).includes(weekDay)))
      return candidate;
  }
  throw new Error('无法计算下一次执行时间');
}
