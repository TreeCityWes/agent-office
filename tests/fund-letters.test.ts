import test from 'node:test';
import assert from 'node:assert/strict';
import { HeldLetters } from '../src/server/fund/office.js';
import type { WorkerStatus } from '../src/shared/protocol/workers.js';

test('a letter for an agent waiting on an answer in its terminal is held, and typed in once it has answered', () => {
  const MIN = 60_000;
  let now = 0;
  const status = new Map<string, WorkerStatus>([['a', 'working'], ['b', 'needs_input']]);
  const typed: { id: string; text: string; by: string }[] = [];
  const stuck: [string, number][] = [];
  const letters = new HeldLetters({
    status: (id) => status.get(id),
    type: (id, text, by) => void typed.push({ id, text, by }),
    stuck: (id, count) => void stuck.push([id, count]),
    now: () => now,
    every: 60 * MIN,
  });

  // Busy is fine: the agent's runtime queues the prompt. Only a question in its terminal holds a letter.
  assert.equal(letters.tell('a', 'Your thesis, please', 'Pixel'), undefined);
  assert.deepEqual(typed, [{ id: 'a', text: 'Your thesis, please', by: 'Pixel' }]);

  assert.equal(letters.tell('b', 'R-1 for you', 'Wes'), undefined);
  assert.equal(letters.tell('b', 'R-2 for you', 'Wes'), undefined);
  assert.equal(letters.waiting('b'), 2);
  letters.deliver();
  assert.equal(typed.length, 1, 'still asking: nothing typed into its question');

  // Ten minutes on, people hear of it, once.
  now += 10 * MIN;
  letters.deliver();
  letters.deliver();
  assert.deepEqual(stuck, [['b', 2]]);

  // Answered: a letter sent meanwhile goes behind the held ones, and they're typed in together, in order.
  status.set('b', 'working');
  letters.tell('b', 'From the CIO', 'Pixel');
  assert.equal(typed.length, 1);
  letters.deliver();
  assert.deepEqual(typed.slice(1), [{ id: 'b', text: 'R-1 for you\n\n---\n\nR-2 for you\n\n---\n\nFrom the CIO', by: '💼 The fund' }]);
  assert.equal(letters.waiting('b'), 0);

  // An agent that's gone home while its letters waited doesn't get them.
  status.set('b', 'needs_input');
  letters.tell('b', 'Lost', 'Wes');
  status.delete('b');
  letters.deliver();
  assert.equal(typed.length, 2);
  assert.equal(letters.waiting('b'), 0);
});
