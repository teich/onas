// Proxmox Backup Server API client, the same shape as pve.js. Uses the HTTPS API with the
// read-only token PBS_TOKEN (onas@pbs!onas, Audit on /; see ops/guests/119-onas/create-pbs-token)
// when it is set, and otherwise `proxmox-backup-debug api get` inside the PBS container over SSH,
// which returns the same JSON. PBS's certificate is self-signed, so it's pinned to the
// fingerprint PVE already trusts for the `pbs-lxc` storage.
const https = require('https');
const pve = require('./pve');
const { sshExec } = require('./ssh');

const VMID = Number(process.env.PBS_VMID || 112);
const STORAGE = process.env.PBS_STORAGE || 'pbs-lxc';
const TOKEN = process.env.PBS_TOKEN || '';

let target = null; // { host, fingerprint } from PVE's storage config, fetched once
// No TLS session reuse: a resumed session carries no peer certificate to check the pin against.
const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });

async function resolveTarget() {
  if (!target) {
    const { data } = await pve.get(`/storage/${STORAGE}`);
    if (!data?.server || !data?.fingerprint) throw new Error(`PVE storage ${STORAGE} has no PBS server or fingerprint`);
    target = { host: data.server, fingerprint: data.fingerprint.toUpperCase() };
  }
  return target;
}

function apiRequest(apiPath, params, { host, fingerprint }) {
  const query = new URLSearchParams(params || {}).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      port: 8007,
      path: `/api2/json${apiPath}${query ? `?${query}` : ''}`,
      headers: { Authorization: `PBSAPIToken=${TOKEN}` },
      agent,
      rejectUnauthorized: false, // self-signed; checked against the pinned fingerprint below
      timeout: 20_000,
    }, res => {
      const cert = res.socket.getPeerCertificate();
      if (!cert?.fingerprint256 || cert.fingerprint256.toUpperCase() !== fingerprint) {
        res.destroy();
        target = null; // re-read PVE's storage config next time, in case PBS got a new certificate
        return reject(new Error(`PBS certificate does not match the fingerprint in PVE storage ${STORAGE}`));
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`PBS GET ${apiPath}: ${res.statusCode} ${res.statusMessage} ${raw.slice(0, 300)}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(raw).data); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`PBS GET ${apiPath}: timeout`)));
    req.on('error', reject);
    req.end();
  });
}

const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

// Read a path. Returns { data, via }.
async function get(apiPath, params) {
  if (TOKEN) {
    return { data: await apiRequest(apiPath, params, await resolveTarget()), via: 'api' };
  }
  const args = Object.entries(params || {}).map(([k, v]) => `--${k} ${shellQuote(v)}`).join(' ');
  const out = await sshExec(`pct exec ${VMID} -- proxmox-backup-debug api get ${shellQuote(apiPath)} ${args} --output-format json`, { timeout: 60_000 });
  return { data: JSON.parse(out || 'null'), via: 'ssh' };
}

module.exports = { get, hasToken: () => Boolean(TOKEN) };
