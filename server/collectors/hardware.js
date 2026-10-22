// Live hardware, mapped onto WTR's physical slots (every 10 s): per-disk I/O and temperature,
// NIC traffic and link state, CPU and DIMM temperatures. One SSH round-trip per run reads the
// kernel's counters (/proc/diskstats, /proc/net/dev), sysfs and hwmon; rates are the change
// since the previous run, kept in memory. The first run after a start reports 0.
//
// HDD temperature is the exception, because reading SMART is not free: `-n standby` leaves a
// sleeping drive asleep, but SMART READ DATA also restarts an awake-but-idle drive's spin-down
// timer. So smartctl runs at most every few minutes, only for a drive that has done I/O since
// its last read (or has never been read), at most 2 drives per run, each with a short timeout.
// An idle drive keeps its last temperature and the time it was read. NVMe temperature comes
// live from hwmon.
//
// Slots are keys of the machine model (client/src/viz/machine/types.ts). Where a part sits is
// assumed from DEFAULTS below unless /etc/onas/hardware.json says otherwise.
const fs = require('fs');
const path = require('path');
const { db, transaction, replaceTable } = require('../db');
const { sshExec } = require('../ssh');

// ---- Where things are assumed to sit. Change the physical layout here. -----------------------
const DEFAULTS = {
  // 3.5" bays: the SATA port the drive is on (pci-*-ata-N in /dev/disk/by-path) is bay N.
  sataBays: 6,
  // M.2 drives in ascending order of the NVMe controller's PCI address. All three link at x2, so
  // they fill the 4-SSD bracket's two x2 slots and the board's one; Oren recalls the boot drive
  // on the board (2026-10-22). See model/wtr-max/README.md: 68:00.0 SN850X HS → m2s3 (bracket),
  // 6a:00.0 SPCC (boot) → m2s5 (board), 6b:00.0 SN850X → m2s4 (bracket).
  nvmeSlots: ['m2s3', 'm2s5', 'm2s4'],
  // Network ports by kernel driver, in ascending order of PCI address (the X710's two
  // functions are f0, f1).
  nics: {
    igc: { kind: '2.5GbE', slots: ['lan1', 'lan2'] },         // Intel I226-V
    i40e: { kind: '10GbE SFP+', slots: ['sfp1', 'sfp2'] },    // Intel X710
  },
  // DIMM temperature sensors (spd5118) in ascending order of I2C address.
  memorySlots: ['ram1', 'ram2'],
};

// Overrides: { "slots": { "<disk serial or NIC name>": "<slot key>" } }. Same directory as
// state.js's guests.json. A null value says the part has no slot.
const CONFIG_DIR = process.env.ONAS_CONFIG_DIR || '/etc/onas';
const CONFIG_FILE = path.join(CONFIG_DIR, 'hardware.json');

const SMART_EVERY_MS = 5 * 60_000;     // per HDD, at most, and only if it has done I/O since the last read
const SMART_AFTER_WAKE_MS = 30_000;    // earliest recheck of a drive that was in standby but has seen I/O since
const SMART_MAX_PER_RUN = 2;           // drives read per run, oldest read first
const SMART_TIMEOUT_S = 5;             // per drive; with the 1 s kill grace, 2 hung drives cost 12 s of the 20 s SSH timeout
const SECTOR = 512;                    // /proc/diskstats counts 512-byte sectors whatever the drive's own size

// ---- State kept between runs ---------------------------------------------------------------
let previous = null; // { uptime, disks: Map(name -> counters), nics: Map(name -> counters) }
const lastIo = new Map();  // disk name -> ms timestamp of the last sample in which it did I/O
// HDD SMART state by serial: { checkedAt (ms, when a read was last asked for, even if it failed
// or hung), standby, tempC, tempAt (ISO) }. Seeded from the last stored sample so a restart
// doesn't forget the temperature of a drive that is asleep.
const smart = new Map(
  db.prepare("SELECT serial, temp_c, temp_at, standby FROM hw_disks WHERE kind = 'hdd' AND serial != ''").all()
    .map(r => [r.serial, { checkedAt: 0, standby: r.standby == null ? null : Boolean(r.standby), tempC: r.temp_c, tempAt: r.temp_at }])
);
let knownHdds = db.prepare("SELECT name, serial FROM hw_disks WHERE kind = 'hdd'").all();
const insertMetric = db.prepare('INSERT OR REPLACE INTO metrics (series, ts, value) VALUES ($series, $ts, $value)');

// ---- The one SSH command ---------------------------------------------------------------------
// POSIX sh, no single quotes (it is wrapped in sh -c '...'). Sections start with a line `@tag`.
function remoteScript(smartDisks) {
  return `
exec < /dev/null
export LC_ALL=C
read up _ < /proc/uptime
echo "@uptime $up"
echo "@diskstats"; cat /proc/diskstats
echo "@netdev"; cat /proc/net/dev
echo "@bypath"; ls -l /dev/disk/by-path 2>/dev/null
echo "@lsblk"; lsblk -dnr -o NAME,SERIAL 2>/dev/null
d=; s=
for n in /sys/class/net/*; do
  if [ -L $n/device ]; then d="$d $n/device $n/device/driver"; s="$s $n/operstate $n/carrier $n/speed"; fi
done
echo "@nicdev"; [ -n "$d" ] && ls -ld $d 2>/dev/null
echo "@nicstate"; [ -n "$s" ] && grep -H . $s 2>/dev/null
echo "@hwmonlinks"; ls -l /sys/class/hwmon 2>/dev/null
f=
for h in /sys/class/hwmon/hwmon*; do
  n=; read n < $h/name 2>/dev/null
  case $n in nvme|k10temp|spd5118) f="$f $h/name $h/temp*_label $h/temp*_input";; esac
done
echo "@hwmon"; [ -n "$f" ] && grep -H . $f 2>/dev/null
${smartDisks.map(name => `echo "@smart ${name}"; timeout -k 1 ${SMART_TIMEOUT_S} smartctl -n standby -A -j /dev/${name} 2>/dev/null`).join('\n')}
true
`.trim();
}

function sections(text) {
  const out = new Map(); // tag -> { arg, lines }
  let current = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^@(\S+)(?: (.*))?$/);
    if (m) {
      // @smart appears once per drive, so its argument is part of the key.
      current = { arg: m[2] ?? '', lines: [] };
      out.set(m[1] === 'smart' ? `smart:${m[2]}` : m[1], current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return out;
}

const round = (value, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

// ---- Parsers -----------------------------------------------------------------------------------
// Whole-disk counters by device name. Fields after the name: rd_ios rd_merges rd_sectors
// rd_ticks wr_ios wr_merges wr_sectors wr_ticks in_flight io_ticks time_in_queue ...
function parseDiskstats(lines) {
  const out = new Map();
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14 || !/^(sd[a-z]+|nvme\d+n\d+)$/.test(f[2])) continue;
    out.set(f[2], { rdIos: Number(f[3]), rdSectors: Number(f[5]), wrIos: Number(f[7]), wrSectors: Number(f[9]), ioTicks: Number(f[12]) });
  }
  return out;
}

function parseNetdev(lines) {
  const out = new Map();
  for (const line of lines) {
    const m = line.match(/^\s*([^:\s]+):\s*(.*)$/);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length >= 9) out.set(m[1], { rx: f[0], tx: f[8] });
  }
  return out;
}

// /dev/disk/by-path links to whole disks on a SATA port or an NVMe controller. USB readers,
// partitions and the `-ata-N.0` duplicates don't match.
function parseByPath(lines) {
  const out = new Map(); // device name -> { kind, port, order }
  for (const line of lines) {
    const m = line.match(/\spci-([0-9a-f:.]+)-(?:ata-(\d+)|nvme-\d+) -> \.\.\/\.\.\/(\S+)$/);
    if (!m) continue;
    const [, pci, ata, dev] = m;
    out.set(dev, ata
      ? { kind: 'hdd', port: `ata-${ata}`, ata: Number(ata), pci }
      : { kind: 'nvme', port: pci, ata: null, pci });
  }
  return out;
}

function parseSerials(lines) {
  const out = new Map();
  for (const line of lines) {
    const [name, serial = ''] = line.trim().split(' ');
    if (name) out.set(name, serial.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).trim());
  }
  return out;
}

// Physical NICs: those with a device symlink. -> Map(name -> { pci, driver, oper, carrier, speed })
function parseNics(devLines, stateLines) {
  const nics = new Map();
  const get = name => {
    if (!nics.has(name)) nics.set(name, { pci: null, driver: null, oper: null, carrier: null, speed: null });
    return nics.get(name);
  };
  for (const line of devLines) {
    const m = line.match(/\/sys\/class\/net\/([^/]+)\/device(\/driver)? -> (\S+)$/);
    if (!m) continue;
    const target = m[3].split('/').pop();
    if (m[2]) get(m[1]).driver = target; else get(m[1]).pci = target;
  }
  for (const line of stateLines) {
    const m = line.match(/^\/sys\/class\/net\/([^/]+)\/(operstate|carrier|speed):(.*)$/);
    if (!m || !nics.has(m[1])) continue;
    const nic = nics.get(m[1]);
    if (m[2] === 'operstate') nic.oper = m[3].trim();
    else if (m[2] === 'carrier') nic.carrier = m[3].trim() === '1';
    else {
      const speed = Number(m[3]);
      nic.speed = Number.isFinite(speed) && speed > 0 ? speed : null; // -1 while the link is down
    }
  }
  return nics;
}

// hwmon: nvme controller name -> °C, CPU °C, and the DIMM sensors in I2C-address order.
function parseHwmon(linkLines, valueLines) {
  const home = new Map(); // hwmonN -> where it hangs off (resolved symlink target)
  for (const line of linkLines) {
    const m = line.match(/\s(hwmon\d+) -> (\S+)$/);
    if (m) home.set(m[1], m[2]);
  }
  const hw = new Map(); // hwmonN -> { name, temps: { 1: { label, input } } }
  for (const line of valueLines) {
    const m = line.match(/^\/sys\/class\/hwmon\/(hwmon\d+)\/(name|temp(\d+)_(label|input)):(.*)$/);
    if (!m) continue;
    const entry = hw.get(m[1]) || { name: null, temps: {} };
    hw.set(m[1], entry);
    if (m[2] === 'name') entry.name = m[5].trim();
    else (entry.temps[m[3]] ||= {})[m[4]] = m[5].trim();
  }
  // The temperature to use from a sensor: the NVMe composite, k10temp's Tctl, else the first.
  const pick = temps => {
    const all = Object.entries(temps).filter(([, t]) => t.input !== undefined && Number.isFinite(Number(t.input)));
    const best = all.find(([, t]) => /^(composite|tctl)$/i.test(t.label || '')) || all[0];
    return best ? round(Number(best[1].input) / 1000) : null;
  };
  const nvme = new Map(); // controller (nvme0) -> °C
  const dimms = [];       // { key: i2c address, tempC }
  let cpu = null;
  for (const [id, entry] of hw) {
    const target = home.get(id) || '';
    if (entry.name === 'nvme') {
      const ctrl = target.match(/\/nvme\/(nvme\d+)\//);
      if (ctrl) nvme.set(ctrl[1], pick(entry.temps));
    } else if (entry.name === 'k10temp') {
      cpu = pick(entry.temps);
    } else if (entry.name === 'spd5118') {
      dimms.push({ key: target.match(/\/(\d+-[0-9a-f]{4})\/hwmon\//)?.[1] ?? target, tempC: pick(entry.temps) });
    }
  }
  dimms.sort((a, b) => a.key.localeCompare(b.key));
  return { nvme, cpu, dimms };
}

// smartctl -n standby -A -j for one HDD -> { standby, tempC } (tempC null unless read now),
// or null when the output is unusable.
function parseSmart(lines) {
  let json;
  try { json = JSON.parse(lines.join('\n')); } catch (_) { return null; }
  const attrs = json.ata_smart_attributes?.table;
  if (Array.isArray(attrs)) {
    let tempC = json.temperature?.current;
    if (!Number.isFinite(tempC)) {
      const attr = attrs.find(a => a.id === 194) || attrs.find(a => a.id === 190);
      tempC = attr ? parseInt(attr.raw?.string, 10) : NaN; // "35 (Min/Max 20/45)"
    }
    return { standby: false, tempC: Number.isFinite(tempC) ? tempC : null };
  }
  // No attributes: with -n standby that is how a sleeping drive answers. The power mode is in
  // the JSON (argv also says "standby", so don't search the whole document).
  const said = [json.power_mode?.name, ...(json.smartctl?.messages || []).map(m => m.string)].join(' ');
  return /standby|sleep/i.test(said) ? { standby: true, tempC: null } : null;
}

// ---- Slots -----------------------------------------------------------------------------------
let configCache = { mtimeMs: -1, slots: {} };

function readSlotConfig() {
  let stat;
  try { stat = fs.statSync(CONFIG_FILE); } catch (_) { configCache = { mtimeMs: -1, slots: {} }; return configCache.slots; }
  if (stat.mtimeMs !== configCache.mtimeMs) {
    const slots = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      for (const [key, slot] of Object.entries(parsed.slots || {})) {
        if (typeof slot === 'string' || slot === null) slots[key] = slot;
        else console.error(`hardware: ${CONFIG_FILE}: slot for ${key} must be a string or null, ignored`);
      }
    } catch (err) {
      // A typo shouldn't take the live data down: carry on with the assumed slots.
      console.error(`hardware: ${CONFIG_FILE}: ${err.message}; using assumed slots`);
    }
    configCache = { mtimeMs: stat.mtimeMs, slots };
  }
  return configCache.slots;
}

// { slot, slotSource } for a part whose assumed slot is `assumed`, unless the config names it.
function slotFor(key, assumed, config) {
  if (key && Object.hasOwn(config, key)) return { slot: config[key], slotSource: 'config' };
  return { slot: assumed ?? null, slotSource: 'assumed' };
}

// ---- One run ---------------------------------------------------------------------------------
const smartKey = disk => disk.serial || disk.name;

// Read SMART from a drive that has never been read (once, to learn its temperature) or that has
// done I/O since the last read. An idle drive is left alone: the read would restart its
// spin-down timer, and its temperature can't have moved much.
function smartDue(disk, now) {
  const s = smart.get(smartKey(disk));
  if (!s) return true;
  if ((lastIo.get(disk.name) ?? 0) <= s.checkedAt) return false;
  return now - s.checkedAt >= (s.standby === true ? SMART_AFTER_WAKE_MS : SMART_EVERY_MS);
}

// The standby flag to report. Only a SMART read can tell, so: asleep at the last read and idle
// since means still asleep; I/O since means spinning; awake at the last read but idle for longer
// than a read interval means unknown (it may have spun down since).
function standbyNow(s, name, now) {
  const active = (lastIo.get(name) ?? 0) > s.checkedAt;
  if (s.standby === true) return !active;
  if (s.standby === false) return active || now - s.checkedAt <= SMART_EVERY_MS ? false : null;
  return null;
}

async function collect() {
  const now = Date.now();
  const due = knownHdds
    .filter(d => /^sd[a-z]+$/.test(d.name) && smartDue(d, now))
    .sort((a, b) => (smart.get(smartKey(a))?.checkedAt ?? 0) - (smart.get(smartKey(b))?.checkedAt ?? 0))
    .slice(0, SMART_MAX_PER_RUN);
  // Count the attempt now: if the run fails or a drive hangs, it isn't asked again next run.
  for (const d of due) smart.set(smartKey(d), { standby: null, tempC: null, tempAt: null, ...smart.get(smartKey(d)), checkedAt: now });
  const script = remoteScript(due.map(d => d.name));
  const out = await sshExec(`sh -c '${script}'`, { timeout: 20_000 });
  const sec = sections(out);
  const lines = tag => sec.get(tag)?.lines ?? [];
  const uptime = Number(sec.get('uptime')?.arg);
  if (!(uptime > 0) || !sec.has('diskstats')) throw new Error('unexpected output from WTR (no /proc data)');

  const sampledAt = new Date().toISOString();
  const elapsed = previous && uptime > previous.uptime ? uptime - previous.uptime : 0;
  // Rate of a counter since the previous sample; 0 when there is none or the counter went backwards.
  const rate = (cur, before) => (elapsed > 0 && before !== undefined && cur >= before ? (cur - before) / elapsed : 0);

  const stats = parseDiskstats(lines('diskstats'));
  const byPath = parseByPath(lines('bypath'));
  const serials = parseSerials(lines('lsblk'));
  const hwmon = parseHwmon(lines('hwmonlinks'), lines('hwmon'));
  const config = readSlotConfig();

  // Disks: whole disks on a SATA port or NVMe controller, HDDs by port then NVMe by PCI address.
  const found = [...byPath].filter(([name]) => stats.has(name)).map(([name, info]) => ({ name, ...info }));
  const hdds = found.filter(d => d.kind === 'hdd').sort((a, b) => a.pci.localeCompare(b.pci) || a.ata - b.ata);
  const nvmes = found.filter(d => d.kind === 'nvme').sort((a, b) => a.pci.localeCompare(b.pci) || a.name.localeCompare(b.name));
  const nextCounters = { uptime, disks: new Map(), nics: new Map() };
  const freshTemps = new Set(); // names whose temperature was read in this run, for the history

  // Fold in what smartctl said this run, for the drives it was asked about.
  for (const d of hdds) {
    const result = sec.has(`smart:${d.name}`) ? parseSmart(sec.get(`smart:${d.name}`).lines) : undefined;
    const key = serials.get(d.name) || d.name;
    if (result !== undefined) {
      const old = smart.get(key);
      smart.set(key, {
        checkedAt: now,
        standby: result ? result.standby : null,
        tempC: result?.tempC ?? old?.tempC ?? null,
        tempAt: result?.tempC != null ? sampledAt : old?.tempAt ?? null,
      });
      if (result?.tempC != null) freshTemps.add(d.name);
    }
  }

  const make = (d, index) => {
    const cur = stats.get(d.name);
    const before = previous?.disks.get(d.name);
    nextCounters.disks.set(d.name, cur);
    if (before && (cur.rdIos > before.rdIos || cur.wrIos > before.wrIos)) lastIo.set(d.name, now);
    const serial = serials.get(d.name) || '';
    const assumed = d.kind === 'hdd'
      ? (d.ata >= 1 && d.ata <= DEFAULTS.sataBays ? `bay${d.ata}` : null)
      : DEFAULTS.nvmeSlots[index] ?? null;
    let tempC = null, tempAt = null, standby = null;
    if (d.kind === 'nvme') {
      tempC = hwmon.nvme.get(d.name.match(/^(nvme\d+)n\d+$/)[1]) ?? null;
      tempAt = tempC == null ? null : sampledAt;
    } else {
      const s = smart.get(serial || d.name);
      if (s) {
        tempC = s.tempC;
        tempAt = s.tempAt;
        standby = standbyNow(s, d.name, now);
      }
    }
    return {
      name: d.name,
      serial,
      kind: d.kind,
      port: d.port,
      ...slotFor(serial, assumed, config),
      readBps: round(rate(cur.rdSectors, before?.rdSectors) * SECTOR, 0),
      writeBps: round(rate(cur.wrSectors, before?.wrSectors) * SECTOR, 0),
      readIops: round(rate(cur.rdIos, before?.rdIos)),
      writeIops: round(rate(cur.wrIos, before?.wrIos)),
      // io_ticks is milliseconds with I/O in flight.
      busyPct: round(Math.min(100, rate(cur.ioTicks, before?.ioTicks) / 10)),
      tempC,
      tempAt,
      standby,
    };
  };
  const disks = [...hdds.map(d => make(d, 0)), ...nvmes.map(make)];
  knownHdds = hdds.map(d => ({ name: d.name, serial: serials.get(d.name) || '' }));

  // NICs: physical ports, grouped by driver and numbered in PCI order within the group.
  const netdev = parseNetdev(lines('netdev'));
  const nicInfo = parseNics(lines('nicdev'), lines('nicstate'));
  const drivers = Object.keys(DEFAULTS.nics);
  const nicList = [...nicInfo].filter(([name]) => netdev.has(name))
    .map(([name, n]) => ({ name, ...n }))
    .sort((a, b) => (drivers.indexOf(a.driver) + 1 || 99) - (drivers.indexOf(b.driver) + 1 || 99) || (a.pci || '').localeCompare(b.pci || ''));
  const seenInGroup = {};
  const nics = nicList.map(n => {
    const group = DEFAULTS.nics[n.driver];
    const index = seenInGroup[n.driver] = (seenInGroup[n.driver] ?? -1) + 1;
    const cur = netdev.get(n.name);
    const before = previous?.nics.get(n.name);
    nextCounters.nics.set(n.name, cur);
    return {
      name: n.name,
      ...slotFor(n.name, group?.slots[index], config),
      kind: group?.kind ?? n.driver ?? 'Ethernet',
      up: n.carrier ?? n.oper === 'up',
      speedMbps: n.speed,
      rxBps: round(rate(cur.rx, before?.rx), 0),
      txBps: round(rate(cur.tx, before?.tx), 0),
    };
  });

  const memory = hwmon.dimms.map((d, i) => ({ slot: DEFAULTS.memorySlots[i] ?? `ram${i + 1}`, tempC: d.tempC }));
  previous = nextCounters;

  const ts = Math.floor(Date.now() / 1000);
  replaceTable('hw_host', [{ id: 1, sampled_at: sampledAt, interval_s: round(elapsed, 2), cpu_temp_c: hwmon.cpu }]);
  replaceTable('hw_memory', memory.map(m => ({ slot: m.slot, temp_c: m.tempC })));
  replaceTable('hw_disks', disks.map((d, pos) => ({
    name: d.name, pos, serial: d.serial, kind: d.kind, port: d.port, slot: d.slot, slot_source: d.slotSource,
    read_bps: d.readBps, write_bps: d.writeBps, read_iops: d.readIops, write_iops: d.writeIops, busy_pct: d.busyPct,
    temp_c: d.tempC, temp_at: d.tempAt, standby: d.standby,
  })));
  replaceTable('hw_nics', nics.map((n, pos) => ({
    name: n.name, pos, slot: n.slot, slot_source: n.slotSource, kind: n.kind, up: n.up, speed_mbps: n.speedMbps,
    rx_bps: n.rxBps, tx_bps: n.txBps,
  })));

  // History. Rates only once there is an interval to average over (not on the first run after a
  // start, which would record a false zero); an HDD temperature only when it was actually read.
  transaction(() => {
    const put = (series, value) => insertMetric.run({ series, ts, value });
    if (hwmon.cpu != null) put('cpu.temp', hwmon.cpu);
    for (const d of disks) {
      // Disk series are keyed by serial (sdX letters can move across reboots); NICs by name.
      const id = (d.serial || d.name).replace(/[^A-Za-z0-9_-]/g, '_');
      if (elapsed > 0) {
        put(`disk.${id}.read`, d.readBps);
        put(`disk.${id}.write`, d.writeBps);
        put(`disk.${id}.busy`, d.busyPct);
      }
      if (d.tempC != null && (d.kind === 'nvme' || freshTemps.has(d.name))) put(`disk.${id}.temp`, d.tempC);
    }
    if (elapsed > 0) {
      for (const n of nics) {
        put(`nic.${n.name}.rx`, n.rxBps);
        put(`nic.${n.name}.tx`, n.txBps);
      }
    }
  });

  return { via: 'ssh' };
}

module.exports = [{ name: 'hardware', intervalMs: 10_000, timeoutMs: 25_000, run: collect }];
