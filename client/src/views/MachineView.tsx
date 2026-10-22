// The front page: WTR as a live point cloud, and the answers Proxmox never gives: which bay
// holds which disk, is it healthy, how hot is everything, what is moving data right now.
// The scene is the picture; the slot list beside it is the same information as text, and works
// without WebGPU or the model.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardState } from '../lib/types';
import { MachineScene } from '../viz/machine/MachineScene';
import { loadMachineModel } from '../viz/machine/model';
import type { MachineModel } from '../viz/machine/types';
import { StatusBadge, Meter } from '../components/ui';
import { fmtRate } from '../lib/format';
import { heatGradient, poolColor } from '../lib/palette';
import { fmtDriveSize, prettyModel } from '../lib/diskHealth';
import {
  AWAY_FROM_CPU_CSS, HEAT_RANGE, LENSES, TOWARD_CPU_CSS, buildSlots, hardwareStatus, lensScene, poolSummary, rateLevel, FLOW_FLOOR_BPS,
  type HardwareStatus, type Lens, type Slot, type SlotGroup,
} from '../lib/machineLens';
import { drawLcd } from '../lib/lcd';
import { MachineDetail } from './MachineDetail';

const CPU_NAME = 'Ryzen 7 PRO 8845HS';

// ---------- small hooks ----------

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

interface ModelState {
  model: MachineModel | null;
  error: string | null;
  placeholder: boolean;
}

// Loads /wtr-max. While the real model is still being built, a dev server falls back to the
// stand-in so the view can be worked on; a production build never does.
function useMachineModel(): ModelState {
  const [state, setState] = useState<ModelState>({ model: null, error: null, placeholder: false });
  useEffect(() => {
    let cancelled = false;
    loadMachineModel('/wtr-max')
      .then(model => { if (!cancelled) setState({ model, error: null, placeholder: false }); })
      .catch(async (err: Error) => {
        if (import.meta.env.DEV) {
          try {
            const model = await loadMachineModel('/lab/placeholder');
            if (!cancelled) setState({ model, error: null, placeholder: true });
            return;
          } catch { /* report the original failure */ }
        }
        if (!cancelled) setState({ model: null, error: err.message, placeholder: false });
      });
    return () => { cancelled = true; };
  }, []);
  return state;
}

function slotFromHash(): string | null {
  const [path, query = ''] = window.location.hash.replace(/^#\/?/, '').split('?');
  return path === 'machine' ? new URLSearchParams(query).get('slot') : null;
}

// ---------- slot list ----------

const GROUPS: Array<{ id: SlotGroup; title: string }> = [
  { id: 'bays', title: '3.5″ bays' },
  { id: 'm2', title: 'M.2' },
  { id: 'other', title: 'Other drives' },
  { id: 'net', title: 'Network' },
  { id: 'host', title: 'Processor and memory' },
];

const deg = (t: number | null) => (t == null ? '' : `${Math.round(t)}°C`);

function linkLabel(mbps: number | null | undefined): string {
  if (!mbps) return 'up';
  return mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`;
}

function RateText({ slot }: { slot: Slot }) {
  if (!slot.live) return <span className="muted">no data</span>;
  const [a, b] = slot.kind === 'nic' ? ['rx', 'tx'] : ['R', 'W'];
  const r = slot.readBps >= FLOW_FLOOR_BPS, w = slot.writeBps >= FLOW_FLOOR_BPS;
  if (!r && !w) return <span className="muted">{slot.disk?.standby ? 'asleep' : 'idle'}</span>;
  return (
    <span className="slot-rate">
      {r && <span><i style={{ color: TOWARD_CPU_CSS }}>{a}</i> {fmtRate(slot.readBps)}</span>}
      {w && <span><i style={{ color: AWAY_FROM_CPU_CSS }}>{b}</i> {fmtRate(slot.writeBps)}</span>}
    </span>
  );
}

function SlotRow({ slot, state, waiting, hovered, selected, onHover, onSelect }: {
  slot: Slot;
  state: DashboardState;
  waiting: boolean;
  hovered: boolean;
  selected: boolean;
  onHover(key: string | null): void;
  onSelect(key: string): void;
}) {
  // Until the hardware collector has reported, a bay can't be called empty.
  const unknown = waiting && slot.group !== 'host';
  const empty = slot.empty && !unknown;
  const idle = empty || unknown || (slot.kind === 'nic' && !slot.nic?.up);
  const pooled = slot.pool != null;
  const color = slot.pool ? poolColor(slot.pool) : undefined;
  const bar = slot.kind === 'cpu' ? slot.activity : rateLevel(Math.max(slot.readBps, slot.writeBps), slot.fullBps);
  const device = slot.disk
    ? `${slot.disk.name} · ${slot.smart ? prettyModel(slot.smart.model) : slot.disk.kind.toUpperCase()}${slot.smart ? ` · ${fmtDriveSize(slot.smart.size)}` : ''}`
    : slot.nic ? `${slot.nic.name} · ${slot.nic.kind}`
    : slot.kind === 'cpu' ? `${CPU_NAME} · ${state.host?.cpu.cores ?? '?'} threads`
    : slot.kind === 'ram' ? 'SO-DIMM' : '';
  const noPoolLabel = slot.smart?.used && /BIOS|EFI|LVM|boot/i.test(slot.smart.used) ? 'system' : 'no pool';
  return (
    <button
      type="button"
      data-slot={slot.key}
      className={`slot-row${idle ? ' idle' : ''}${hovered ? ' hover' : ''}${selected ? ' on' : ''}`}
      onMouseEnter={() => onHover(slot.key)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(slot.key)}
      onBlur={() => onHover(null)}
      onClick={() => onSelect(slot.key)}
    >
      <span className="slot-name">{slot.name}</span>
      <span className="slot-main">
        {unknown && <span className="muted">waiting for data</span>}
        {empty && <span className="muted">empty</span>}
        {!unknown && slot.disk && (
          <span className="pool-chip" style={{ '--pool': color } as React.CSSProperties} data-none={!pooled || undefined}>
            <i />{pooled ? slot.pool : noPoolLabel}
          </span>
        )}
        {!unknown && slot.kind === 'nic' && (slot.nic?.up ? <span className="link-chip">{linkLabel(slot.nic.speedMbps)}</span> : <span className="muted">no link</span>)}
        {!unknown && slot.level !== 'good' && <StatusBadge level={slot.level}>{slot.note}</StatusBadge>}
      </span>
      <span className="slot-temp" style={slot.tempStale ? { color: 'var(--muted)', opacity: 0.75 } : undefined} title={slot.tempStale ? `last known: ${slot.tempNote}` : undefined}>{deg(slot.tempC)}</span>
      {!empty && !unknown && (
        <span className="slot-sub">
          <span className="slot-device" title={device}>{device}</span>
          {slot.kind !== 'ram' && !idle && (
            <span className="slot-live">
              {slot.kind === 'cpu'
                ? <span className="muted">{slot.live && state.host ? `${Math.round(state.host.cpu.pct)}% busy` : 'no data'}</span>
                : <RateText slot={slot} />}
              <Meter value={bar} max={1} color={color ?? 'var(--ink-2)'} label="activity" />
            </span>
          )}
        </span>
      )}
    </button>
  );
}

function SlotList({ slots, state, hovered, selected, onHover, onSelect, hw }: {
  slots: Slot[];
  state: DashboardState;
  hovered: string | null;
  selected: string | null;
  onHover(key: string | null): void;
  onSelect(key: string): void;
  hw: HardwareStatus;
}) {
  return (
    <section className="slot-list" aria-label="Slots">
      {hw === 'waiting' && <p className="muted slot-wait">Waiting for the hardware collector. Drives and ports appear once it has reported.</p>}
      {GROUPS.map(g => {
        const rows = slots.filter(s => s.group === g.id);
        if (!rows.length) return null;
        return (
          <div key={g.id} className="slot-group">
            <h3>{g.title}</h3>
            {rows.map(s => (
              <SlotRow key={s.key} slot={s} state={state} waiting={hw === 'waiting'}
                hovered={hovered === s.key} selected={selected === s.key} onHover={onHover} onSelect={onSelect} />
            ))}
          </div>
        );
      })}
    </section>
  );
}

// ---------- stage legends ----------

function Legend({ lens, slots }: { lens: Lens; slots: Slot[] }) {
  if (lens === 'drives') {
    const pools = [...new Set(slots.map(s => s.pool).filter((p): p is string => !!p))];
    const hasSystem = slots.some(s => s.disk && !s.pool);
    return (
      <div className="machine-legend">
        {pools.map(p => <span key={p}><i className="swatch" style={{ background: poolColor(p) }} />{p}</span>)}
        {hasSystem && <span><i className="swatch" style={{ background: '#f0efec' }} />system disk</span>}
        <span><i className="swatch ghost" />empty slot</span>
        {slots.some(s => s.level !== 'good') && <span className="muted">pulsing = needs attention</span>}
      </div>
    );
  }
  if (lens === 'heat') {
    return (
      <div className="machine-legend heat">
        <span className="heat-ramp"><span>cool</span><i style={{ background: heatGradient() }} /><span>at its limit</span></span>
        <span className="muted" title={`Cool to limit, °C: HDD ${HEAT_RANGE.hdd.join('–')}, NVMe ${HEAT_RANGE.nvme.join('–')}, CPU ${HEAT_RANGE.cpu.join('–')}, RAM ${HEAT_RANGE.ram.join('–')}`}>
          each part is measured against its own limit
        </span>
      </div>
    );
  }
  return (
    <div className="machine-legend">
      <span><i className="swatch line" style={{ background: TOWARD_CPU_CSS }} />toward the CPU (reads, rx)</span>
      <span><i className="swatch line" style={{ background: AWAY_FROM_CPU_CSS }} />away from it (writes, tx)</span>
      <span className="muted">denser = more data, log scale</span>
    </div>
  );
}

// ---------- the view ----------

export function MachineView({ state, params }: { state: DashboardState; params: URLSearchParams }) {
  const now = useNow(5000);
  const { model, error: modelError, placeholder } = useMachineModel();
  const [lens, setLens] = useState<Lens>('drives');
  const [exploded, setExploded] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selectedRaw, setSelected] = useState<string | null>(() => params.get('slot'));
  const sideRef = useRef<HTMLElement>(null);
  useEffect(() => { window.scrollTo(0, 0); }, []);   // arriving from a link further down another tab

  const slots = useMemo(() => buildSlots(state, model, now), [state, model, now]);
  const hw = hardwareStatus(state, now);

  // A ?slot= that names nothing we know is ignored rather than showing an empty card.
  const selected = selectedRaw && (slots.some(s => s.key === selectedRaw) || (model ? model.byKey.has(selectedRaw) : false)) ? selectedRaw : null;

  // #/machine?slot=bay3 <-> selection. replaceState, so browsing around the machine adds no history.
  useEffect(() => {
    const wanted = `#/machine${selected ? `?slot=${encodeURIComponent(selected)}` : ''}`;
    if (window.location.hash !== wanted && (window.location.hash.startsWith('#/machine') || window.location.hash === '')) {
      window.history.replaceState(null, '', wanted);
    }
  }, [selected]);
  useEffect(() => {
    const onHash = () => {
      const [path] = window.location.hash.replace(/^#\/?/, '').split('?');
      if (path === 'machine') setSelected(slotFromHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // The scene selects through here. A card opened from the list takes focus (the row it replaces
  // is gone) and hands it back to that row when it closes, so the keyboard doesn't lose its place.
  const openedFromList = useRef<string | null>(null);
  const select = useCallback((key: string | null) => {
    openedFromList.current = null;
    setSelected(prev => (key === 'shell' ? null : key === prev ? null : key));
  }, []);
  const selectFromList = useCallback((key: string) => {
    openedFromList.current = key;
    setSelected(key);
  }, []);
  const close = useCallback(() => { setSelected(null); setHovered(null); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const side = sideRef.current;
    if (selected) side?.scrollTo?.({ top: 0 });
    const key = openedFromList.current;
    if (!key) return;
    if (selected === key) side?.querySelector<HTMLElement>('.mdetail-head button')?.focus();
    else if (!selected) {
      openedFromList.current = null;
      side?.querySelector<HTMLElement>(`[data-slot="${key}"]`)?.focus();
    }
  }, [selected]);

  // The front LCD: a canvas of manifest.screen.cols × rows pixels, redrawn on every state change
  // and once a second (the clock), then handed to the scene with a version it re-uploads on.
  const lcdCols = model?.manifest.screen?.cols ?? 0;
  const lcdRows = model?.manifest.screen?.rows ?? 0;
  const lcdCanvas = useMemo(() => {
    if (!lcdCols || !lcdRows) return null;
    const canvas = document.createElement('canvas');
    canvas.width = lcdCols;
    canvas.height = lcdRows;
    return canvas;
  }, [lcdCols, lcdRows]);
  const [lcdVersion, setLcdVersion] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const ctx = lcdCanvas?.getContext('2d');
    if (!lcdCanvas || !ctx) return;
    const draw = () => {
      drawLcd(ctx, lcdCanvas.width, lcdCanvas.height, stateRef.current, Date.now());
      setLcdVersion(v => v + 1);
    };
    draw();
    const id = setInterval(draw, 1000);
    return () => clearInterval(id);
  }, [lcdCanvas, state]);
  const screen = useMemo(() => (lcdCanvas ? { canvas: lcdCanvas, version: lcdVersion } : undefined), [lcdCanvas, lcdVersion]);

  const scene = useMemo(
    () => (model ? lensScene(state, model, lens, selected, hovered, now, slots) : null),
    [state, model, lens, selected, hovered, now, slots],
  );

  const selectedSlot = selected ? slots.find(s => s.key === selected) ?? null : null;
  const summary = ['AOOSTAR WTR MAX', CPU_NAME, ...poolSummary(state)];
  const hwFailing = state.collectors.hardware?.ok === false ? state.collectors.hardware.error : null;

  return (
    <div className="view machine">
      <div className="machine-stage">
        <div className="machine-canvas">
          {model && scene && (
            <MachineScene
              model={model}
              visuals={scene.visuals}
              defaultVisual={scene.defaultVisual}
              flows={scene.flows}
              labels={scene.labels}
              exploded={exploded}
              xray={scene.xray}
              selected={selected}
              hovered={hovered}
              onHover={setHovered}
              onSelect={select}
              resetToken={resetToken}
              screen={screen}
              className="machine-scene-fill"
              ariaLabel="WTR, shown as a live point cloud. The slot list beside it has the same information as text."
            />
          )}
          {!model && (
            <div className="machine-msg">
              {modelError
                ? <><strong>The 3D model isn’t available.</strong><span>{modelError}</span><span className="muted">The slot list still shows every drive, port and sensor.</span></>
                : <span className="muted">Loading the model…</span>}
            </div>
          )}
        </div>

        <div className="machine-top">
          <div className="segmented machine-lens" role="group" aria-label="Lens">
            {LENSES.map(l => (
              <button key={l.id} className={lens === l.id ? 'on' : ''} aria-pressed={lens === l.id} onClick={() => setLens(l.id)}>{l.label}</button>
            ))}
          </div>
          <div className="machine-actions">
            <button className={`machine-btn${exploded ? ' on' : ''}`} aria-pressed={exploded} onClick={() => setExploded(e => !e)} disabled={!model}>Exploded</button>
            <button className="machine-btn" onClick={() => setResetToken(t => t + 1)} disabled={!model}>Reset view</button>
          </div>
        </div>

        {hw !== 'ok' && (
          <div className="machine-badge">
            {hw === 'stale'
              ? <StatusBadge level="warning"><span title={hwFailing ?? 'The hardware collector has not reported in the last minute.'}>hardware data stale</span></StatusBadge>
              : <span className="muted">waiting for the hardware collector</span>}
          </div>
        )}

        <div className="machine-foot">
          <div className="machine-summary">{summary.join(' · ')}{placeholder && <span className="machine-dev"> · placeholder model (dev)</span>}</div>
          <Legend lens={lens} slots={slots} />
        </div>
      </div>

      <aside className="machine-side" ref={sideRef}>
        {selected ? (
          <MachineDetail
            state={state}
            slot={selectedSlot}
            siblings={slots}
            partKey={selected}
            partLabel={model?.byKey.get(selected)?.label ?? null}
            now={now}
            onClose={close}
          />
        ) : (
          <SlotList slots={slots} state={state} hovered={hovered} selected={selected} onHover={setHovered} onSelect={selectFromList} hw={hw} />
        )}
      </aside>
    </div>
  );
}
