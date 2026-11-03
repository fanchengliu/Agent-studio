const [command, ...args] = process.argv.slice(2);
if (!command || command === 'help') {
  console.log(
    'studio peers | send <队友> <任务...> | task <任务ID> | note-read <便签ID> | note-write <便签ID> <内容...>',
  );
} else {
  const methods = {
    peers: ['team_peers', {}],
    send: ['team_send', { target: args[0], prompt: args.slice(1).join(' ') }],
    task: ['team_task', { taskId: args[0] }],
    'note-read': ['team_note_read', { noteId: args[0] }],
    'note-write': ['team_note_write', { noteId: args[0], content: args.slice(1).join(' ') }],
  };
  try {
    if (!methods[command]) throw new Error('未知命令，请运行 help');
    if (!process.env.STUDIO_BRIDGE_URL || !process.env.STUDIO_BRIDGE_TOKEN)
      throw new Error('此命令需要工作台提供的节点协作环境');
    const [method, values] = methods[command];
    const r = await fetch(process.env.STUDIO_BRIDGE_URL + '/api/bridge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Studio-Bridge': process.env.STUDIO_BRIDGE_TOKEN,
      },
      body: JSON.stringify({ method, args: values }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    console.log(JSON.stringify(data.result, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
