import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_TVS, checkTvChannel, cleanTvLabel, type TvScreen, type TvWallState } from '../shared/tvwall.js';

/** Screen ids look like this (each map says which of them it has: see shared/tvwall.ts). */
const TV_ID = /^tv-\d{1,2}$/;

/**
 * The screens up over the boards on one floor, saved in .agent-office/tvwall.json: what's on each.
 * Every browser on the floor loads it for itself.
 */
export class TvWall {
  private screens: Record<string, TvScreen> = structuredClone(DEFAULT_TVS);
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'tvwall.json');
    this.load();
  }

  state(): TvWallState {
    return { screens: this.screens };
  }

  /** Tunes screen `tv` to `channel`, captioned `label`. Says what's on now, or why it can't. */
  set(tv: unknown, channel: unknown, label: unknown, by: string): TvScreen | { error: string } {
    if (typeof tv !== 'string' || !TV_ID.test(tv)) return { error: 'There is no such screen' };
    const c = checkTvChannel(channel);
    if ('error' in c) return c;
    const caption = cleanTvLabel(label);
    const screen: TvScreen = { channel: c.channel, ...(caption ? { label: caption } : {}), by };
    this.screens = { ...this.screens, [tv]: screen };
    this.save();
    return screen;
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { screens?: Record<string, Partial<TvScreen>> };
      const screens: Record<string, TvScreen> = {};
      for (const [id, s] of Object.entries(saved.screens ?? {})) {
        const c = checkTvChannel(s?.channel);
        if (!TV_ID.test(id) || 'error' in c) continue;
        const label = cleanTvLabel(s.label);
        screens[id] = { channel: c.channel, ...(label ? { label } : {}), ...(typeof s.by === 'string' ? { by: s.by.slice(0, 64) } : {}) };
      }
      this.screens = screens;
    } catch {
      // a broken file just means the screens show what they start with
    }
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify({ screens: this.screens }, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }
}
