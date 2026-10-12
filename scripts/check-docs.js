/**
 * check-docs.js - fails when the system docs drift from the code.
 *
 * Three deterministic checks (see docs/specs/2026-10-12-poster-cancel-sandbox-docs.md 5.3):
 *   1. app version line in SYSTEM_DOCUMENTATION.md equals package.json version
 *   2. `<!-- docs-check: file#CONST = N -->` markers equal the constant in the source
 *   3. backticked repo paths in the docs exist
 *
 * Usage: node scripts/check-docs.js [repoRoot]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VERSION_LABEL = 'Phiên bản ứng dụng được khảo sát';
const PATH_PREFIXES = ['src/', 'electron/', 'scripts/', 'docs/', 'resources/', 'public/', '.github/'];
const PATH_DOCS = ['SYSTEM_DOCUMENTATION.md', 'README.md', 'DESIGN.md', 'AGENTS.md'];

function evaluateNumber(expr) {
  if (!/^[\d\s_*+]+$/.test(expr)) return null;
  const clean = expr.replace(/_/g, '');
  if (/\d\s+\d/.test(clean)) return null;
  const sum = clean.split('+').reduce((acc, term) => {
    if (acc === null) return null;
    const factors = term.split('*').map((f) => f.trim());
    if (factors.some((f) => !/^\d+$/.test(f))) return null;
    return acc + factors.reduce((p, f) => p * Number(f), 1);
  }, 0);
  return sum;
}

function findConstant(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^[ \\t]*(?:export\\s+)?const\\s+${escaped}\\s*(?::[^=]+)?=\\s*([^;\\n]+?)\\s*;`, 'm');
  const match = re.exec(source);
  return match ? evaluateNumber(match[1]) : null;
}

function checkVersion(docText, version) {
  const line = docText.split('\n').find((l) => l.includes(VERSION_LABEL));
  if (!line) return [`SYSTEM_DOCUMENTATION.md: thiếu dòng "${VERSION_LABEL}"`];
  const found = /`(\d+\.\d+\.\d+[^`]*)`/.exec(line);
  if (!found) return [`SYSTEM_DOCUMENTATION.md: dòng "${VERSION_LABEL}" không có phiên bản trong dấu backtick`];
  if (found[1] !== version) {
    return [`SYSTEM_DOCUMENTATION.md: phiên bản trong tài liệu ${found[1]} khác package.json ${version}`];
  }
  return [];
}

function checkConstantMarkers(docFile, docText, readFile) {
  const errors = [];
  const re = /<!--\s*docs-check:\s*(\S+?)#(\w+)\s*=\s*(\d+)\s*-->/g;
  let m;
  while ((m = re.exec(docText)) !== null) {
    const [, rel, name, expected] = m;
    const source = readFile(rel);
    if (source === null) {
      errors.push(`${docFile}: không đọc được ${rel} (dấu ${name})`);
      continue;
    }
    const actual = findConstant(source, name);
    if (actual === null) {
      errors.push(`${docFile}: không tìm thấy hằng số ${name} trong ${rel}`);
    } else if (actual !== Number(expected)) {
      errors.push(`${docFile}: ${rel}#${name} là ${actual} trong code nhưng tài liệu ghi ${expected}`);
    }
  }
  return errors;
}

function checkPaths(docFile, docText, exists) {
  const errors = [];
  const seen = new Set();
  const re = /`([^`\n]+)`/g;
  let m;
  while ((m = re.exec(docText)) !== null) {
    const raw = m[1].trim();
    if (!PATH_PREFIXES.some((p) => raw.startsWith(p))) continue;
    if (/[*<>{}]/.test(raw) || /\s/.test(raw)) continue;
    const rel = raw.replace(/#.*$/, '').replace(/:\d+(?:[-:]\d+)*$/, '');
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!exists(rel)) errors.push(`${docFile}: đường dẫn không tồn tại: ${rel}`);
  }
  return errors;
}

function runChecks(root) {
  const readFile = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const errors = [];

  const pkg = readFile('package.json');
  const system = readFile('SYSTEM_DOCUMENTATION.md');
  if (pkg === null) errors.push('package.json: không đọc được');
  if (system === null) errors.push('SYSTEM_DOCUMENTATION.md: không đọc được');
  if (pkg !== null && system !== null) {
    errors.push(...checkVersion(system, JSON.parse(pkg).version));
    errors.push(...checkConstantMarkers('SYSTEM_DOCUMENTATION.md', system, readFile));
  }
  for (const doc of PATH_DOCS) {
    const text = readFile(doc);
    if (text === null) errors.push(`${doc}: không đọc được`);
    else errors.push(...checkPaths(doc, text, exists));
  }
  return errors;
}

function main() {
  const root = path.resolve(process.argv[2] || path.resolve(__dirname, '..'));
  const errors = runChecks(root);
  if (errors.length > 0) {
    for (const e of errors) console.error(`docs-check: ${e}`);
    process.exit(1);
  }
  console.log('docs-check: OK (phiên bản, hằng số, đường dẫn khớp code)');
}

module.exports = { evaluateNumber, findConstant, checkVersion, checkConstantMarkers, checkPaths, runChecks };

if (require.main === module) main();
