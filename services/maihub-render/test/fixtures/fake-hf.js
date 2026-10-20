// Lệnh hyperframes giả cho test: FAKE_MODE = ok | fail | hang | stubborn | silent
const fs = require('fs');
const argv = process.argv.slice(2);
const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const out = val('-o');
if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, cwd: process.cwd(), env: { t: process.env.HYPERFRAMES_NO_TELEMETRY, d: process.env.DO_NOT_TRACK, s: process.env.HYPERFRAMES_SKIP_SKILLS } }));
const mode = process.env.FAKE_MODE || 'ok';
const p = (code, pct) => process.stdout.write(`  ███░░░  ${pct}%  x\r@hf-progress ${JSON.stringify({ code, pct })}\n`);
if (mode === 'fail') { process.stderr.write('Boom: composition invalid\n'); process.exit(3); }
if (mode === 'stubborn') process.on('SIGTERM', () => {});
if (mode === 'hang' || mode === 'stubborn') { p('capture', 40); setInterval(() => {}, 1000); }
else {
  p('compile', 5); p('capture', 50);
  if (mode !== 'silent') p('capture', 80);
  setTimeout(() => { fs.copyFileSync(process.env.FAKE_VIDEO, out); p('assemble', 99); process.exit(0); }, Number(process.env.FAKE_DELAY || 0));
}
