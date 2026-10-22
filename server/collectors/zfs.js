// Pools from the Proxmox API; datasets and snapshots over SSH, which the API doesn't expose.
const { replaceTable } = require('../db');
const pve = require('../pve');
const { sshExec } = require('../ssh');

async function collectPools() {
  const { data: pools, via } = await pve.get(`/nodes/${pve.NODE}/disks/zfs`);
  const rows = [];
  for (const pool of pools) {
    const { data: detail } = await pve.get(`/nodes/${pve.NODE}/disks/zfs/${encodeURIComponent(pool.name)}`);
    // The detail's children start with the pool itself; its children are the vdevs.
    const root = (detail.children || []).find(child => child.name === pool.name);
    rows.push({
      name: pool.name,
      size: pool.size,
      alloc: pool.alloc,
      free: pool.free,
      frag: pool.frag,
      dedup: pool.dedup,
      health: pool.health,
      scan: detail.scan || '',
      errors: detail.errors || '',
      status: detail.status || '',
      vdevs: JSON.stringify(root ? root.children || [] : detail.children || []),
    });
  }
  replaceTable('pools', rows);
  return via;
}

function num(value) {
  return value === '-' || value === '' || value == null ? null : Number(value);
}

async function collectDatasets() {
  const out = await sshExec(
    'zfs list -Hp -t filesystem,volume -o name,used,avail,refer,mountpoint,type,volsize,' +
    'usedbysnapshots,usedbydataset,usedbychildren,quota,compressratio; echo ---; ' +
    'zfs list -Hp -t snapshot -o name,used,refer,creation'
  );
  const [datasetPart, snapshotPart = ''] = out.split('\n---\n');
  const datasets = datasetPart.trim().split('\n').filter(Boolean).map(line => {
    const [name, used, avail, refer, mountpoint, type, volsize, bySnap, byDataset, byChildren, quota, ratio] = line.split('\t');
    return {
      name, used: num(used), avail: num(avail), refer: num(refer), mountpoint, type, volsize: num(volsize),
      used_by_snapshots: num(bySnap),
      used_by_dataset: num(byDataset),
      used_by_children: num(byChildren),
      quota: num(quota) || null, // 0 means no quota
      compressratio: parseFloat(ratio) || null,
    };
  });
  const snapshots = snapshotPart.trim().split('\n').filter(Boolean).map(line => {
    const [name, used, refer, creation] = line.split('\t');
    const at = name.indexOf('@');
    return {
      name,
      dataset: name.slice(0, at),
      snapname: name.slice(at + 1),
      used: num(used),
      refer: num(refer),
      created_at: new Date(Number(creation) * 1000).toISOString(),
    };
  });
  replaceTable('datasets', datasets);
  replaceTable('snapshots', snapshots);
}

async function collect() {
  const [via] = await Promise.all([collectPools(), collectDatasets()]);
  return { via: via === 'api' ? 'api+ssh' : 'ssh' };
}

module.exports = [{ name: 'zfs', intervalMs: 60_000, run: collect }];
