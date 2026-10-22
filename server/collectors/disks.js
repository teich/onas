// Physical disks and SMART from the Proxmox API (hourly).
const { replaceTable } = require('../db');
const pve = require('../pve');

function ataAttr(attributes, id) {
  const attr = (attributes || []).find(a => Number(a.id) === id);
  if (!attr) return null;
  const raw = parseInt(String(attr.raw), 10); // e.g. "35 (Min/Max 20/45)" -> 35
  return Number.isFinite(raw) ? raw : null;
}

function nvmeField(text, label) {
  const m = String(text || '').match(new RegExp(`^${label}:\\s+([\\d,]+)`, 'm'));
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

async function collect() {
  const { data: disks, via } = await pve.get(`/nodes/${pve.NODE}/disks/list`);
  const rows = [];
  for (const disk of disks) {
    let smart = null;
    try {
      ({ data: smart } = await pve.get(`/nodes/${pve.NODE}/disks/smart`, { disk: disk.devpath }));
    } catch (_) {
      // Card readers and USB bridges often have no SMART; keep the disk with what the list gave us.
    }
    const isNvme = disk.type === 'nvme';
    rows.push({
      devpath: disk.devpath,
      by_id: disk.by_id_link || '',
      model: disk.model || '',
      serial: disk.serial || '',
      type: disk.type || '',
      size: disk.size || 0,
      used: disk.used || '',
      health: smart?.health || disk.health || 'UNKNOWN',
      wearout: Number.isFinite(Number(disk.wearout)) ? Number(disk.wearout) : null,
      temp_c: isNvme ? nvmeField(smart?.text, 'Temperature') : ataAttr(smart?.attributes, 194),
      power_on_hours: isNvme ? nvmeField(smart?.text, 'Power On Hours') : ataAttr(smart?.attributes, 9),
      reallocated: isNvme ? null : ataAttr(smart?.attributes, 5),
    });
  }
  replaceTable('disks', rows);
  return { via };
}

module.exports = [{ name: 'disks', intervalMs: 60 * 60_000, timeoutMs: 120_000, run: collect }];
