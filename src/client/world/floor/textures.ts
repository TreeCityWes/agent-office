import { shade } from '../station/kit';
import { seeded } from '../station/textures';

// The pictures the trading floor is painted with: its carpet tiles and ceiling, the towers outside,
// what the desks' own monitors show (the big displays are painted live by the 💼 fund, see
// features/fund/floor.ts), and what a big display shows until it does.

/** Carpet tiles, half a meter square, laid in alternate directions. One tile of the texture is 2 m square. */
export function carpet(color: string): (g: CanvasRenderingContext2D) => void {
  return (g) => {
    const S = 512;
    const rand = seeded(7);
    g.fillStyle = color;
    g.fillRect(0, 0, S, S);
    const q = S / 4;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        g.fillStyle = (i + j) % 2 ? shade(color, 0.018) : shade(color, -0.012);
        g.fillRect(i * q, j * q, q, q);
        // The pile's grain, across the tile one way or the other.
        g.strokeStyle = shade(color, (i + j) % 2 ? 0.035 : -0.03);
        g.lineWidth = 1;
        for (let k = 4; k < q; k += 6) {
          g.beginPath();
          if ((i + j) % 2) {
            g.moveTo(i * q + k, j * q + 2);
            g.lineTo(i * q + k, j * q + q - 2);
          } else {
            g.moveTo(i * q + 2, j * q + k);
            g.lineTo(i * q + q - 2, j * q + k);
          }
          g.stroke();
        }
      }
    }
    for (let k = 0; k < 2400; k++) {
      g.fillStyle = rand() < 0.5 ? shade(color, 0.06) : shade(color, -0.05);
      g.fillRect(rand() * S, rand() * S, 1.5, 1.5);
    }
  };
}

/** The ceiling: acoustic tiles in a grid of thin rails. One tile of the texture is 2.4 m square, four tiles across. */
export function ceilingTiles(color: string): (g: CanvasRenderingContext2D) => void {
  return (g) => {
    const S = 256;
    const rand = seeded(11);
    g.fillStyle = color;
    g.fillRect(0, 0, S, S);
    for (let k = 0; k < 900; k++) {
      g.fillStyle = shade(color, -0.04 - rand() * 0.04);
      g.fillRect(rand() * S, rand() * S, 1.2, 1.2);
    }
    g.fillStyle = shade(color, -0.18);
    for (let i = 0; i < 4; i++) {
      g.fillRect(i * (S / 4), 0, 2, S);
      g.fillRect(0, i * (S / 4), S, 2);
    }
  };
}

/** A wall's dark panelling, for the walls the screens hang on. One tile is 3 m square. */
export function wallPanels(color: string): (g: CanvasRenderingContext2D) => void {
  return (g) => {
    const S = 256;
    g.fillStyle = color;
    g.fillRect(0, 0, S, S);
    g.fillStyle = shade(color, -0.05);
    g.fillRect(0, 0, S, 3);
    g.fillRect(S / 2 - 1, 0, 2, S);
    g.fillRect(0, 0, 2, S);
    g.fillStyle = shade(color, 0.03);
    g.fillRect(3, 3, S / 2 - 5, 2);
    g.fillRect(S / 2 + 2, 3, S / 2 - 5, 2);
  };
}

/**
 * A tower's face, four bays across and four storeys up to the tile (12 m square): glass between
 * mullions by day; by night, dark, with the odd office still lit.
 */
export function facade(seed: number, night: boolean, glass: string): (g: CanvasRenderingContext2D) => void {
  return (g) => {
    const S = 256;
    const rand = seeded(seed);
    g.fillStyle = night ? '#0b0f16' : shade(glass, -0.18);
    g.fillRect(0, 0, S, S);
    const bay = S / 4;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const x = i * bay + 4;
        const y = j * bay + 7;
        if (night) {
          const on = rand() < 0.32;
          g.fillStyle = on ? (rand() < 0.7 ? '#ffd88a' : '#cfe6ff') : rand() < 0.5 ? '#141c28' : '#101722';
        } else {
          const k = rand() * 0.12 - 0.04;
          g.fillStyle = shade(glass, k);
        }
        g.fillRect(x, y, bay - 8, bay - 12);
        if (!night) {
          // A streak of the sky in the glass.
          g.fillStyle = 'rgba(255, 255, 255, 0.16)';
          g.beginPath();
          g.moveTo(x, y + bay * 0.55);
          g.lineTo(x + bay * 0.35, y);
          g.lineTo(x + bay * 0.5, y);
          g.lineTo(x, y + bay * 0.8);
          g.fill();
        }
      }
    }
  };
}

const TICKERS = ['BTC', 'ETH', 'SOL', 'SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT', 'TLT', 'GLD', 'XLE', 'EURUSD'];

/**
 * What a trader's monitor shows, `w` by `h` pixels: candles, a line chart, an order book or a grid of
 * quotes, by `seed`. Made up, and only ever this: what the fund really holds is on the big displays.
 */
export function monitor(seed: number, w: number, h: number): (g: CanvasRenderingContext2D) => void {
  return (g) => {
    const rand = seeded(seed * 131 + 7);
    g.fillStyle = '#05080d';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffb000';
    g.font = `700 ${Math.round(h * 0.1)}px ui-monospace, Menlo, monospace`;
    g.textBaseline = 'top';
    g.fillText(`${TICKERS[seed % TICKERS.length]} <EQUITY> GP`, 6, 4);
    const top = h * 0.18;
    const kind = seed % 4;
    if (kind === 0) {
      // Candles.
      let p = h * 0.55;
      const n = 22;
      const cw = (w - 12) / n;
      for (let i = 0; i < n; i++) {
        const o = p;
        p = Math.min(h - 10, Math.max(top + 6, p + (rand() - 0.5) * h * 0.14));
        const hi = Math.min(o, p) - rand() * h * 0.05;
        const lo = Math.max(o, p) + rand() * h * 0.05;
        g.fillStyle = g.strokeStyle = p < o ? '#22c55e' : '#ef4444';
        g.fillRect(6 + i * cw + cw / 2 - 0.5, hi, 1, lo - hi);
        g.fillRect(6 + i * cw + 1, Math.min(o, p), cw - 2, Math.max(1, Math.abs(p - o)));
      }
    } else if (kind === 1) {
      // A line, filled under.
      g.strokeStyle = '#38bdf8';
      g.lineWidth = 2;
      g.fillStyle = 'rgba(56, 189, 248, 0.15)';
      g.beginPath();
      let y = h * 0.6;
      g.moveTo(6, h);
      for (let x = 6; x <= w - 6; x += 6) {
        y = Math.min(h - 8, Math.max(top + 4, y + (rand() - 0.48) * h * 0.08));
        g.lineTo(x, y);
      }
      g.lineTo(w - 6, h);
      g.fill();
      g.stroke();
    } else if (kind === 2) {
      // An order book: bids in green, offers in red, depth bars behind them.
      const rows = 8;
      const rh = (h - top - 4) / rows;
      g.font = `600 ${Math.round(rh * 0.6)}px ui-monospace, Menlo, monospace`;
      for (let i = 0; i < rows; i++) {
        const bid = i >= rows / 2;
        g.fillStyle = bid ? 'rgba(34, 197, 94, 0.22)' : 'rgba(239, 68, 68, 0.22)';
        g.fillRect(w - 6 - rand() * w * 0.6, top + i * rh + 1, w * 0.6, rh - 2);
        g.fillStyle = bid ? '#4ade80' : '#f87171';
        g.fillText((100 + (rows - i) * 0.05 + rand() * 0.01).toFixed(2), 8, top + i * rh + rh * 0.2);
        g.fillStyle = '#cbd5e1';
        g.fillText(String(Math.round(rand() * 900 + 100)), w * 0.55, top + i * rh + rh * 0.2);
      }
    } else {
      // A grid of quotes, up and down.
      const rows = 6;
      const rh = (h - top - 4) / rows;
      g.font = `700 ${Math.round(rh * 0.55)}px ui-monospace, Menlo, monospace`;
      for (let i = 0; i < rows; i++) {
        const up = rand() < 0.55;
        g.fillStyle = '#e2e8f0';
        g.fillText(TICKERS[(seed + i) % TICKERS.length], 8, top + i * rh + rh * 0.2);
        g.fillStyle = up ? '#22c55e' : '#ef4444';
        g.fillText(`${up ? '▲' : '▼'}${(rand() * 3).toFixed(2)}%`, w * 0.5, top + i * rh + rh * 0.2);
      }
    }
  };
}

/** A big display before the fund's painted it: its name, and how to bring it up. */
export function idleDisplay(title: string, w: number, h: number): (g: CanvasRenderingContext2D) => void {
  return (g) => {
    g.fillStyle = '#070b12';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255, 176, 0, 0.12)';
    g.lineWidth = 1;
    for (let x = 0; x < w; x += 32) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let y = 0; y < h; y += 32) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffb000';
    g.font = `800 ${Math.round(h * 0.11)}px ui-monospace, Menlo, monospace`;
    g.fillText(title, w / 2, h * 0.42);
    g.fillStyle = '#8b98a9';
    g.font = `600 ${Math.round(h * 0.055)}px system-ui, sans-serif`;
    g.fillText('Waiting for the 💼 fund…', w / 2, h * 0.6);
  };
}

/** The ticker band before the fund's painted it: the floor's name, running along. */
export function idleTicker(w: number, h: number): (g: CanvasRenderingContext2D) => void {
  return (g) => {
    g.fillStyle = '#050505';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffb000';
    g.font = `800 ${Math.round(h * 0.6)}px ui-monospace, Menlo, monospace`;
    g.textBaseline = 'middle';
    const text = '📈 TRADING FLOOR  ·  PAPER TRADING  ·  ';
    const step = g.measureText(text).width;
    for (let x = 0; x < w; x += step) g.fillText(text, x, h / 2);
  };
}
