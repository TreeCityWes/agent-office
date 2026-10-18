import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import type { Pty } from '../src/server/ptys.js';
import { codex } from '../src/server/providers/codex.js';
import { typePrompt } from '../src/server/workers/typing.js';

const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const show = (term: headless.Terminal, text: string) => new Promise<void>((resolve) => term.write(text, resolve));

function fakePty(): Pty & { sent: string[] } {
  const sent: string[] = [];
  return { sent, write: (data: string) => void sent.push(data) } as unknown as Pty & { sent: string[] };
}

test('a prompt is pasted whole, then submitted with Enter', async () => {
  const pty = fakePty();
  typePrompt({ pty }, 'line one\nline two');
  assert.deepEqual(pty.sent, [PASTE('line one\nline two')]);
  await sleep(200);
  assert.deepEqual(pty.sent, [PASTE('line one\nline two'), '\r']);
});

test('an agent that waits for it gets Enter only once the whole prompt shows on its screen', async () => {
  const term = new headless.Terminal({ cols: 40, rows: 12, allowProposedApi: true });
  const letter = 'Nibble: post a note on whether the trigger is met.\n\n(Answer with fund_message to "cio".)';
  // An earlier letter ending the same way is already on screen.
  await show(term, '› Pixel: thanks for R-1.\r\n  (Answer with fund_message to "cio".)\r\n\r\n› ');
  const pty = fakePty();
  const w = { pty, term };
  typePrompt(w, letter, true);
  // The agent is still taking the keystrokes in: nothing new on screen, so no Enter, however long.
  await sleep(500);
  assert.deepEqual(pty.sent, [PASTE(letter)]);
  // Then it shows the paste all at once, wrapped to its width; Enter follows a moment later.
  await show(term, letter.replaceAll('\n', '\r\n  '));
  await sleep(100);
  assert.deepEqual(pty.sent, [PASTE(letter)], 'not straight away: the agent may still count it as the paste');
  await sleep(400);
  assert.deepEqual(pty.sent, [PASTE(letter), '\r']);
  term.dispose();
});

test('nothing is submitted into an agent that started over meanwhile', async () => {
  const term = new headless.Terminal({ cols: 40, rows: 12, allowProposedApi: true });
  const pty = fakePty();
  const w: { pty?: Pty; term?: headless.Terminal } = { pty, term };
  typePrompt(w, 'a letter for a desk', true);
  w.pty = fakePty();
  await show(term, 'a letter for a desk');
  await sleep(400);
  assert.deepEqual(pty.sent, [PASTE('a letter for a desk')]);
  term.dispose();
});

test('Codex waits for the prompt to show on Windows, where it gets a paste as keystrokes', () => {
  assert.equal(codex.screen?.enterOnShown, process.platform === 'win32');
});
