import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

/** Collect owner credentials without echoing either field to the terminal. */
export async function readInteractiveOwner() {
  if (!process.stdin.isTTY) throw new Error('An interactive terminal is required');
  const silentOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const prompt = createInterface({ input: process.stdin, output: silentOutput, terminal: true });
  const controller = new AbortController();
  prompt.on('SIGINT', () => controller.abort());
  prompt.on('close', () => controller.abort());
  try {
    process.stderr.write('Логин владельца (ввод скрыт): ');
    const login = await prompt.question('', { signal: controller.signal });
    process.stderr.write('\nПароль владельца (ввод скрыт): ');
    const password = await prompt.question('', { signal: controller.signal });
    process.stderr.write('\n');
    return { login, password };
  } finally {
    prompt.close();
  }
}
