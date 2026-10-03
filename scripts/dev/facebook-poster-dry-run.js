#!/usr/bin/env node
/**
 * Non-posting integration check for the Facebook poster. Manual use only.
 * Run after `npm run build:electron`:
 *   node scripts/dev/facebook-poster-dry-run.js --profile-dir <dir> --engine <chrome> --group-url <url>
 * Never clicks Publish. Exit 0 = all checks pass, 1 = a check failed, 2 = not logged in.
 */
const path = require('path');
const { execSync } = require('child_process');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const profileArg = arg('profile-dir');
const profileDir = profileArg && path.resolve(profileArg);
const engine = arg('engine');
const groupUrl = arg('group-url');
if (!profileDir || !engine || !groupUrl) {
  console.error('usage: --profile-dir <dir> --engine <chrome path> --group-url <url>');
  process.exit(1);
}

const dist = path.join(__dirname, '..', '..', 'dist-electron', 'src', 'services');
const { launchAutomationBrowser } = require(path.join(dist, 'browser', 'automationLauncher.js'));
const { buildLaunchArgs, hostPersona } = require(path.join(dist, 'browser', 'fingerprint.js'));
const poster = require(path.join(dist, 'facebookPoster', 'postToTargets.js'));
const { isLoggedIn } = require(path.join(dist, 'facebookPoster', 'loginState.js'));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

// Read-only: does a Publish-labelled button exist? Never marks or clicks it.
// IN-PAGE function: self-contained, one argument, no console.*.
function publishButtonExistsInPage(labels) {
  let roots = Array.from(document.querySelectorAll('div[role="dialog"]'));
  if (!roots.length && location.pathname.startsWith('/post/create')) roots = [document];
  return roots.some(root => Array.from(root.querySelectorAll('div[role="button"], button')).some(b =>
    labels.includes((b.getAttribute('aria-label') || '').trim()) || labels.includes((b.innerText || '').trim())));
}

// Processes of THIS browser only: selected by our own unique --user-data-dir.
function browserProcesses() {
  const out = execSync('ps -eo pid=,args=', { encoding: 'utf8' });
  const flag = `--user-data-dir=${profileDir}`;
  return out.split('\n').map(l => l.trim()).filter(l => l.split(/\s+/).includes(flag))
    .map(l => ({ pid: Number(l.split(/\s+/)[0]), args: l.slice(l.indexOf(' ') + 1) }));
}

function listeningPorts(pids) {
  let out = '';
  try { out = execSync('ss -ltnpH', { encoding: 'utf8' }); } catch { return null; } // null = cannot tell, caller fails closed
  return out.split('\n').filter(l => pids.some(p => l.includes(`pid=${p},`)));
}

(async () => {
  const args = ['--remote-debugging-pipe', ...buildLaunchArgs({
    userDataDir: profileDir,
    fingerprint: { seed: 123456, hardwareConcurrency: 8, language: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh' },
    persona: hostPersona(process.platform),
    proxyPort: null,
  })];
  let code = 1;
  let ctx = null;
  try {
    ctx = await launchAutomationBrowser(engine, profileDir, args);
    const procs = browserProcesses();
    const main = procs.find(p => !p.args.includes('--type='));
    console.log(`browser pid: ${main ? main.pid : 'NOT FOUND'}`);
    console.log(`command line:\n${main ? main.args.split(' --').join('\n  --') : ''}`);
    check('main browser process found', !!main);
    check('no --remote-debugging-port flag', !!main && !/--remote-debugging-port/.test(main.args));
    check('--remote-debugging-pipe present', !!main && main.args.includes('--remote-debugging-pipe'));
    const ports = listeningPorts(procs.map(p => p.pid));
    check('ss available', ports !== null);
    console.log(`listening TCP ports of ${procs.length} browser processes: ${ports && ports.length ? '\n' + ports.join('\n') : 'none'}`);
    check('no listening TCP port', ports !== null && ports.length === 0);

    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('about:blank');
    const webdriver = await page.evaluate(() => navigator.webdriver);
    check('navigator.webdriver is false', webdriver === false, `value=${webdriver}`);

    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
    if (!(await isLoggedIn(ctx))) {
      console.log('NOT LOGGED IN: composer step skipped (log in once in this profile to run it).');
      code = results.every(r => r.ok) ? 2 : 1;
      return;
    }
    if (!(await page.evaluate(poster.markComposerInviteInPage, poster.COMPOSER_INVITE))) {
      check('composer invite found', false);
    } else {
      await page.locator('[data-maihub-target="composer-invite"]').first().click({ timeout: 10000 });
      await page.waitForFunction(poster.composerIsOpenInPage, poster.EDITOR_SELECTORS, { timeout: 20000 });
      check('composer opened', true);
      check('editor focused', await page.evaluate(poster.focusEditorInPage, poster.EDITOR_SELECTORS));
      await page.keyboard.insertText('thử khô, không đăng');
      await page.waitForTimeout(1500);
      const disabled = await page.evaluate(poster.isPublishDisabledInPage, poster.PUBLISH_LABELS);
      const exists = await page.evaluate(publishButtonExistsInPage, poster.PUBLISH_LABELS);
      check('Publish button exists (NOT clicked)', exists === true);
      check('Publish enabled after typing (NOT clicked)', exists === true && disabled === false);
    }
    code = results.every(r => r.ok) ? 0 : 1;
  } catch (err) {
    console.error(`ERROR: ${err && err.message}`);
    code = 1;
  } finally {
    if (ctx) await ctx.close().catch(() => {}); // closes without publishing; unposted text is discarded
    console.log(`exit ${code}`);
    process.exit(code);
  }
})();
