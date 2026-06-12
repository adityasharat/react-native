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
 * Forces a (re)compose of the zero-I layout from a cached React.xcframework
 * artifact — a thin CLI over zero-i-compose.ensureZeroILayout(force=true).
 *
 * The SPM tooling composes the layout automatically when needed
 * (generate-spm-package); this script exists for development: rebuild the
 * layout after editing source headers or headers-spec.js, then re-run the
 * gates (zero-i-verify.js, zero-i-probe.js) and `npx react-native spm sync`.
 *
 * Usage:
 *   node scripts/ios-prebuild/zero-i-repackage.js
 *     [--artifact <React.xcframework>] [--out <dir>]
 *
 * Defaults: artifact = newest ~/Library/Caches/ReactNative/spm-artifacts/
 * <version>/debug slot (deps resolved as its sibling), out =
 * <pkg>/build/zero-i.
 */

const {ensureZeroILayout} = require('./zero-i-compose');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RN_ROOT = path.join(__dirname, '..', '..');

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

function main() /*: void */ {
  const argv = process.argv.slice(2);
  const getFlag = (name /*: string */) /*: ?string */ => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };

  const artifact = getFlag('--artifact') ?? findDefaultArtifact();
  if (artifact == null || !fs.existsSync(artifact)) {
    throw new Error(
      'No React.xcframework artifact found — pass --artifact <path>',
    );
  }
  const outDir = path.resolve(
    getFlag('--out') ?? path.join(RN_ROOT, 'build', 'zero-i'),
  );

  ensureZeroILayout(path.dirname(artifact), RN_ROOT, outDir, true);
  console.log(
    '\nDone. Verify with zero-i-verify.js / zero-i-probe.js, then `npx react-native spm sync`.',
  );
}

main();
