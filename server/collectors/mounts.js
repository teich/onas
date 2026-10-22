// What each guest mounts (root disk, VM disks, bind mounts), resolved to ZFS datasets, from
// the guest configs in the Proxmox API (every 5 minutes).
const { db, replaceTable } = require('../db');
const pve = require('../pve');

const VM_DISK = /^(scsi|sata|virtio|ide|efidisk|tpmstate)\d+$/;

function parseVolume(value) {
  const [source, ...opts] = String(value).split(',');
  const options = {};
  for (const opt of opts) {
    const [k, v = ''] = opt.split('=');
    options[k] = v;
  }
  return { source, options };
}

// The dataset whose mountpoint is the longest prefix of a host path ("/bulk/photos/x" -> bulk/photos).
function datasetForPath(datasets, hostPath) {
  const p = hostPath.replace(/\/+$/, '') || '/';
  let best = null;
  for (const ds of datasets) {
    const mp = ds.mountpoint;
    if (!mp || mp === '-' || mp === 'none' || mp === 'legacy') continue;
    if ((p === mp || p.startsWith(`${mp}/`)) && (!best || mp.length > best.mountpoint.length)) best = ds;
  }
  return best?.name ?? null;
}

async function collect() {
  const { data: storages, via } = await pve.get('/storage');
  const zfsPools = Object.fromEntries(storages.filter(s => s.type === 'zfspool').map(s => [s.storage, s.pool]));
  const datasets = db.prepare('SELECT name, mountpoint FROM datasets').all();
  const guests = db.prepare('SELECT vmid, type FROM guests').all();

  const rows = [];
  for (const guest of guests) {
    const { data: config } = await pve.get(`/nodes/${pve.NODE}/${guest.type === 'lxc' ? 'lxc' : 'qemu'}/${guest.vmid}/config`);
    for (const [slot, value] of Object.entries(config)) {
      const isLxcMount = guest.type === 'lxc' && (slot === 'rootfs' || /^mp\d+$/.test(slot));
      const isVmDisk = guest.type === 'vm' && VM_DISK.test(slot);
      if (!isLxcMount && !isVmDisk) continue;
      const { source, options } = parseVolume(value);
      if (source === 'none' || options.media === 'cdrom') continue;
      const bind = source.startsWith('/');
      const [storage, volume] = source.split(':');
      rows.push({
        vmid: guest.vmid,
        slot,
        kind: bind ? 'bind' : slot === 'rootfs' ? 'rootfs' : 'disk',
        source,
        target: options.mp || null,
        dataset: bind ? datasetForPath(datasets, source) : zfsPools[storage] && volume ? `${zfsPools[storage]}/${volume}` : null,
        read_only: options.ro === '1',
        size: options.size || null,
      });
    }
  }
  replaceTable('guest_mounts', rows);
  return { via };
}

module.exports = [{ name: 'mounts', intervalMs: 5 * 60_000, run: collect }];
