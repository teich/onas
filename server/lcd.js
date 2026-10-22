// The frame for WTR's physical front LCD. wtr-lcd on WTR fetches it once a second
// (ops/host/README.md) and draws each dot as a 4 x 4 pixel cell on the 960 x 376 panel.
//
// It's drawn by drawLcd() from client/src/lib/lcd.ts, the same code as the Machine view's
// virtual screen, so the glass and the twin match. The client build bundles it for Node
// (client `npm run build:lcd` -> server/lcd-render.cjs, run by deploy); without that file the
// endpoint answers 503 and the panel shows its own fallback.
//
//   GET /api/lcd/frame -> 240 x 94 pixels, RGB, row by row, no header (67,680 bytes)
const { buildState } = require('./state');

const COLS = 240;
const ROWS = 94;

let renderer; // undefined: not loaded yet; null: not in this build
function loadRenderer() {
  if (renderer === undefined) {
    try {
      renderer = require('./lcd-render.cjs');
    } catch (err) {
      console.error(`lcd: no renderer (${err.message})`);
      renderer = null;
    }
  }
  return renderer;
}

// drawLcd only sets #rrggbb colours; anything else draws black rather than failing the frame.
const colors = new Map();
function parseColor(style) {
  let c = colors.get(style);
  if (!c) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(style));
    const v = m ? parseInt(m[1], 16) : 0;
    c = [v >> 16, (v >> 8) & 255, v & 255];
    colors.set(style, c);
  }
  return c;
}

// The smallest context drawLcd needs (lcd.ts LcdContext), drawing into an RGB buffer.
function renderFrame(state, now) {
  const px = Buffer.alloc(COLS * ROWS * 3);
  const ctx = {
    fillStyle: '#000000',
    imageSmoothingEnabled: false,
    fillRect(x, y, w, h) {
      const x0 = Math.max(0, Math.round(x)), x1 = Math.min(COLS, Math.round(x + w));
      const y0 = Math.max(0, Math.round(y)), y1 = Math.min(ROWS, Math.round(y + h));
      if (x1 <= x0 || y1 <= y0) return;
      const [r, g, b] = parseColor(this.fillStyle);
      for (let row = y0; row < y1; row++) {
        for (let i = (row * COLS + x0) * 3, end = (row * COLS + x1) * 3; i < end; i += 3) {
          px[i] = r; px[i + 1] = g; px[i + 2] = b;
        }
      }
    },
  };
  loadRenderer().drawLcd(ctx, COLS, ROWS, state, now);
  return px;
}

function frame(req, res) {
  if (!loadRenderer()) return res.status(503).json({ error: 'this build has no LCD renderer' });
  let px;
  try {
    px = renderFrame(buildState(), Date.now());
  } catch (err) {
    console.error(`lcd: ${err.stack || err.message}`);
    return res.status(500).json({ error: err.message });
  }
  res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Lcd-Size': `${COLS}x${ROWS}` });
  res.send(px);
}

module.exports = { frame, renderFrame, COLS, ROWS };
