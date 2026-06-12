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
 * ZERO-I SPIKE (part 1, verification) — Gate B prototype.
 *
 * For every shipped header the ecosystem actually demands (union of the
 * header-usage manifests), generate a one-line consumer TU and compile it
 * against the repackaged artifact with ZERO -I flags — only -F into the
 * xcframework slice (React.framework) and the namespace frameworks
 * (folly.framework, ...). Bucket decides the compile mode:
 *   objc-modular-candidate -> plain ObjC (.m)
 *   everything else        -> ObjC++ (.mm, c++20)
 *
 * Also probes `@import React;` against the generated module map.
 *
 * Usage:
 *   node scripts/ios-prebuild/zero-i-probe.js [--zero-i <dir>] [--all]
 *
 * Default --zero-i: <pkg>/build/zero-i (output of zero-i-repackage.js).
 * --all probes every shipped header instead of just the demanded union
 * (expect failures: full self-containment is Tier 2, not this spike's claim).
 */

const {execFile} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RN_ROOT = path.join(__dirname, '..', '..');

function readJson(p /*: string */) /*: any */ {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function includeFormFor(
  naturalPath /*: string */,
  optionB /*: boolean */,
) /*: string */ {
  if (!optionB) {
    // Option A: everything is a React.framework subpath.
    return naturalPath.startsWith('React/')
      ? naturalPath
      : `React/${naturalPath}`;
  }
  // Option B: ORIGINAL include forms — namespace frameworks + case-unified
  // React.framework serve them unchanged. Bare aliases have no framework
  // spelling; they use the (tiny, accepted) <React/X> migration form.
  return naturalPath.includes('/') ? naturalPath : `React/${naturalPath}`;
}

async function main() /*: Promise<void> */ {
  const argv = process.argv.slice(2);
  const getFlag = (name /*: string */) /*: ?string */ => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const zeroIDir = path.resolve(
    getFlag('--zero-i') ?? path.join(RN_ROOT, 'build', 'zero-i'),
  );
  const probeAll = argv.includes('--all');
  // Option B detection: the spike marker, or (production artifacts, which
  // carry no markers) the presence of ReactNativeHeaders.xcframework — the
  // Form 2 artifact only exists under the Option B layout.
  const optionB =
    fs.existsSync(path.join(zeroIDir, 'OPTION_B')) ||
    fs.existsSync(path.join(zeroIDir, 'ReactNativeHeaders.xcframework'));

  const inventory = readJson(
    path.join(RN_ROOT, 'build', 'header-inventory.json'),
  );
  const bucketOf = new Map(
    inventory.headers.map(h => [h.naturalPath, h.bucket]),
  );

  // Demanded union across all usage manifests present in build/.
  const demanded /*: Set<string> */ = new Set();
  for (const f of fs.readdirSync(path.join(RN_ROOT, 'build'))) {
    if (/^header-usage.*\.json$/.test(f)) {
      for (const d of readJson(path.join(RN_ROOT, 'build', f)).demand) {
        demanded.add(d.naturalPath);
      }
    }
  }
  const targets = probeAll
    ? inventory.headers.map(h => h.naturalPath)
    : Array.from(demanded).sort();

  // -F: the simulator slice (so React.framework is found). Under Form 2 the
  // second search root is ReactNativeHeaders' Headers dir — passed as -I here
  // ONLY to simulate what Xcode/SPM auto-add for the binaryTarget (the
  // consumer manifests carry no flag). Under Option A it is the loose
  // namespace-frameworks dir via -F.
  const sliceDir = path.join(
    zeroIDir,
    'React.xcframework',
    'ios-arm64_x86_64-simulator',
  );
  const rnhHeaders = path.join(
    zeroIDir,
    'ReactNativeHeaders.xcframework',
    'ios-arm64_x86_64-simulator',
    'Headers',
  );
  const nfwDir = path.join(zeroIDir, 'Frameworks');
  const secondRoot = fs.existsSync(rnhHeaders)
    ? ['-I', rnhHeaders]
    : ['-F', nfwDir];
  const sdkPath = require('child_process')
    .execSync('xcrun --sdk iphonesimulator --show-sdk-path')
    .toString()
    .trim();
  const baseArgs = [
    '-fsyntax-only',
    '-fobjc-arc', // consumers compile with ARC; some headers require it
    '-isysroot',
    sdkPath,
    '-target',
    'arm64-apple-ios17.0-simulator',
    '-F',
    sliceDir,
    ...secondRoot,
  ];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-i-probe-'));
  const results /*: Array<{naturalPath: string, ok: boolean, error: string}> */ =
    [];

  const probeOne = (naturalPath /*: string */) /*: Promise<void> */ =>
    new Promise(resolve => {
      const bucket = bucketOf.get(naturalPath) ?? 'cxx';
      const objc = bucket === 'objc-modular-candidate';
      const tu = path.join(
        tmpDir,
        naturalPath.replace(/[\/+]/g, '_') + (objc ? '.m' : '.mm'),
      );
      fs.writeFileSync(
        tu,
        `#${objc ? 'import' : 'include'} <${includeFormFor(naturalPath, optionB)}>\n`,
      );
      const args = [
        ...baseArgs,
        ...(objc ? [] : ['-x', 'objective-c++', '-std=c++20']),
        tu,
      ];
      execFile('xcrun', ['clang', ...args], (err, _stdout, stderr) => {
        const firstError = (
          String(stderr)
            .split('\n')
            .find(l => l.includes('error:')) ?? ''
        )
          .replace(tmpDir + '/', '')
          .slice(0, 200);
        results.push({naturalPath, ok: err == null, error: firstError});
        resolve();
      });
    });

  // Small worker pool.
  const queue = [...targets];
  const workers = Array.from({length: 8}, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next != null) {
        await probeOne(next);
      }
    }
  });
  await Promise.all(workers);

  // Module probe: @import React;
  const moduleProbe = await new Promise(resolve => {
    const tu = path.join(tmpDir, 'module-probe.m');
    fs.writeFileSync(
      tu,
      '@import React;\nvoid p(void){ (void)[RCTBridge class]; RCTLogInfo(@"zero-i"); }\n',
    );
    execFile('xcrun', ['clang', ...baseArgs, '-fmodules', tu], err =>
      resolve(err == null),
    );
  });

  fs.rmSync(tmpDir, {recursive: true, force: true});

  // ---- report ----
  const failed = results.filter(r => !r.ok);
  const byBucket /*: Map<string, {ok: number, fail: number}> */ = new Map();
  for (const r of results) {
    const b = bucketOf.get(r.naturalPath) ?? '?';
    const s = byBucket.get(b) ?? {ok: 0, fail: 0};
    r.ok ? s.ok++ : s.fail++;
    byBucket.set(b, s);
  }
  console.log(
    `\nZero-I header resolution probe (${probeAll ? 'ALL shipped' : 'demanded union'}): ` +
      `${results.length - failed.length}/${results.length} headers compile with ZERO -I`,
  );
  for (const [bucket, s] of Array.from(byBucket.entries()).sort()) {
    console.log(
      `  ${bucket.padEnd(24)} ok ${String(s.ok).padStart(4)}   fail ${String(s.fail).padStart(4)}`,
    );
  }
  console.log(
    `\n@import React; (module build): ${moduleProbe ? 'PASS' : 'FAIL'}`,
  );
  if (failed.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failed.sort((a, b) =>
      a.naturalPath.localeCompare(b.naturalPath),
    )) {
      console.log(`  ${f.naturalPath}\n    ${f.error}`);
    }
  }
  process.exitCode = failed.length > 0 || !moduleProbe ? 1 : 0;
}

main();
