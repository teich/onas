// Every change made through onas is recorded here (replaces the old in-memory activity log).
const { db } = require('./db');
const scheduler = require('./scheduler');

const insert = db.prepare(`
  INSERT INTO actions (at, actor, action, target, ok, exit_code, output)
  VALUES ($at, $actor, $action, $target, $ok, $exit_code, $output)
`);

// result: { ok, exitCode, output } (or { exitCode, stdout, stderr } from a shell command)
function record(action, target, result, actor = 'ui') {
  const ok = result.ok ?? result.exitCode === 0;
  const output = result.output ?? [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  insert.run({
    at: new Date().toISOString(),
    actor,
    action,
    target,
    ok: ok ? 1 : 0,
    exit_code: result.exitCode ?? null,
    output: (output || '').slice(0, 20_000),
  });
  scheduler.events.emit('change', 'actions');
  return { ok, output };
}

module.exports = { record };
