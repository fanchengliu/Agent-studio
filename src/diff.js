export function splitDiff(text) {
  const rows = [];
  let oldLine = 0,
    newLine = 0,
    removed = [],
    added = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      rows.push({ left: removed[i] || null, right: added[i] || null });
    removed = [];
    added = [];
  };
  for (const line of text.split('\n')) {
    const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (match) {
      flush();
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      rows.push({ header: line });
      continue;
    }
    if (/^(diff |index |--- |\+\+\+ |\\ No newline)/.test(line)) continue;
    if (line.startsWith('-'))
      removed.push({ number: oldLine++, text: line.slice(1), kind: 'removed' });
    else if (line.startsWith('+'))
      added.push({ number: newLine++, text: line.slice(1), kind: 'added' });
    else {
      flush();
      if (line.startsWith(' '))
        rows.push({
          left: { number: oldLine++, text: line.slice(1) },
          right: { number: newLine++, text: line.slice(1) },
        });
    }
  }
  flush();
  return rows;
}
