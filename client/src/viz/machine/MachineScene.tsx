// The Machine view's canvas: WTR as a live point cloud. This file is the React side: the
// canvas, pointer / wheel / keyboard input, picking, and the DOM labels pinned to parts. The
// drawing itself lives in engine.ts.
import { useEffect, useRef } from 'react';
import { useGpuCanvas } from '../../lib/gpu';
import { MachineEngine } from './engine';
import type { MachineSceneProps, SceneLabel } from './types';

const TONE_COLOR: Record<NonNullable<SceneLabel['tone']>, string> = {
  default: 'var(--ink-2, #c3c2b7)',
  warning: 'var(--warning, #fab219)',
  critical: 'var(--critical, #d03b3b)',
};

export function MachineScene({
  model, visuals, defaultVisual, flows, labels, exploded, xray, selected, hovered, onHover, onSelect, resetToken, screen, className, ariaLabel,
}: MachineSceneProps) {
  const { canvasRef, renderer, error, handle } = useGpuCanvas(gpu => MachineEngine.create(gpu, model), [model]);
  const labelEls = useRef(new Map<number, HTMLDivElement>());
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const callbacks = useRef({ onHover, onSelect });
  callbacks.current = { onHover, onSelect };

  useEffect(() => {
    if (!renderer) return;
    renderer.setScene({ visuals, defaultVisual, exploded, xray, selected, hovered });
    handle.invalidate();
  }, [renderer, handle, visuals, defaultVisual, exploded, xray, selected, hovered]);

  useEffect(() => {
    if (!renderer) return;
    renderer.setFlows(flows);
    handle.invalidate();
  }, [renderer, handle, flows]);

  // The front screen: the view draws into its canvas and bumps the version; the engine re-uploads then.
  const screenCanvas = screen?.canvas ?? null, screenVersion = screen?.version ?? 0;
  useEffect(() => {
    if (!renderer) return;
    renderer.setScreen(screenCanvas, screenVersion);
    handle.invalidate();
  }, [renderer, handle, screenCanvas, screenVersion]);

  // A new resetToken eases the camera back to the default view. The token a scene starts with
  // (or is rebuilt with) is not a request.
  const lastReset = useRef(resetToken);
  useEffect(() => {
    if (!renderer || resetToken === lastReset.current) return;
    lastReset.current = resetToken;
    renderer.resetCamera();
    handle.invalidate();
  }, [renderer, handle, resetToken]);

  // Labels are placed straight from the render loop: no React work per frame. Labels that would
  // overlap are stacked downward from the one nearest the top, each joined to its part by an
  // elbow, so a row of parts can all carry a label without the labels covering each other.
  const sizes = useRef(new WeakMap<HTMLElement, { w: number; h: number; dy: number }>());
  useEffect(() => { sizes.current = new WeakMap(); }, [labels]);
  useEffect(() => {
    if (!renderer) return;
    renderer.onFrame = engine => {
      const placed: Array<{ el: HTMLDivElement; x: number; y: number; w: number; h: number }> = [];
      labelsRef.current.forEach((label, i) => {
        const el = labelEls.current.get(i);
        if (!el) return;
        const at = engine.project(label.key, label.at ?? 'socket');
        if (!at || !at.visible) {
          el.style.visibility = 'hidden';
          return;
        }
        el.style.visibility = 'visible';
        const x = Math.round(at.x * 2) / 2, y = Math.round(at.y * 2) / 2;
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        let size = sizes.current.get(el);
        if (!size) {
          const body = el.querySelector<HTMLElement>('.machine-label-body');
          size = { w: body?.offsetWidth ?? 80, h: body?.offsetHeight ?? 20, dy: NaN };   // NaN: write the first value whatever the DOM holds
          sizes.current.set(el, size);
        }
        placed.push({ el, x, y, w: size.w, h: size.h });
      });
      placed.sort((a, b) => a.y - b.y || a.x - b.x);
      const taken: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
      for (const p of placed) {
        const x0 = p.x + 16, x1 = x0 + p.w;
        let top = p.y - p.h / 2;
        for (let guard = 0; guard < 24; guard++) {
          const hit = taken.find(t => x0 < t.x1 + 2 && x1 > t.x0 - 2 && top < t.y1 + 2 && top + p.h > t.y0 - 2);
          if (!hit) break;
          top = hit.y1 + 2;
        }
        taken.push({ x0, x1, y0: top, y1: top + p.h });
        const dy = Math.round(top + p.h / 2 - p.y);
        const size = sizes.current.get(p.el)!;
        if (size.dy !== dy) {
          size.dy = dy;
          p.el.style.setProperty('--dy', `${dy}px`);
          p.el.style.setProperty('--stem-top', `${Math.min(0, dy)}px`);
          p.el.style.setProperty('--stem-h', `${Math.abs(dy)}px`);
          if (dy) p.el.dataset.moved = dy > 0 ? 'down' : 'up'; else delete p.el.dataset.moved;
        }
      }
    };
    return () => { renderer.onFrame = null; };
  }, [renderer]);

  // Pointer, wheel and keyboard.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !renderer) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; at: number; moved: number } | null = null;
    let pinch = 0;
    let hover: string | null = null;

    const local = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const setCursor = (c: string) => { canvas.style.cursor = c; };
    const setHover = (key: string | null) => {
      if (key === hover) return;
      hover = key;
      callbacks.current.onHover(key);
    };
    const wake = () => handle.invalidate();

    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 1) {
        drag = { x: p.x, y: p.y, at: performance.now(), moved: 0 };
        renderer.orbitStart();
        setCursor('grabbing');
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        if (drag) drag.moved = 1e6;           // a second finger is never a click
      }
      wake();
    };

    const move = (e: PointerEvent) => {
      const p = local(e);
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, p);
        if (pointers.size >= 2) {
          const [a, b] = [...pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch > 0 && d > 0) renderer.zoom(pinch / d);
          pinch = d;
        } else if (drag) {
          const now = performance.now();
          const dx = p.x - drag.x, dy = p.y - drag.y;
          drag.moved += Math.abs(dx) + Math.abs(dy);
          if (drag.moved > 3) renderer.orbit(dx, dy, Math.max(0.001, (now - drag.at) / 1000));
          drag.x = p.x; drag.y = p.y; drag.at = now;
        }
        wake();
        return;
      }
      if (e.pointerType !== 'mouse') return;
      renderer.setPointer(p.x, p.y);
      const hit = renderer.pick(p.x, p.y);
      setHover(hit?.key ?? null);
      setCursor(hit ? 'pointer' : 'grab');
      wake();
    };

    const up = (e: PointerEvent) => {
      const p = local(e);
      const wasDrag = pointers.size === 1 && drag;
      pointers.delete(e.pointerId);
      try { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (wasDrag && drag && drag.moved <= 4 && e.type === 'pointerup') {
        const hit = renderer.pick(p.x, p.y);
        callbacks.current.onSelect(hit?.key ?? null);
      }
      if (pointers.size === 0) {
        renderer.orbitEnd();
        drag = null;
        pinch = 0;
        if (e.pointerType !== 'mouse') renderer.setPointer(null);
        else setCursor(hover ? 'pointer' : 'grab');
      } else if (pointers.size === 1) {
        // Back to one finger: carry on orbiting from where it is.
        const [rest] = [...pointers.values()];
        drag = { x: rest.x, y: rest.y, at: performance.now(), moved: 1e6 };
        pinch = 0;
      }
      wake();
    };

    const leave = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) return;
      renderer.setPointer(null);
      setHover(null);
      setCursor('grab');
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      renderer.zoom(Math.exp(Math.max(-300, Math.min(300, e.deltaY * unit)) * 0.0012));
      wake();
    };
    const dbl = () => { renderer.resetCamera(); wake(); };
    const key = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft': renderer.nudge(-0.12, 0); break;
        case 'ArrowRight': renderer.nudge(0.12, 0); break;
        case 'ArrowUp': renderer.nudge(0, 0.08); break;
        case 'ArrowDown': renderer.nudge(0, -0.08); break;
        case '+': case '=': renderer.zoom(0.9); break;
        case '-': case '_': renderer.zoom(1.1); break;
        case '0': renderer.resetCamera(); break;
        case 'Escape': callbacks.current.onSelect(null); break;
        default: return;
      }
      e.preventDefault();
      wake();
    };

    setCursor('grab');
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('dblclick', dbl);
    canvas.addEventListener('keydown', key);
    return () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('dblclick', dbl);
      canvas.removeEventListener('keydown', key);
    };
  }, [canvasRef, renderer, handle]);

  return (
    <div
      className={`machine-scene${className ? ` ${className}` : ''}`}
      style={{
        position: 'relative', background: '#000', overflow: 'hidden', touchAction: 'none', userSelect: 'none',
        ...(className ? null : { width: '100%', height: '100%', minHeight: 320 }),
      }}
    >
      <canvas ref={canvasRef} className="viz-canvas" role="img" aria-label={ariaLabel} tabIndex={0} style={{ outlineOffset: -2, touchAction: 'none' }} />
      <div className="machine-labels" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {labels.map((label, i) => {
          const color = TONE_COLOR[label.tone ?? 'default'];
          const id = `${label.key}:${label.at ?? 'socket'}`;
          const copies = labels.slice(0, i).filter(l => `${l.key}:${l.at ?? 'socket'}` === id).length;
          return (
            <div
              key={copies ? `${id}:${copies}` : id}
              ref={el => { if (el) labelEls.current.set(i, el); else labelEls.current.delete(i); }}
              className={`machine-label tone-${label.tone ?? 'default'}`}
              style={{ position: 'absolute', left: 0, top: 0, visibility: 'hidden', willChange: 'transform' }}
            >
              <span style={{ position: 'absolute', left: -3, top: -3, width: 6, height: 6, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}` }} />
              <span className="machine-label-hline" style={{ position: 'absolute', left: 3, top: -0.5, width: 12, height: 1, background: color, opacity: 0.6 }} />
              <span className="machine-label-stem" style={{ position: 'absolute', left: -0.5, top: 'var(--stem-top, 0px)', width: 16, height: 'var(--stem-h, 0px)', boxSizing: 'border-box', color, opacity: 0.6 }} />
              <div
                className="machine-label-body"
                style={{ position: 'absolute', left: 16, top: 0, transform: 'translateY(calc(-50% + var(--dy, 0px)))', whiteSpace: 'nowrap' }}
              >
                {label.content}
              </div>
            </div>
          );
        })}
      </div>
      {error && <div className="viz-error">{error}</div>}
    </div>
  );
}
