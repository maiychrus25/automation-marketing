// Lệnh hyperframes giả cho test: FAKE_MODE = ok | fail | fail-hint | hang | stubborn | silent
const fs = require('fs');
const argv = process.argv.slice(2);
const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const out = val('-o');
if (process.env.FAKE_LOG) fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, cwd: process.cwd(), env: { t: process.env.HYPERFRAMES_NO_TELEMETRY, d: process.env.DO_NOT_TRACK, s: process.env.HYPERFRAMES_SKIP_SKILLS } }));
const mode = process.env.FAKE_MODE || 'ok';
// `hyperframes lint <dir> --json`: FAKE_LINT = ok | errors | garbage
if (argv[0] === 'lint') {
  const lint = process.env.FAKE_LINT || 'ok';
  if (lint === 'garbage') { process.stdout.write('not json\n'); process.exit(2); }
  const errors = lint === 'errors' ? [
    { code: 'root_missing_composition_id', severity: 'error', message: 'Root composition is missing `data-composition-id`.' },
    { code: 'missing_timeline_registry', severity: 'error', message: 'Missing `window.__timelines` registration.' },
  ] : [];
  const warn = { code: 'studio_missing_editable_id', severity: 'warning', message: 'no id' };
  process.stdout.write(JSON.stringify({ ok: errors.length === 0, errorCount: errors.length, warningCount: 1, findings: [...errors, warn] }, null, 2) + '\n');
  process.exit(errors.length ? 1 : 0);
}
const p = (code, pct) => process.stdout.write(`  ███░░░  ${pct}%  x\r@hf-progress ${JSON.stringify({ code, pct })}\n`);
if (mode === 'fail') { process.stderr.write('Boom: composition invalid\n'); process.exit(3); }
// Giống HyperFrames 0.8.181 thật: lỗi nằm ở dòng tiến độ "Failed: …", cuối cùng là một dòng gợi ý chung.
if (mode === 'fail-hint') {
  process.stdout.write('  ██████░░░░░░░░░░░░░░░░░░░  25%  Failed: Disk capture may need ~1990.7 MB of temporary frame storage, but only 2146.8 MB is free\n');
  process.stdout.write('[INFO] [Render] Failure summary {"failedStage":"Checking browser GPU"}\n\n');
  process.stdout.write('\u2717  Render failed\n\n   Disk capture may need ~1990.7 MB of temporary frame storage\n   Try --docker for containerized rendering\n');
  process.exit(1);
}
if (mode === 'stubborn') process.on('SIGTERM', () => {});
if (mode === 'hang' || mode === 'stubborn') { p('capture', 40); setInterval(() => {}, 1000); }
else {
  p('compile', 5); p('capture', 50);
  if (mode !== 'silent') p('capture', 80);
  setTimeout(() => { fs.copyFileSync(process.env.FAKE_VIDEO, out); p('assemble', 99); process.exit(0); }, Number(process.env.FAKE_DELAY || 0));
}
