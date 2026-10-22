import { useEffect, useState } from 'react';
import type { CollectorStatus } from '../lib/types';
import { STATUS, type StatusLevel } from '../lib/palette';
import { timeAgo } from '../lib/format';

const STATUS_ICON: Record<StatusLevel, string> = { good: '●', warning: '▲', serious: '◆', critical: '■' };

// A status is never colour alone: icon + label, in the reserved status colour.
export function StatusBadge({ level, children }: { level: StatusLevel; children: React.ReactNode }) {
  return (
    <span className={`status status-${level}`} style={{ '--status': STATUS[level] } as React.CSSProperties}>
      <i aria-hidden="true">{STATUS_ICON[level]}</i>{children}
    </span>
  );
}

// Thin horizontal meter: one value against a whole, optional quota tick.
export function Meter({ value, max, color, marker, label }: { value: number; max: number; color: string; marker?: number | null; label?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <span className="meter" aria-label={label} title={label}>
      <span className="meter-fill" style={{ width: `${pct}%`, background: color }} />
      {marker != null && max > 0 && <span className="meter-marker" style={{ left: `${Math.min(100, (marker / max) * 100)}%` }} />}
    </span>
  );
}

// Section age for a collector: "40s ago", or the error when its last run failed.
export function Freshness({ collector }: { collector?: CollectorStatus }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  if (!collector) return null;
  if (collector.ok === false) {
    return <StatusBadge level="warning"><span title={collector.error ?? ''}>collector failing{collector.lastOk ? ` · data from ${timeAgo(collector.lastOk)}` : ''}</span></StatusBadge>;
  }
  return <span className="freshness" title={`via ${collector.via ?? '?'} · every ${Math.round(collector.intervalMs / 1000)}s`}>{collector.lastOk ? `updated ${timeAgo(collector.lastOk)}` : 'waiting for data'}</span>;
}

export function Panel({ title, aside, children, className = '' }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <h2>{title}</h2>
        {aside && <div className="panel-aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

export function Modal({ title, onClose, children, wide }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
        <header className="modal-head"><h3>{title}</h3><button className="ghost" onClick={onClose} aria-label="Close">✕</button></header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// Destructive confirmation: the user types the exact name before the button enables.
export function ConfirmTyped({ title, body, expect, action, onConfirm, onClose }: {
  title: string;
  body: React.ReactNode;
  expect: string;
  action: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="confirm-body">{body}</div>
      <label className="field">
        <span>Type <code>{expect}</code> to confirm</span>
        <input autoFocus value={typed} onChange={e => setTyped(e.target.value)} spellCheck={false} onKeyDown={e => { if (e.key === 'Enter' && typed === expect) go(); }} />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>Cancel</button>
        <button className="danger" disabled={typed !== expect || busy} onClick={go}>{busy ? 'Working…' : action}</button>
      </div>
    </Modal>
  );
}

export function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy"
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
      }}
      title="Copy"
    >
      <code>{text}</code><span>{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
