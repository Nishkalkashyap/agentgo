// Sits between the server and each agent CLI. If the server dies, the IPC channel
// disconnects and this kills the CLI's whole process group.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
let child: ChildProcessWithoutNullStreams | undefined;
let stopping = false;
let ended = false;
function send(message: unknown) { if (process.connected) process.send?.(message, () => {}); }
function signal(groupSignal: NodeJS.Signals) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, groupSignal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
function stop() {
  if (stopping) return;
  stopping = true;
  signal('SIGTERM');
  setTimeout(() => {
    signal('SIGKILL');
    if (ended || !child) process.exit(0);
  }, 750);
  setTimeout(() => process.exit(1), 2500);
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('message', (message: any) => {
  if (message.type === 'start' && !child && !stopping) {
    child = spawn(message.file, message.args, { cwd: message.cwd, env: message.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      stream.on('data', (data: Buffer) => {
        stream.pause();
        if (process.connected) process.send?.({ type: name, data: data.toString('base64') }, () => stream.resume());
        else stop();
      });
    }
    child.once('error', error => { send({ type: 'error', message: error.message }); ended = true; stop(); });
    child.once('close', (code, signal) => {
      ended = true;
      // A command may leave background children. Reap the entire owned group.
      send({ type: 'exit', code, signal });
      stop();
    });
  } else if (message.type === 'stdin') child?.stdin.write(message.data);
  else if (message.type === 'end') child?.stdin.end();
  else if (message.type === 'stop') stop();
});
