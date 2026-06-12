/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

/**
 * ZERO-I SPIKE — repackage an existing React.xcframework artifact so
 * consumers resolve every header with ZERO -I flags.
 *
 * Binaries are untouched — header layout is packaging, and compiled code does
 * not depend on headers after compilation — so "rebuilding" the xcframework
 * for header purposes = clone artifact (APFS clonefile, instant) + replace
 * Headers + regenerate Modules. This is the working prototype of the Phase 1
 * compose step.
 *
 * Two layouts:
 *
 * DEFAULT (--option-b): the DECIDED target (Option B + Form 2, see
 * headers-spec.js for the rules R1–R8 and rn-header-transition-overview.md
 * for the decision). Spec-driven:
 *   - React.framework/Headers root = React/ ∪ react/ hoisted + bare aliases,
 *     framework module map + umbrella (R1, R4, R6)
 *   - ReactNativeHeaders.xcframework: NEW headers-only LIBRARY xcframework
 *     (stub static archives per slice) carrying every other namespace incl.
 *     the third-party deps namespaces, with plain per-namespace modules in
 *     module.modulemap at its Headers root (R2, R5) — Form 2: SPM serves its
 *     Headers automatically to dependents, no -F/-I flags anywhere.
 *   - NO include rewriting anywhere (R3).
 *
 * LEGACY OPTION A (--option-a): one React.framework with everything inside,
 * internal includes rewritten to framework form, loose namespace-framework
 * shells in build/zero-i/Frameworks. Kept as the verified fallback.
 *
 * Usage:
 *   node scripts/ios-prebuild/zero-i-repackage.js [--option-a]
 *     [--artifact <React.xcframework>] [--out <dir>]
 *
 * Defaults: artifact = newest ~/Library/Caches/ReactNative/spm-artifacts/<v>/debug
 * (deps xcframework resolved as its sibling), out = <pkg>/build/zero-i.
 * Requires build/header-inventory.json (run header-inventory.js first).
 */

const {
  DEPS_NAMESPACES,
  planFromInventory,
  renderReactModuleMap,
  renderUmbrellaHeader,
} = require('./headers-spec');
const {
  buildReactNativeHeadersXcframework,
  computeSpecPlan,
  emitReactFrameworkHeaders,
} = require('./zero-i-compose');
const {execSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RN_ROOT = path.join(__dirname, '..', '..');
const MANIFEST = path.join(RN_ROOT, 'build', 'header-inventory.json');

// Any preprocessor line that mentions a header token: #include/#import lines
// AND #if/#elif __has_include(<...>) conditions — both must be rewritten
// together or a __has_include chain falls through to a stale branch.
// (Option A only — Option B never rewrites.)
const PP_LINE_RE = /^\s*#\s*(include|import|if|elif)\b/;
const TOKEN_RE = /<([^<>"]+)>/g;

function findDefaultArtifact() /*: ?string */ {
  const cacheRoot = path.join(
    os.homedir(),
    'Library',
    'Caches',
    'ReactNative',
    'spm-artifacts',
  );
  if (!fs.existsSync(cacheRoot)) {
    return null;
  }
  const candidates = [];
  for (const version of fs.readdirSync(cacheRoot)) {
    const xcfw = path.join(cacheRoot, version, 'debug', 'React.xcframework');
    if (fs.existsSync(xcfw)) {
      candidates.push({xcfw, mtime: fs.statSync(xcfw).mtimeMs});
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.length > 0 ? candidates[0].xcfw : null;
}

function rewriteLine(
  line /*: string */,
  naturalPaths /*: Set<string> */,
) /*: {line: string, rewritten: boolean} */ {
  if (!PP_LINE_RE.test(line)) {
    return {line, rewritten: false};
  }
  let rewritten = false;
  const next = line.replace(TOKEN_RE, (full, token) => {
    if (naturalPaths.has(token) && !token.startsWith('React/')) {
      rewritten = true;
      return `<React/${token}>`;
    }
    return full;
  });
  return {line: next, rewritten};
}

/** Installs a staged Headers dir + module map into every framework slice. */
function installIntoSlices(
  outXcfw /*: string */,
  stage /*: string */,
  moduleMap /*: string */,
) /*: void */ {
  const slices = fs
    .readdirSync(outXcfw)
    .filter(d =>
      fs.existsSync(path.join(outXcfw, d, 'React.framework', 'Headers')),
    );
  for (const slice of slices) {
    const fwk = path.join(outXcfw, slice, 'React.framework');
    fs.rmSync(path.join(fwk, 'Headers'), {recursive: true, force: true});
    execSync(`/bin/cp -Rc "${stage}" "${path.join(fwk, 'Headers')}"`);
    fs.rmSync(path.join(fwk, 'Modules'), {recursive: true, force: true});
    fs.mkdirSync(path.join(fwk, 'Modules'), {recursive: true});
    fs.writeFileSync(path.join(fwk, 'Modules', 'module.modulemap'), moduleMap);
  }
  console.log(`Installed Headers + module map -> ${slices.join(', ')}`);
}

function main() /*: void */ {
  const argv = process.argv.slice(2);
  const getFlag = (name /*: string */) /*: ?string */ => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  // Option B + Form 2 is the DECIDED default; --option-a is the fallback.
  const optionA = argv.includes('--option-a');

  const artifact = getFlag('--artifact') ?? findDefaultArtifact();
  if (artifact == null || !fs.existsSync(artifact)) {
    throw new Error(
      'No React.xcframework artifact found — pass --artifact <path>',
    );
  }
  const depsHeaders = path.join(
    path.dirname(artifact),
    'ReactNativeDependencies.xcframework',
    'Headers',
  );
  if (!fs.existsSync(depsHeaders)) {
    throw new Error(`Deps headers not found at ${depsHeaders}`);
  }
  const outDir = path.resolve(
    getFlag('--out') ?? path.join(RN_ROOT, 'build', 'zero-i'),
  );

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  // ---- clone the artifact (APFS clonefile: instant, no duplicate disk) ----
  const outXcfw = path.join(outDir, 'React.xcframework');
  fs.rmSync(outDir, {recursive: true, force: true});
  fs.mkdirSync(outDir, {recursive: true});
  execSync(`/bin/cp -Rc "${fs.realpathSync(artifact)}" "${outXcfw}"`);
  // R7: the cached artifact is code-signed and the signature manifest pins
  // the OLD header set — strip it; production signs AFTER composing.
  fs.rmSync(path.join(outXcfw, '_CodeSignature'), {
    recursive: true,
    force: true,
  });
  console.log(`Cloned artifact (signature stripped) -> ${outXcfw}`);

  if (!optionA) {
    // ============ OPTION B + FORM 2 (shared spec-driven emission) ============
    // Same code path the real prebuild compose uses (zero-i-compose.js) —
    // this script just applies it to a cached artifact instead of a fresh one.
    const plan = computeSpecPlan(RN_ROOT);
    emitReactFrameworkHeaders(outXcfw, plan, RN_ROOT);
    buildReactNativeHeadersXcframework(outDir, plan, depsHeaders, RN_ROOT);

    // Marker: layout-aware tooling (sync codemod hook, probe) keys off this.
    fs.writeFileSync(
      path.join(outDir, 'OPTION_B'),
      'zero-i layout: option B + Form 2 (compat-serving, spec-driven)\n',
    );
    console.log('\nDone (Option B + Form 2). Re-run spm sync, then build.');
    return;
  }

  // ================= LEGACY OPTION A (fallback) =================
  const naturalPaths /*: Set<string> */ = new Set(
    manifest.headers.map(h => h.naturalPath),
  );
  const stage = path.join(outDir, '.headers-stage');
  fs.mkdirSync(stage, {recursive: true});
  let rewritten = 0;
  for (const h of manifest.headers) {
    let content;
    try {
      content = fs.readFileSync(
        path.join(RN_ROOT, h.identities[0].source),
        'utf8',
      );
    } catch {
      continue;
    }
    content = content
      .split('\n')
      .map(line => {
        const r = rewriteLine(line, naturalPaths);
        if (r.rewritten) {
          rewritten++;
        }
        return r.line;
      })
      .join('\n');
    const np = h.naturalPath;
    const dest = path.join(
      stage,
      np.startsWith('React/') ? np.slice('React/'.length) : np,
    );
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.writeFileSync(dest, content);
  }
  const planA = planFromInventory(manifest);
  fs.writeFileSync(
    path.join(stage, 'React-umbrella.h'),
    renderUmbrellaHeader(planA.umbrella),
  );
  installIntoSlices(outXcfw, stage, renderReactModuleMap());
  fs.rmSync(stage, {recursive: true, force: true});
  console.log(`OPTION A: projected with ${rewritten} include lines rewritten`);

  const nfwDir = path.join(outDir, 'Frameworks');
  fs.mkdirSync(nfwDir, {recursive: true});
  for (const lib of DEPS_NAMESPACES) {
    const libHeaders = path.join(depsHeaders, lib);
    if (fs.existsSync(libHeaders)) {
      const fwk = path.join(nfwDir, `${lib}.framework`);
      fs.mkdirSync(fwk, {recursive: true});
      fs.symlinkSync(libHeaders, path.join(fwk, 'Headers'));
    }
  }
  console.log(`OPTION A: deps namespace-framework shells -> ${nfwDir}`);
}

main();
