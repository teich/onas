// Proxmox VE API client. Uses the HTTPS API with a token when one is configured, and falls
// back to `pvesh` over SSH otherwise. Both return the same JSON for the same path.
const fs = require('fs');
const https = require('https');
const tls = require('tls');
const { sshExec, sshCapture } = require('./ssh');

const NODE = process.env.PVE_NODE || 'wtr';
const API_HOST = process.env.PVE_API_HOST || '192.168.2.2';
// WTR's certificate names "wtr" (and an old IP), not 192.168.2.2, so verify against that name.
const API_SERVERNAME = process.env.PVE_API_SERVERNAME || NODE;
const CA_PATH = process.env.PVE_CA || '/etc/onas/pve-ca.pem';
const TOKENS = {
  read: process.env.PVE_COLLECTOR_TOKEN || '',
  write: process.env.PVE_ACTIONS_TOKEN || '',
};

let ca = null;
try { ca = fs.readFileSync(CA_PATH); } catch (_) { /* no CA: API transport disabled */ }

function apiAvailable(kind) {
  return Boolean(ca && TOKENS[kind]);
}

function apiRequest(method, apiPath, params, token) {
  const query = new URLSearchParams(params || {}).toString();
  const body = method === 'GET' ? '' : query;
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: API_HOST,
      port: 8006,
      method,
      path: `/api2/json${apiPath}${method === 'GET' && query ? `?${query}` : ''}`,
      headers: {
        Authorization: `PVEAPIToken=${token}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
      ca,
      servername: API_SERVERNAME,
      checkServerIdentity: (_host, cert) => tls.checkServerIdentity(API_SERVERNAME, cert),
      timeout: 15_000,
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`PVE ${method} ${apiPath}: ${res.statusCode} ${res.statusMessage} ${raw.slice(0, 300)}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        try { resolve(JSON.parse(raw).data); } catch (err) { reject(err); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`PVE ${method} ${apiPath}: timeout`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function pveshArgs(params) {
  return Object.entries(params || {}).map(([k, v]) => `--${k} ${shellQuote(v)}`).join(' ');
}

// Read a path. Returns { data, via }. Falls back to pvesh over SSH when there's no token, or
// when the read token isn't allowed (PVE 9 wants Sys.Modify just to list apt updates).
async function get(apiPath, params) {
  if (apiAvailable('read')) {
    try {
      return { data: await apiRequest('GET', apiPath, params, TOKENS.read), via: 'api' };
    } catch (err) {
      if (err.statusCode !== 403) throw err;
    }
  }
  const out = await sshExec(`pvesh get ${shellQuote(apiPath)} ${pveshArgs(params)} --output-format json`);
  return { data: JSON.parse(out || 'null'), via: 'ssh' };
}

// Change something. Returns { ok, output, exitCode, via } and never throws, so callers can log it.
async function post(apiPath, params) {
  if (apiAvailable('write')) {
    try {
      const data = await apiRequest('POST', apiPath, params, TOKENS.write);
      return { ok: true, output: typeof data === 'string' ? data : JSON.stringify(data ?? ''), exitCode: 0, via: 'api' };
    } catch (err) {
      return { ok: false, output: err.message, exitCode: 1, via: 'api' };
    }
  }
  const r = await sshCapture(`pvesh create ${shellQuote(apiPath)} ${pveshArgs(params)}`);
  return { ok: r.exitCode === 0, output: [r.stdout, r.stderr].filter(Boolean).join('\n').trim(), exitCode: r.exitCode, via: 'ssh' };
}

async function del(apiPath, params) {
  if (apiAvailable('write')) {
    try {
      const data = await apiRequest('DELETE', apiPath, params, TOKENS.write);
      return { ok: true, output: typeof data === 'string' ? data : '', exitCode: 0, via: 'api' };
    } catch (err) {
      return { ok: false, output: err.message, exitCode: 1, via: 'api' };
    }
  }
  const r = await sshCapture(`pvesh delete ${shellQuote(apiPath)} ${pveshArgs(params)}`);
  return { ok: r.exitCode === 0, output: [r.stdout, r.stderr].filter(Boolean).join('\n').trim(), exitCode: r.exitCode, via: 'ssh' };
}

module.exports = { NODE, get, post, del, apiAvailable };
