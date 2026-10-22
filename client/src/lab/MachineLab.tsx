// Dev-only harness for the Machine scene, served by Vite at /lab.html and never part of the
// production build. Drives MachineScene with the same kinds of data the Machine view will:
// per-part visuals, lens presets, flows, exploded / xray, hover and selection, labels.
//
// URL parameters (handy for screenshots): model=/lab/placeholder, lens=neutral|pools|heat|traffic,
// exploded=1, xray=0.6, sel=bay3, labels=0, sim=0, panel=0, busy=3 (which bay is busy),
// slide=bay2 (pull that tray out), reduced=1 (reduced motion).
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './lab.css';
import { MachineScene } from '../viz/machine/MachineScene';
import { loadMachineModel } from '../viz/machine/model';
import { currentEngine, DEFAULT_TUNING, type Tuning } from '../viz/machine/engine';
import type { Flow, MachineModel, PartVisual, SceneLabel, Vec3 } from '../viz/machine/types';
import { SEQUENTIAL } from '../lib/palette';
import { hex } from '../lib/gpu';

type Lens = 'neutral' | 'pools' | 'heat' | 'traffic';
const LENSES: Lens[] = ['neutral', 'pools', 'heat', 'traffic'];
const SOURCES = ['/wtr-max', '/lab/placeholder'];

const BODY: Vec3 = [0.8, 0.84, 0.92];
const BULK = hex('#3987e5');
const FAST = hex('#d95926');
const NET = hex('#199e70');

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);

function ramp(v: number): Vec3 {
  const x = Math.min(1, Math.max(0, v)) * (SEQUENTIAL.length - 1);
  const i = Math.floor(x), j = Math.min(SEQUENTIAL.length - 1, i + 1);
  const a = hex(SEQUENTIAL[i]), b = hex(SEQUENTIAL[j]);
  const f = x - i;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Simulated temperature (0..1 on the ramp) per part kind.
const HEAT: Record<string, number> = { hdd: 0.42, nvme: 0.7, cpu: 0.92, ram: 0.5, board: 0.4, backplane: 0.3, fan: 0.2, sled: 0.35, port: 0.25, io: 0.25, led: 0.1, shell: 0.15 };

function rgbToHex(c: Vec3) {
  return '#' + c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

// A cols x rows test card for the front display: text in the body colour and a data colour, three
// bars, and a dot that sweeps along the bottom row.
function drawPattern(canvas: HTMLCanvasElement, tick: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = 'top';
  ctx.font = `bold ${Math.max(6, Math.round(h * 0.4))}px ui-monospace, Menlo, monospace`;
  ctx.fillStyle = '#f0efec';
  ctx.fillText('WTR MAX', 2, 0);
  ctx.fillStyle = '#3987e5';
  ctx.font = `${Math.max(5, Math.round(h * 0.3))}px ui-monospace, Menlo, monospace`;
  ctx.fillText('bulk 54% 1.2GB/s', 2, Math.round(h * 0.45));
  const bars = [0.5 + 0.4 * Math.sin(tick * 0.13), 0.35 + 0.2 * Math.sin(tick * 0.31 + 1), 0.8 + 0.15 * Math.sin(tick * 0.07)];
  const colors = ['#f0efec', '#d95926', '#199e70'];
  const bx = Math.round(w * 0.62), bw = w - bx - 3, bh = Math.max(2, Math.round(h * 0.14));
  bars.forEach((v, i) => {
    const y = 1 + i * (bh + 2);
    ctx.fillStyle = '#26262a';
    ctx.fillRect(bx, y, bw, bh);
    ctx.fillStyle = colors[i];
    ctx.fillRect(bx, y, Math.round(bw * v), bh);
  });
  ctx.fillStyle = '#fab219';
  const x = (tick * 2) % w;
  ctx.fillRect(x, h - 2, 3, 1);
  ctx.fillRect(x, h - 1, 3, 1);
}

function MachineLab() {
  const [source, setSource] = useState(params.get('model') ?? SOURCES[0]);
  const [loaded, setLoaded] = useState<{ url: string; model: MachineModel } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>((params.get('lens') as Lens) ?? 'pools');
  const [exploded, setExploded] = useState(params.get('exploded') === '1');
  const [xray, setXray] = useState(num('xray', 0));
  const [labelsOn, setLabelsOn] = useState(params.get('labels') !== '0');
  const [simOn, setSimOn] = useState(params.get('sim') !== '0');
  const [selected, setSelected] = useState<string | null>(params.get('sel'));
  const [hovered, setHovered] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Partial<PartVisual>>>({});
  const [bayLoad, setBayLoad] = useState<number[]>(() => {
    const busy = num('busy', 3);
    return [0, 1, 2, 3, 4, 5].map(i => (i + 1 === busy ? 0.92 : 0.06 + 0.04 * i));
  });
  const [slides, setSlides] = useState<Record<string, number>>(() => (params.get('slide') ? { [params.get('slide')!]: 1 } : {}));
  const [tuning, setTuning] = useState<Tuning>({ ...DEFAULT_TUNING });
  const [stats, setStats] = useState({ fps: 0, cpuMs: 0, points: 0, flowParticles: 0 });
  const [bench, setBench] = useState<string>('');
  const [panelOpen, setPanelOpen] = useState(params.get('panel') !== '0');
  const [customFlows, setCustomFlows] = useState<Record<string, number>>({});
  const [screenOn, setScreenOn] = useState(params.get('screen') !== '0');
  const [screenVersion, setScreenVersion] = useState(0);

  // ----- model -----
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    loadMachineModel(source)
      .then(model => { if (!cancelled) setLoaded({ url: source, model }); })
      .catch(err => {
        if (cancelled) return;
        if (!params.has('model') && source !== SOURCES[1]) { setSource(SOURCES[1]); return; }   // real model not built yet
        setLoadError((err as Error).message);
      });
    return () => { cancelled = true; };
  }, [source]);

  // ----- simulated load: bays wander a little -----
  useEffect(() => {
    if (!simOn) return;
    const id = setInterval(() => {
      setBayLoad(prev => prev.map((v, i) => {
        const busy = v > 0.6;
        const next = v + (Math.random() - 0.5) * (busy ? 0.18 : 0.06);
        return Math.min(1, Math.max(0.02, busy ? Math.max(0.55, next) : Math.min(0.4, next + (i === 0 ? 0 : 0))));
      }));
    }, 700);
    return () => clearInterval(id);
  }, [simOn]);

  // ----- stats -----
  useEffect(() => {
    const id = setInterval(() => {
      const e = currentEngine();
      if (e) setStats({ ...e.stats });
    }, 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { const e = currentEngine(); if (e) e.tuning = tuning; }, [tuning, loaded]);

  const model = loaded?.model ?? null;

  // The front screen's test pattern: text, bars and a moving element, redrawn ten times a second.
  const screenCanvas = useMemo(() => {
    const sc = model?.manifest.screen;
    if (!sc) return null;
    const canvas = document.createElement('canvas');
    canvas.width = sc.cols;
    canvas.height = sc.rows;
    return canvas;
  }, [model]);
  useEffect(() => {
    if (!screenCanvas || !screenOn) return;
    let tick = 0;
    const id = setInterval(() => { drawPattern(screenCanvas, tick++); setScreenVersion(v => v + 1); }, 100);
    drawPattern(screenCanvas, tick++);
    setScreenVersion(v => v + 1);
    return () => clearInterval(id);
  }, [screenCanvas, screenOn]);
  const defaultVisual = useMemo<PartVisual>(() => {
    if (lens === 'traffic') return { color: BODY, intensity: 0.2, activity: 0, pulse: 0, slide: 0 };
    if (lens === 'pools') return { color: BODY, intensity: 0.62, activity: 0, pulse: 0, slide: 0 };
    return { color: BODY, intensity: 1, activity: 0, pulse: 0, slide: 0 };
  }, [lens]);

  const visuals = useMemo(() => {
    const out: Record<string, PartVisual> = {};
    if (!model) return out;
    for (const p of model.parts) {
      const bay = /^bay(\d)$/.exec(p.key);
      const load = bay ? bayLoad[Number(bay[1]) - 1] : 0;
      let v: PartVisual = { ...defaultVisual };
      if (lens === 'pools') {
        if (p.kind === 'hdd') v = { color: BULK, intensity: 1, activity: load > 0.3 ? load : load * 0.4, pulse: 0, slide: 0 };
        else if (p.kind === 'nvme' || p.kind === 'sled') v = { color: FAST, intensity: 1, activity: p.kind === 'nvme' ? 0.35 : 0.1, pulse: 0, slide: 0 };
      } else if (lens === 'heat') {
        const base = HEAT[p.kind] ?? 0.3;
        const t = bay ? 0.3 + 0.35 * load + 0.04 * Number(bay[1]) : base;
        v = { color: ramp(0.18 + t * 0.82), intensity: 0.7 + 0.7 * t, activity: 0, pulse: t > 0.88 ? 1 : 0, slide: 0 };
      } else if (lens === 'traffic') {
        if (p.kind === 'hdd') v = { color: BULK, intensity: 0.35 + 0.5 * load, activity: load * 0.5, pulse: 0, slide: 0 };
        else if (p.kind === 'nvme') v = { color: FAST, intensity: 0.45, activity: 0.2, pulse: 0, slide: 0 };
        else if (p.kind === 'cpu') v = { color: BODY, intensity: 0.7, activity: 0.3 + 0.4 * Math.max(...bayLoad), pulse: 0, slide: 0 };
      }
      const slide = slides[p.key] ?? 0;
      out[p.key] = { ...v, ...overrides[p.key], slide: overrides[p.key]?.slide ?? slide };
    }
    return out;
  }, [model, lens, bayLoad, overrides, defaultVisual, slides]);

  const flows = useMemo<Flow[]>(() => {
    if (!model || lens !== 'traffic') return [];
    const out: Flow[] = [];
    for (let i = 1; i <= 6; i++) {
      if (!model.byKey.has(`bay${i}`)) continue;
      const rate = customFlows[`bay${i}`] ?? Math.max(0, (bayLoad[i - 1] - 0.08) * 1.1);
      out.push({ id: `bay${i}`, from: `bay${i}`, via: ['sata', 'bus'], to: 'cpu', rate, color: BULK });
    }
    if (model.byKey.has('m2s1')) out.push({ id: 'nvme1', from: 'm2s1', via: ['bus'], to: 'cpu', rate: customFlows.nvme1 ?? 0.45, color: FAST });
    if (model.byKey.has('lan1')) out.push({ id: 'lan1', from: 'cpu', via: ['bus', 'nic'], to: 'lan1', rate: customFlows.lan1 ?? 0.6, color: NET });
    return out;
  }, [model, lens, bayLoad, customFlows]);

  const labels = useMemo<SceneLabel[]>(() => {
    if (!model || !labelsOn) return [];
    const out: SceneLabel[] = [];
    for (let i = 1; i <= 6; i++) {
      if (!model.byKey.has(`bay${i}`)) continue;
      const load = bayLoad[i - 1];
      if (load < 0.5 && i !== 6) continue;   // keep the pile of labels readable
      out.push({
        key: `bay${i}`, at: 'top',
        content: <span>Bay {i} <b style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(load * 480)} MB/s</b></span>,
        tone: i === 6 ? 'warning' : 'default',
      });
    }
    if (model.byKey.has('lan1')) out.push({ key: 'lan1', at: 'socket', content: <span>2.5GbE 1 <b>312 Mb/s</b></span> });
    if (model.byKey.has('cpu')) out.push({ key: 'cpu', at: 'center', content: <span>CPU 41%</span> });
    return out;
  }, [model, labelsOn, bayLoad]);

  const partRows = model?.parts ?? [];
  const sel = selected ? model?.byKey.get(selected) : null;
  const selVisual = selected ? visuals[selected] : null;

  const setOverride = (key: string, patch: Partial<PartVisual>) => setOverrides(o => ({ ...o, [key]: { ...o[key], ...patch } }));
  const tune = (k: keyof Tuning, v: number) => setTuning(t => ({ ...t, [k]: v }));

  const runBench = async () => {
    const e = currentEngine();
    if (!e) return;
    setBench('running...');
    const ms = await e.benchmark(120);
    setBench(`${ms.toFixed(2)} ms/frame (${(1000 / ms).toFixed(0)} fps) at ${e.size.width}x${e.size.height} css px`);
  };

  const stageRef = useRef<HTMLDivElement>(null);

  return (
    <div className={`lab${panelOpen ? '' : ' no-panel'}`}>
      {panelOpen && (
        <aside className="lab-panel">
          <h1>Machine lab</h1>
          <div className="lab-row">
            <label>Model</label>
            <select value={source} onChange={e => setSource(e.target.value)}>
              {[...new Set([...SOURCES, source])].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {loadError && <div className="callout">{loadError}</div>}
          {model && <div className="muted lab-small">{model.manifest.name}: {model.manifest.pointCount.toLocaleString()} points, {model.parts.length} parts</div>}

          <h2>Lens</h2>
          <div className="segmented">
            {LENSES.map(l => <button key={l} className={lens === l ? 'on' : ''} onClick={() => setLens(l)}>{l}</button>)}
          </div>
          <div className="lab-row"><label><input type="checkbox" checked={exploded} onChange={e => setExploded(e.target.checked)} /> Exploded</label>
            <label><input type="checkbox" checked={labelsOn} onChange={e => setLabelsOn(e.target.checked)} /> Labels</label>
            <label><input type="checkbox" checked={simOn} onChange={e => setSimOn(e.target.checked)} /> Simulate</label>
            {screenCanvas && <label><input type="checkbox" checked={screenOn} onChange={e => setScreenOn(e.target.checked)} /> Screen</label>}</div>
          <div className="lab-row"><label>X-ray</label><input type="range" min={0} max={1} step={0.01} value={xray} onChange={e => setXray(Number(e.target.value))} /><span className="num">{xray.toFixed(2)}</span></div>

          <h2>Bay load (drives the bays and flows)</h2>
          {bayLoad.map((v, i) => (
            <div className="lab-row" key={i}>
              <label>Bay {i + 1}</label>
              <input type="range" min={0} max={1} step={0.01} value={v} onChange={e => setBayLoad(b => b.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
              <span className="num">{v.toFixed(2)}</span>
              {model?.byKey.get(`bay${i + 1}`)?.slide && (
                <button className="ghost" onClick={() => setSlides(s => ({ ...s, [`bay${i + 1}`]: s[`bay${i + 1}`] ? 0 : 1 }))}>{slides[`bay${i + 1}`] ? 'push in' : 'pull out'}</button>
              )}
            </div>
          ))}

          <h2>Selected part {sel ? <span className="muted">· {sel.label}</span> : null}</h2>
          {sel && selVisual ? (
            <div className="lab-edit">
              <div className="lab-row"><label>Color</label>
                <input type="color" value={rgbToHex(selVisual.color)} onChange={e => setOverride(sel.key, { color: hex(e.target.value) })} /></div>
              {(['intensity', 'activity', 'pulse'] as const).map(k => (
                <div className="lab-row" key={k}><label>{k}</label>
                  <input type="range" min={0} max={k === 'intensity' ? 1.6 : 1} step={0.01} value={selVisual[k]} onChange={e => setOverride(sel.key, { [k]: Number(e.target.value) })} />
                  <span className="num">{selVisual[k].toFixed(2)}</span></div>
              ))}
              {sel.slide && <div className="lab-row"><label>slide</label>
                <input type="range" min={0} max={1} step={0.01} value={selVisual.slide} onChange={e => setOverride(sel.key, { slide: Number(e.target.value) })} />
                <span className="num">{selVisual.slide.toFixed(2)}</span></div>}
              <button className="ghost" onClick={() => setOverrides(o => { const n = { ...o }; delete n[sel.key]; return n; })}>reset part</button>
            </div>
          ) : <div className="muted lab-small">Click a part in the scene or the list.</div>}

          {lens === 'traffic' && (
            <>
              <h2>Flows</h2>
              {flows.map(f => (
                <div className="lab-row" key={f.id}>
                  <label style={{ color: rgbToHex(f.color) }}>{f.id}</label>
                  <input type="range" min={0} max={1} step={0.01} value={f.rate} onChange={e => setCustomFlows(c => ({ ...c, [f.id]: Number(e.target.value) }))} />
                  <span className="num">{f.rate.toFixed(2)}</span>
                </div>
              ))}
            </>
          )}

          <h2>Look</h2>
          {([['bloom', 0, 3], ['exposure', 0.4, 2.5], ['threshold', 0, 1.5], ['upGain', 0.3, 1.3], ['vignette', 0, 1], ['grain', 0, 0.05], ['pointSize', 0.5, 2.5], ['repelStrength', 0, 14], ['repelRadius', 0.004, 0.05], ['flowLimit', 0.8, 6], ['flowBloom', 0, 2], ['screenBloom', 0, 1]] as const).map(([k, lo, hi]) => (
            <div className="lab-row" key={k}><label>{k}</label>
              <input type="range" min={lo} max={hi} step={(hi - lo) / 100} value={tuning[k]} onChange={e => tune(k, Number(e.target.value))} />
              <span className="num">{tuning[k].toFixed(2)}</span></div>
          ))}
          <button className="ghost" onClick={() => setTuning({ ...DEFAULT_TUNING })}>reset look</button>

          <h2>Parts</h2>
          <div className="lab-parts">
            {partRows.map(p => (
              <div
                key={p.key}
                className={`lab-part${selected === p.key ? ' on' : ''}${hovered === p.key ? ' hover' : ''}`}
                onMouseEnter={() => setHovered(p.key)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => setSelected(s => (s === p.key ? null : p.key))}
              >
                <i style={{ background: rgbToHex(visuals[p.key]?.color ?? BODY) }} />
                <span>{p.label}</span>
                <span className="muted num">{p.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
          <div className="lab-row">
            <button onClick={runBench}>Benchmark</button>
            <span className="muted lab-small">{bench}</span>
          </div>
        </aside>
      )}
      <main className="lab-stage" ref={stageRef}>
        {model && (
          <MachineScene
            model={model}
            visuals={visuals}
            defaultVisual={defaultVisual}
            flows={flows}
            labels={labels}
            exploded={exploded}
            xray={xray}
            selected={selected}
            hovered={hovered}
            onHover={setHovered}
            onSelect={setSelected}
            screen={screenCanvas && screenOn ? { canvas: screenCanvas, version: screenVersion } : undefined}
            className="lab-scene"
            ariaLabel="WTR point cloud"
          />
        )}
        <div className="lab-hud">
          <button className="ghost" onClick={() => setPanelOpen(o => !o)}>{panelOpen ? 'hide panel' : 'panel'}</button>
          <span className="num">{stats.fps.toFixed(0)} fps</span>
          <span className="muted num">{stats.points.toLocaleString()} points</span>
          {stats.flowParticles > 0 && lens === 'traffic' && <span className="muted num">{stats.flowParticles.toLocaleString()} flow particles</span>}
          <span className="muted num">cpu {stats.cpuMs.toFixed(2)} ms</span>
          {hovered && <span>{model?.byKey.get(hovered)?.label}</span>}
        </div>
      </main>
    </div>
  );
}

// Console handles for poking at the engine: lab.engine(), await lab.shot('a.png') (POSTs a device-resolution
// PNG to a local receiver on :5199 when one is running).
Object.assign(window, {
  lab: {
    engine: currentEngine,
    // Wait for the engine, step the simulation forward, optionally take a shot.
    async go(seconds = 4, name?: string) {
      for (let i = 0; i < 100 && !currentEngine(); i++) await new Promise(r => setTimeout(r, 100));
      await currentEngine()!.advance(seconds);
      return name ? (this as { shot(n: string): Promise<string> }).shot(name) : 'ok';
    },
    async shot(name = 'shot.png', port = 5199) {
      const blob = await currentEngine()!.capture();
      const res = await fetch(`http://127.0.0.1:${port}/${encodeURIComponent(name.replace(/\.png$/, ''))}.png`, { method: 'POST', body: blob });
      return `${blob.size} bytes: ${await res.text()}`;
    },
  },
});

// One root across hot reloads.
const lab = window as unknown as { __labRoot?: ReturnType<typeof createRoot> };
(lab.__labRoot ??= createRoot(document.getElementById('root')!)).render(
  <StrictMode>
    <MachineLab />
  </StrictMode>,
);
