// Typing a prompt into an agent's input box: pasted whole, so a multi-line prompt stays one message,
// then Enter to submit it.
import type { Pty } from '../ptys.js';
import { screenText, type HeadlessTerminal } from './terminal.js';

/** How long after the paste Enter follows, ms. */
const ENTER_AFTER_MS = 120;
/** How long the whole prompt must have shown before Enter, for an agent that waits for it, ms. */
const SHOWN_FOR_MS = 250;
const LOOK_EVERY_MS = 50;
/** The longest it waits for the prompt to show before pressing Enter anyway, ms. */
const GIVE_UP_MS = 30_000;

/** The end of a prompt as it shows on screen, wrapped however: its last characters that aren't spaces. */
function ending(text: string): string {
  return text.replace(/\s+/g, '').slice(-32);
}

function count(term: HeadlessTerminal, needle: string): number {
  return screenText(term).replace(/\s+/g, '').split(needle).length - 1;
}

/**
 * Pastes `text` into the agent's terminal and presses Enter. With `onShown`, Enter waits until the
 * prompt has shown on its screen: an agent that gets a paste as keystrokes (Codex on Windows) takes
 * them in at its own pace and counts an Enter that comes right after the last as part of the paste.
 * Its end showing once more than it did (an earlier letter can end the same way, and scroll off)
 * says the paste is in.
 */
export function typePrompt(w: { pty?: Pty; term?: HeadlessTerminal }, text: string, onShown = false): void {
  const { pty, term } = w;
  if (!pty) return;
  pty.write(`\x1b[200~${text}\x1b[201~`);
  if (!onShown || !term) {
    setTimeout(() => w.pty?.write('\r'), ENTER_AFTER_MS);
    return;
  }
  const needle = ending(text);
  const start = Date.now();
  let low = count(term, needle);
  let shownAt = 0;
  const timer = setInterval(() => {
    // It stopped, or started over: what was pasted is gone.
    if (w.pty !== pty || w.term !== term) return clearInterval(timer);
    const now = Date.now();
    const seen = count(term, needle);
    if (seen > low) shownAt ||= now;
    else low = Math.min(low, seen);
    if ((shownAt && now - shownAt >= SHOWN_FOR_MS) || now - start >= GIVE_UP_MS) {
      clearInterval(timer);
      pty.write('\r');
    }
  }, LOOK_EVERY_MS);
  timer.unref();
}
