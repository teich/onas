// The front LCD of the twin: a status panel drawn at exactly cols × rows pixels, one pixel per
// dot of the model's screen grid. Everything is crisp, pixel-aligned fillRects in a small
// bitmap font, so nothing depends on font rendering or anti-aliasing and the result is the
// same in any canvas (and in a test harness with nothing but a fillRect).
//
//   drawLcd(ctx, cols, rows, state, now)
//
// Layout (for cols ≈ 240, rows ≈ 100–140; everything is placed from the edges, so other sizes work):
//
//   WTR •                          THU 22 OCT  14:07
//   ─────────────────────────────────────────────────
//   CPU          19%  63°C         BULK          58%
//   ▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯        ▮▮▮▮▮▮▮▮▮▮▮▮▮▯▯▯▯
//   MEM       35.1/60.6G           FAST          18%
//   ▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯▯        ▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯▯
//   NET  LAN1              2.5G    BAYS
//   ↓ 222K    ↑ 3.2M               █ ▄ ▁ ▁ ▁ ▁   (busy %, one bar per bay)
//                                  1 2 3 4 5 6
//   ● ALL SYSTEMS NORMAL                  UP 1D 2H
//
// Colour: the app's palette. Status colours appear only where something is wrong (the footer
// band and the digit of the bay concerned); pools wear their pool colour; the network arrows
// use the Traffic lens's cool / warm.
import type { DashboardState, HardwareNic } from './types';
import { buildSlots, hardwareStatus, heatT, TOWARD_CPU_CSS, AWAY_FROM_CPU_CSS, type Slot } from './machineLens';
import { heatColor, poolColor, STATUS, type StatusLevel } from './palette';

// The little we need from a 2D context: a test harness can implement just this.
export type LcdContext = Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect' | 'imageSmoothingEnabled'>;

// ---------- palette ----------

const INK = '#f0efec';
const INK2 = '#c3c2b7';
const MUTED = '#898781';
const DIM = '#55544f';
const BG = '#06080b';
const TRACK = '#171a20';
const RULE = '#1d2128';

const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
// Solid colour a fraction of the way from a to b (there is no alpha: every pixel is opaque).
function mix(a: string, b: string, t: number): string {
  const c = (i: number) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t).toString(16).padStart(2, '0');
  return `#${c(0)}${c(1)}${c(2)}`;
}

// ---------- bitmap fonts ----------

// 3×5 for labels and numbers (a few glyphs are wider). Rows are strings of 1 and 0.
const SMALL: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'], '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '001', '010', '010'], '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  A: ['010', '101', '111', '101', '101'], B: ['110', '101', '110', '101', '110'], C: ['011', '100', '100', '100', '011'],
  D: ['110', '101', '101', '101', '110'], E: ['111', '100', '110', '100', '111'], F: ['111', '100', '110', '100', '100'],
  G: ['011', '100', '101', '101', '011'], H: ['101', '101', '111', '101', '101'], I: ['111', '010', '010', '010', '111'],
  J: ['001', '001', '001', '101', '010'], K: ['101', '101', '110', '101', '101'], L: ['100', '100', '100', '100', '111'],
  M: ['10001', '11011', '10101', '10001', '10001'], N: ['1001', '1101', '1011', '1001', '1001'],
  O: ['010', '101', '101', '101', '010'], P: ['110', '101', '110', '100', '100'], Q: ['010', '101', '101', '110', '011'],
  R: ['110', '101', '110', '101', '101'], S: ['011', '100', '010', '001', '110'], T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'], V: ['101', '101', '101', '101', '010'], W: ['10001', '10001', '10101', '11011', '10001'],
  X: ['101', '101', '010', '101', '101'], Y: ['101', '101', '010', '010', '010'], Z: ['111', '001', '010', '100', '111'],
  '.': ['0', '0', '0', '0', '1'], ',': ['0', '0', '0', '1', '1'], ':': ['0', '1', '0', '1', '0'], '!': ['1', '1', '1', '0', '1'],
  '/': ['001', '001', '010', '100', '100'], '%': ['101', '001', '010', '100', '101'], '-': ['000', '000', '111', '000', '000'],
  '+': ['000', '010', '111', '010', '000'], '°': ['111', '101', '111', '000', '000'],
  '↓': ['010', '010', '010', '101', '010'], '↑': ['010', '101', '010', '010', '010'], ' ': ['00', '00', '00', '00', '00'],
};

// 5×7 for the hostname and the clock.
const LARGE: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'], '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['0', '0', '1', '0', '1', '0', '0'], ' ': ['00', '00', '00', '00', '00', '00', '00'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
};

type Font = Record<string, string[]>;

function glyph(font: Font, ch: string): string[] | null {
  return font[ch] ?? font[ch.toUpperCase()] ?? null;
}

function textWidth(s: string, font: Font = SMALL): number {
  let w = 0;
  for (const ch of s) w += (glyph(font, ch)?.[0].length ?? 3) + 1;
  return Math.max(0, w - 1);
}

// Draws s with its top-left at (x, y); returns the width. One pixel between glyphs.
function text(ctx: LcdContext, s: string, x: number, y: number, color: string, font: Font = SMALL): number {
  ctx.fillStyle = color;
  let cx = Math.round(x);
  for (const ch of s) {
    const g = glyph(font, ch);
    if (!g) { cx += 4; continue; }
    g.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] !== '1') continue;
        let run = 1;
        while (row[rx + run] === '1') run++;
        ctx.fillRect(cx + rx, Math.round(y) + ry, run, 1);
        rx += run - 1;
      }
    });
    cx += g[0].length + 1;
  }
  return cx - Math.round(x) - 1;
}

const textRight = (ctx: LcdContext, s: string, xRight: number, y: number, color: string, font: Font = SMALL) =>
  text(ctx, s, xRight - textWidth(s, font), y, color, font);

// ---------- shapes ----------

const rect = (ctx: LcdContext, x: number, y: number, w: number, h: number, color: string) => {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
};

// A bar of 2-pixel segments with a 1-pixel gap: reads as a row of LEDs on a dot matrix.
function segBar(ctx: LcdContext, x: number, y: number, w: number, h: number, frac: number, color: string) {
  const pitch = 3;
  const n = Math.max(1, Math.floor((w + 1) / pitch));
  const lit = frac > 0 ? Math.max(1, Math.round(Math.min(1, frac) * n)) : 0;
  const off = Math.floor((w - (n * pitch - 1)) / 2);
  for (let i = 0; i < n; i++) rect(ctx, x + off + i * pitch, y, 2, h, i < lit ? color : TRACK);
}

// Status icons as 5×5 pixel shapes, the same four the app's badges use (● ▲ ◆ ■).
const ICONS: Record<StatusLevel, string[]> = {
  good: ['01110', '11111', '11111', '11111', '01110'],
  warning: ['00100', '00100', '01110', '01110', '11111'],
  serious: ['00100', '01110', '11111', '01110', '00100'],
  critical: ['11111', '11111', '11111', '11111', '11111'],
};
function icon(ctx: LcdContext, level: StatusLevel, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ICONS[level].forEach((row, ry) => { for (let rx = 0; rx < 5; rx++) if (row[rx] === '1') ctx.fillRect(x + rx, y + ry, 1, 1); });
}

// ---------- content ----------

const RANK: Record<StatusLevel, number> = { good: 0, warning: 1, serious: 2, critical: 3 };

interface Alert { level: StatusLevel; text: string }

// Everything that needs attention, worst first: drive and sensor levels from the slot list (the
// same ones the Machine view shows), plus a pool that is not ONLINE.
function alerts(state: DashboardState, slots: Slot[]): Alert[] {
  const out: Alert[] = [];
  for (const p of state.pools) if (p.health !== 'ONLINE') out.push({ level: 'critical', text: `POOL ${p.name} ${p.health}` });
  for (const s of slots) if (s.level !== 'good') out.push({ level: s.level, text: `${s.name} ${s.note}` });
  return out.sort((a, b) => RANK[b.level] - RANK[a.level]);
}

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const two = (n: number) => String(n).padStart(2, '0');

// 1024-based like the rest of the app, but as short as it can be: 222K, 3.2M, 1.1G.
function compactRate(bps: number): string {
  if (bps < 1024) return '0';
  const units = ['K', 'M', 'G'];
  let v = bps / 1024, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(0) : v.toFixed(1)}${units[i]}`;
}

const gib = (bytes: number) => bytes / 1024 ** 3;

function linkSpeed(mbps: number | null): string {
  if (!mbps) return '';
  return mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`;
}

// The port to show: the fastest link that is up, else the first port.
function mainNic(state: DashboardState): HardwareNic | null {
  const nics = state.hardware?.nics ?? [];
  const up = nics.filter(n => n.up).sort((a, b) => (b.speedMbps ?? 0) - (a.speedMbps ?? 0));
  return up[0] ?? null;
}

function uptimeText(seconds: number | undefined): string {
  if (!seconds) return '';
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `UP ${d}D ${h}H` : h > 0 ? `UP ${h}H ${m}M` : `UP ${m}M`;
}

// Cut a line to fit `max` pixels, ending in ".." when it was cut.
function fit(s: string, max: number): string {
  if (textWidth(s) <= max) return s;
  let t = s;
  while (t.length > 1 && textWidth(`${t}..`) > max) t = t.slice(0, -1);
  return `${t.trimEnd()}..`;
}

// ---------- the panel ----------

export function drawLcd(ctx: LcdContext, cols: number, rows: number, state: DashboardState, now: number): void {
  ctx.imageSmoothingEnabled = false;
  rect(ctx, 0, 0, cols, rows, BG);

  const hw = hardwareStatus(state, now);
  const live = hw === 'ok';
  const host = state.host;
  const slots = buildSlots(state, null, now);
  const problems = hw === 'waiting' ? [] : alerts(state, slots);
  // The dot beside the hostname: the worst thing on the panel; stale data is itself a warning.
  const worst: StatusLevel = hw === 'stale' && !problems.length ? 'warning' : problems[0]?.level ?? 'good';
  const date = new Date(now);

  const M = 8;                    // side margin
  const right = cols - M;
  const gap = 12;                 // between the two columns
  const colW = Math.floor((cols - 2 * M - gap) / 2);
  const x0 = M, x1 = M + colW + gap;

  // ---- header: hostname and clock ----
  const headY = 6;
  const nameW = text(ctx, (host?.hostname ?? 'wtr').toUpperCase(), M, headY, INK, LARGE);
  icon(ctx, hw === 'waiting' ? 'good' : worst, M + nameW + 5, headY + 1, hw === 'waiting' ? DIM : worst === 'good' ? STATUS.good : STATUS[worst]);
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}`;
  // The colon blinks with the seconds; the digits never move because every glyph has a fixed width.
  const clockW = textWidth(clock, LARGE);
  let cx = right - clockW;
  for (const ch of clock) {
    if (ch === ':') { if (date.getSeconds() % 2 === 0) text(ctx, ch, cx, headY, INK, LARGE); else text(ctx, ch, cx, headY, DIM, LARGE); cx += 2; }
    else cx += text(ctx, ch, cx, headY, INK, LARGE) + 1;
  }
  textRight(ctx, `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`, right - clockW - 7, headY + 1, MUTED);
  rect(ctx, M, headY + 11, cols - 2 * M, 1, RULE);

  const top = headY + 17;         // first body row
  const footY = rows - 15;        // the status band
  // Rows of the left column are 16 apart; a taller panel spreads them out a little.
  const pitch = Math.min(22, 16 + Math.max(0, Math.floor((rows - 120) / 6)));

  // Label on the left, value on the right, a bar underneath.
  const meter = (x: number, y: number, w: number, label: string, value: string, valueColor: string, frac: number | null, barColor: string, swatch?: string) => {
    let lx = x;
    if (swatch) { rect(ctx, x, y, 2, 5, swatch); lx += 4; }
    text(ctx, label, lx, y, MUTED);
    textRight(ctx, value, x + w, y, valueColor);
    segBar(ctx, x, y + 8, w, 3, frac ?? 0, frac == null ? TRACK : barColor);
  };

  // ---- left column: CPU, memory, network ----
  const cpuPct = host?.cpu.pct ?? null;
  const cpuT = state.hardware?.cpu.tempC ?? null;
  const tempColor = !live || cpuT == null ? DIM : heatColor(heatT('cpu', cpuT) ?? 0);
  const tempText = cpuT == null ? '--°C' : `${Math.round(cpuT)}°C`;
  meter(x0, top, colW, 'CPU', cpuPct == null ? '--%' : `${Math.round(cpuPct)}%`, cpuPct == null ? DIM : INK, cpuPct == null ? null : cpuPct / 100, INK2);
  // Tctl sits between the label and the load figure.
  textRight(ctx, tempText, x0 + colW - textWidth(cpuPct == null ? '--%' : `${Math.round(cpuPct)}%`) - 6, top, tempColor);

  const mem = host?.mem;
  meter(x0, top + pitch, colW, 'MEM', mem ? `${gib(mem.usedBytes).toFixed(1)}/${gib(mem.totalBytes).toFixed(1)}G` : '--', mem ? INK : DIM, mem ? mem.usedBytes / mem.totalBytes : null, INK2);

  const nic = mainNic(state);
  const netY = top + pitch * 2;
  text(ctx, 'NET', x0, netY, MUTED);
  if (!live) {
    textRight(ctx, hw === 'waiting' ? '--' : 'NO DATA', x0 + colW, netY, DIM);
    text(ctx, '↓ --', x0, netY + 8, DIM);
    text(ctx, '↑ --', x0 + 54, netY + 8, DIM);
  } else if (!nic) {
    textRight(ctx, 'NO LINK', x0 + colW, netY, DIM);
    text(ctx, '↓ 0', x0, netY + 8, DIM);
    text(ctx, '↑ 0', x0 + 54, netY + 8, DIM);
  } else {
    const port = (nic.slot ?? nic.name).toUpperCase();
    text(ctx, port, x0 + textWidth('NET') + 5, netY, INK2);
    textRight(ctx, linkSpeed(nic.speedMbps), x0 + colW, netY, MUTED);
    text(ctx, '↓', x0, netY + 8, TOWARD_CPU_CSS);
    text(ctx, compactRate(nic.rxBps), x0 + 5, netY + 8, nic.rxBps >= 1024 ? INK : MUTED);
    text(ctx, '↑', x0 + 54, netY + 8, AWAY_FROM_CPU_CSS);
    text(ctx, compactRate(nic.txBps), x0 + 59, netY + 8, nic.txBps >= 1024 ? INK : MUTED);
  }

  // Hottest drive of each kind, against its own limit (the Heat lens's scale).
  const hottest = (kind: 'hdd' | 'nvme') => slots.filter(x => x.kind === kind && x.tempC != null && !x.tempStale).reduce<number | null>((m, x) => (m == null || x.tempC! > m ? x.tempC : m), null);
  const hddT = hottest('hdd'), nvmeT = hottest('nvme');
  const driveT = [hddT == null ? null : heatT('hdd', hddT), nvmeT == null ? null : heatT('nvme', nvmeT)].filter((t): t is number => t != null);
  const tMax = driveT.length ? Math.max(...driveT) : null;
  const tempOk = live && tMax != null;
  const drivesY = top + pitch * 3 + 3;
  if (drivesY + 11 <= footY - 2) meter(x0, drivesY, colW, 'DRIVES', tempOk ? `HDD ${hddT == null ? '--' : Math.round(hddT)} NVME ${nvmeT == null ? '--' : Math.round(nvmeT)}°C` : '--', tempOk ? INK : DIM, tempOk ? tMax : null, tempOk ? heatColor(tMax!) : TRACK);

  // ---- right column: pools and bay activity ----
  state.pools.slice(0, 2).forEach((pool, i) => {
    const frac = pool.size > 0 ? pool.alloc / pool.size : 0;
    const ok = pool.health === 'ONLINE';
    meter(x1, top + i * pitch, colW, pool.name.toUpperCase(), `${Math.round(frac * 100)}%`, ok ? INK : STATUS.critical, frac, poolColor(pool.name), poolColor(pool.name));
  });
  for (let i = state.pools.length; i < 2; i++) meter(x1, top + i * pitch, colW, '--', '--', DIM, null, TRACK);

  const baysY = top + pitch * 2;
  // On a short panel the bars take the heading's row; the digits under them say which bay is which.
  const tight = rows < 110;
  if (!tight) {
    text(ctx, 'BAYS', x1, baysY, MUTED);
    textRight(ctx, live ? 'BUSY' : hw === 'waiting' ? '--' : 'NO DATA', x1 + colW, baysY, live ? MUTED : DIM);
  }
  const bays = slots.filter(s => s.group === 'bays').slice(0, 6);
  const n = Math.max(1, bays.length);
  const bGap = 4;
  const bW = Math.floor((colW - (n - 1) * bGap) / n);
  const bTop = tight ? baysY : baysY + 8;
  const bH = Math.max(6, footY - 12 - bTop);   // the digits (5 px, 3 below the bar) end a couple of pixels above the footer
  bays.forEach((s, i) => {
    const bx = x1 + i * (bW + bGap);
    const color = s.pool ? poolColor(s.pool) : INK2;
    // Vertical bars in the same 2-pixel segments as the horizontal ones; the lit part is busy %.
    const segs = Math.max(1, Math.floor((bH + 1) / 3));
    const busy = live && !s.empty ? Math.min(1, Math.max(0, (s.disk?.busyPct ?? 0) / 100)) : 0;
    let lit = busy > 0 ? Math.max(1, Math.round(busy * segs)) : 0;
    // A working drive flickers by a segment each second, so the bars are never perfectly still.
    if (busy >= 0.03 && date.getSeconds() % 2 === 1) lit = Math.min(segs, lit + 1);
    const idleLit = live && !s.empty && lit === 0;
    for (let k = 0; k < segs; k++) {
      const y = bTop + bH - 2 - k * 3;
      const on = k < lit;
      rect(ctx, bx, y, bW, 2, s.empty ? (k === 0 ? DIM : TRACK) : on ? (k === lit - 1 ? mix(color, INK, 0.45) : color) : idleLit && k === 0 ? mix(TRACK, color, 0.45) : TRACK);
    }
    const label = String(i + 1);
    const lc = s.level === 'good' ? (s.empty ? DIM : MUTED) : STATUS[s.level];
    text(ctx, label, bx + Math.floor((bW - 3) / 2), bTop + bH + 3, lc);
  });

  // ---- footer: one status line ----
  const bandH = 11;
  const bandY = footY + 1;
  if (hw === 'waiting') {
    text(ctx, 'WAITING FOR HARDWARE COLLECTOR', M + 2, bandY + 3, DIM);
  } else if (hw === 'stale') {
    rect(ctx, M, bandY, cols - 2 * M, bandH, mix(BG, STATUS.warning, 0.16));
    rect(ctx, M, bandY, 2, bandH, STATUS.warning);
    icon(ctx, 'warning', M + 6, bandY + 3, STATUS.warning);
    text(ctx, 'HARDWARE DATA STALE', M + 15, bandY + 3, STATUS.warning);
    textRight(ctx, problems.length ? '' : uptimeText(host?.uptimeSeconds), right - 3, bandY + 3, MUTED);
  } else if (problems.length) {
    const p = problems[0];
    const color = STATUS[p.level];
    rect(ctx, M, bandY, cols - 2 * M, bandH, mix(BG, color, 0.16));
    rect(ctx, M, bandY, 2, bandH, color);
    icon(ctx, p.level, M + 6, bandY + 3, color);
    const more = problems.length > 1 ? `+${problems.length - 1}` : '';
    const room = cols - 2 * M - 15 - 4 - (more ? textWidth(more) + 6 : 0);
    text(ctx, fit(p.text, room), M + 15, bandY + 3, color);
    if (more) textRight(ctx, more, right - 3, bandY + 3, INK2);
  } else {
    icon(ctx, 'good', M + 2, bandY + 3, STATUS.good);
    text(ctx, 'ALL SYSTEMS NORMAL', M + 11, bandY + 3, INK2);
    textRight(ctx, uptimeText(host?.uptimeSeconds), right, bandY + 3, MUTED);
  }
}
