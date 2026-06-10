#!/usr/bin/env node
/*
 * SKOLARIS dev orchestrator — single canonical `npm run dev` entry point.
 *
 * Reads .env, decides which services the current configuration needs, spawns
 * them as child processes with prefixed/coloured log forwarding, and shuts
 * them all down cleanly on Ctrl+C.
 *
 * Cross-platform: pure Node + child_process. No bash, no shell scripts. Uses
 * the same `concurrently`-style log prefixing convention so the dev surface
 * matches what dev:full produces today.
 *
 * Production-safe: this file is invoked ONLY by `npm run dev`. Render, prod
 * containers, WORKER_MODE deployments, and the existing dev:full / ocr:real
 * scripts all keep working exactly as before — they don't go through this
 * file.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { URL } from 'node:url';

const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
const ROOT = process.cwd();

// ─── Tiny ANSI helper (no chalk dep) ──────────────────────────────────────
const ansi = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const bold = ansi('1');
const dim = ansi('2');
const red = ansi('31');
const green = ansi('32');
const yellow = ansi('33');
const blue = ansi('34');
const magenta = ansi('35');
const cyan = ansi('36');
const gray = ansi('90');

// ─── .env loader (lite, no dotenv dep — we don't write process.env globally) ─
const loadDotEnv = () => {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
};

const env = { ...loadDotEnv(), ...process.env };
const truthy = (v) => v === 'true' || v === '1' || v === 'yes';

// ─── Service configuration (decide what to start) ─────────────────────────
const WORKER_MODE = (env.WORKER_MODE || 'api').toLowerCase();
// Queue driver. Default `inline` runs OCR/notifications/analytics in-process
// with NO Redis: skip the Redis probe, the standalone OCR worker, and the
// abort-on-unreachable. Only `redis` keeps the BullMQ topology (probe + worker).
const QUEUE_DRIVER = (env.QUEUE_DRIVER || 'inline').toLowerCase();
const USES_REDIS = QUEUE_DRIVER === 'redis';
const HANDWRITING_ENABLED =
  truthy(env.HANDWRITING_OCR_ENABLED) || truthy(env.HANDWRITING_ENABLED);
const PRINTED_VIA_PADDLE = truthy(env.PRINTED_OCR_VIA_PADDLE);
const NEEDS_PYTHON_SERVICE = HANDWRITING_ENABLED || PRINTED_VIA_PADDLE;
const REDIS_URL = env.REDIS_URL || 'redis://localhost:6380';
const API_PORT = env.PORT || '3000';
const PYTHON_PORT = env.PRINTED_OCR_URL ? new URL(env.PRINTED_OCR_URL).port || '8001' : '8001';

const services = [];

services.push({
  name: 'api',
  label: 'API',
  color: blue,
  command: NPM,
  args: ['run', 'start:dev'],
  cwd: ROOT,
});

// OCR worker: only the Redis/BullMQ topology needs a standalone consumer.
// With QUEUE_DRIVER=inline OCR runs in-process, so no external worker.
// In-process (WORKER_MODE=both) also doesn't need an external worker.
if (USES_REDIS && WORKER_MODE !== 'both') {
  services.push({
    name: 'ocr',
    label: 'OCR',
    color: yellow,
    command: NPM,
    args: ['run', 'ocr:real'],
    cwd: ROOT,
  });
}

// Python handwriting / printed-OCR service: opt-in.
let pythonStatus = 'disabled';
if (NEEDS_PYTHON_SERVICE) {
  const venvCandidates = IS_WIN
    ? ['ocr-handwriting/.venv/Scripts/python.exe', 'ocr-handwriting/venv/Scripts/python.exe']
    : ['ocr-handwriting/.venv/bin/python', 'ocr-handwriting/venv/bin/python'];
  const venvPy = venvCandidates.map((p) => join(ROOT, p)).find(existsSync);
  if (venvPy) {
    services.push({
      name: 'paddle',
      label: 'PADDLE',
      color: magenta,
      command: venvPy,
      args: ['-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', PYTHON_PORT],
      cwd: join(ROOT, 'ocr-handwriting'),
      env: {
        // pass-through; HW_OCR_MODEL/OCR_CALLBACK_SECRET/STORAGE_READ_BASE_URL etc.
        ...process.env,
        HW_OCR_MODEL: env.HW_OCR_MODEL || 'paddle',
        STORAGE_READ_BASE_URL:
          env.STORAGE_READ_BASE_URL || `http://localhost:${API_PORT}/api`,
      },
    });
    pythonStatus = `enabled (${venvPy.replace(ROOT, '.')}, port ${PYTHON_PORT})`;
  } else {
    pythonStatus = red(
      `MISSING VENV — expected one of: ${venvCandidates.join(' or ')}. ` +
        `Run \`cd ocr-handwriting && python -m venv .venv && ` +
        `.venv/${IS_WIN ? 'Scripts' : 'bin'}/${IS_WIN ? 'pip.exe' : 'pip'} install ` +
        `-r requirements.txt -r requirements-paddle.txt\` to set it up.`,
    );
  }
}

// ─── Pre-flight: TCP probe Redis ─────────────────────────────────────────
const probeTcp = (host, port, timeoutMs = 1500) =>
  new Promise((resolve) => {
    const sock = createConnection({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });

const parseRedis = (url) => {
  try {
    const u = new URL(url);
    return { host: u.hostname || 'localhost', port: Number(u.port || 6379) };
  } catch {
    return { host: 'localhost', port: 6380 };
  }
};

// ─── Pretty printers ─────────────────────────────────────────────────────
const banner = () => {
  console.log('');
  console.log(bold(cyan('  SKOLARIS Development Environment')));
  console.log(gray('  ─────────────────────────────────────'));
};

const summary = (redisOk) => {
  console.log('');
  for (const s of services) {
    const where =
      s.name === 'api'
        ? gray(`(http://localhost:${API_PORT})`)
        : s.name === 'paddle'
          ? gray(`(uvicorn :${PYTHON_PORT})`)
          : '';
    console.log(`  ${green('✓')} ${s.label.padEnd(8)} ${where}`);
  }
  if (NEEDS_PYTHON_SERVICE && !services.find((s) => s.name === 'paddle')) {
    console.log(`  ${red('✗')} PADDLE   ${pythonStatus}`);
  }
  if (USES_REDIS) {
    console.log(
      `  ${redisOk ? green('✓') : red('✗')} REDIS    ${gray(`(${REDIS_URL})`)} ${
        redisOk ? '' : red('— not reachable — run `docker compose up -d redis`')
      }`,
    );
  } else {
    console.log(`  ${gray('•')} REDIS    ${gray('(not required — QUEUE_DRIVER=inline)')}`);
  }
  console.log('');
  console.log(`  ${bold(green('Ready for development.'))}  ${gray('Ctrl+C to stop all services.')}`);
  console.log('');
};

// ─── Spawn + line-prefixed forwarding ────────────────────────────────────
const children = [];
let shuttingDown = false;

const startService = (svc) => {
  // On Windows, Node 20+ refuses to spawn .cmd / .bat files without shell:true
  // (CVE-2024-27980 mitigation; EINVAL otherwise). When shell:true is set,
  // passing args alongside a command also triggers DEP0190 noise. To get
  // EINVAL-safe AND warning-free behaviour we collapse cmd+args into a single
  // pre-quoted string and pass args=[] — the shell does the parsing.
  // Linux/macOS keep shell:false and use the standard cmd+args form. The
  // Python path uses an absolute venv binary and doesn't need a shell either way.
  const isCmd = /\.(cmd|bat)$/i.test(svc.command);
  const useShell = IS_WIN && isCmd;
  const cmd = useShell
    ? [svc.command, ...svc.args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')
    : svc.command;
  const args = useShell ? [] : svc.args;
  const child = spawn(cmd, args, {
    cwd: svc.cwd,
    env: svc.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: useShell,
    windowsHide: true,
  });
  children.push({ svc, child });

  const prefix = svc.color(`[${svc.label.toLowerCase()}]`);
  const stream = (chunk, isErr) => {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const target = isErr ? process.stderr : process.stdout;
      target.write(`${prefix} ${line}\n`);
    }
  };
  child.stdout.on('data', (b) => stream(b, false));
  child.stderr.on('data', (b) => stream(b, true));
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const dimMsg = signal ? `signal ${signal}` : `exit code ${code}`;
    console.log(`${prefix} ${red('terminated')} ${dim(dimMsg)}`);
    // If the API or the OCR worker dies during dev, shut down the rest —
    // mimics dev:full's --kill-others-on-fail. Paddle dying is a soft fail.
    if (svc.name === 'api' || svc.name === 'ocr') shutdown(code ?? 1);
  });
};

const shutdown = (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('');
  console.log(yellow('  Shutting down…'));
  for (const { svc, child } of children) {
    if (child.exitCode !== null) continue;
    try {
      if (IS_WIN) {
        // Windows: SIGINT/SIGTERM don't propagate cleanly to child trees.
        // taskkill ensures grandchildren (e.g. ts-node spawning tesseract)
        // are also killed.
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
      console.log(`  ${gray(`stopped`)} ${svc.color(svc.label.toLowerCase())}`);
    } catch (err) {
      console.log(`  ${red('error stopping')} ${svc.label.toLowerCase()}: ${err?.message ?? err}`);
    }
  }
  // Give children a moment, then exit hard.
  setTimeout(() => process.exit(exitCode), 800);
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ─── Main ────────────────────────────────────────────────────────────────
const main = async () => {
  banner();
  // Only the Redis queue driver probes Redis. Inline driver needs no Redis,
  // so skip the probe and the abort-on-unreachable entirely.
  let redisOk = false;
  if (USES_REDIS) {
    const { host, port } = parseRedis(REDIS_URL);
    redisOk = await probeTcp(host, port);
  }

  // Print preflight before spawning anything noisy.
  summary(redisOk);

  if (USES_REDIS && !redisOk) {
    console.log(red('  Redis is not reachable. Aborting.'));
    process.exit(2);
  }

  // Show what we're about to start in one line per service so the user sees
  // the orchestration up front, BEFORE the inevitable startup-log avalanche.
  console.log(gray('  Starting services…'));
  for (const svc of services) startService(svc);
};

main().catch((err) => {
  console.error(red('  dev orchestrator failed:'), err);
  process.exit(1);
});
