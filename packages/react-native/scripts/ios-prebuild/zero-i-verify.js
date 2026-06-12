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
 * GATE A — structural contract verification of zero-I artifacts against
 * headers-spec.js. No compiler involved (Gate B / zero-i-probe.js does the
 * compile-level check); this asserts the artifacts ARE what the spec plans:
 *
 *  - every slice of React.xcframework carries exactly the planned React
 *    Headers (path set + byte-identical content vs the source tree), the
 *    generated umbrella, and the framework module map (R1, R3, R4)
 *  - ReactNativeHeaders.xcframework carries the planned namespace headers,
 *    the deps namespaces, and the namespace module map (R2, R5)
 *  - the legacy CocoaPods surface (root Headers/, VFS template, root
 *    Modules/) is still present in React.xcframework (dual-emit)
 *
 * Usage:
 *   node scripts/ios-prebuild/zero-i-verify.js [--zero-i <dir>]
 *
 * Exit code 0 = contract holds. Intended as the per-artifact CI gate.
 */

const {computeInventory} = require('./header-inventory');
const {
  planFromInventory,
  renderNamespaceModuleMap,
  renderReactModuleMap,
  renderUmbrellaHeader,
} = require('./headers-spec');
const fs = require('fs');
const path = require('path');

const RN_ROOT = path.join(__dirname, '..', '..');

let failures = 0;
function fail(msg /*: string */) {
  failures++;
  if (failures <= 25) {
    console.error(`FAIL: ${msg}`);
  }
}

function fileEquals(a /*: string */, b /*: string */) /*: boolean */ {
  try {
    const fa = fs.readFileSync(a);
    const fb = fs.readFileSync(b);
    return fa.equals(fb);
  } catch {
    return false;
  }
}

function listFiles(root /*: string */) /*: Set<string> */ {
  const out /*: Set<string> */ = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir == null) {
      break;
    }
    for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, String(ent.name));
      if (ent.isDirectory()) {
        stack.push(p);
      } else {
        out.add(path.relative(root, p));
      }
    }
  }
  return out;
}

function main() /*: void */ {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--zero-i');
  const zeroIDir = path.resolve(
    i >= 0 && argv[i + 1] != null
      ? argv[i + 1]
      : path.join(RN_ROOT, 'build', 'zero-i'),
  );

  const plan = planFromInventory(computeInventory(RN_ROOT));
  if (plan.collisions.length > 0) {
    for (const c of plan.collisions) {
      fail(`spec collision (R8): ${c}`);
    }
  }

  // ---- React.xcframework slices (R1, R3, R4 + dual-emit) ----
  const reactXcfw = path.join(zeroIDir, 'React.xcframework');
  if (!fs.existsSync(reactXcfw)) {
    fail(`missing ${reactXcfw}`);
  } else {
    for (const legacy of ['Headers', 'Modules', 'React-VFS-template.yaml']) {
      if (!fs.existsSync(path.join(reactXcfw, legacy))) {
        fail(`dual-emit: legacy CocoaPods surface missing: ${legacy}`);
      }
    }
    const slices = fs
      .readdirSync(reactXcfw)
      .filter(d =>
        fs.existsSync(path.join(reactXcfw, d, 'React.framework', 'Headers')),
      );
    if (slices.length === 0) {
      fail('no React.framework slices found');
    }
    const expectedReact = new Set(plan.react.map(e => e.relPath));
    expectedReact.add('React-umbrella.h');
    for (const slice of slices) {
      const headersDir = path.join(
        reactXcfw,
        slice,
        'React.framework',
        'Headers',
      );
      const actual = listFiles(headersDir);
      for (const rel of expectedReact) {
        if (!actual.has(rel)) {
          fail(`${slice}: missing planned header ${rel}`);
        }
      }
      for (const rel of actual) {
        if (!expectedReact.has(rel)) {
          fail(`${slice}: unplanned file in Headers: ${rel}`);
        }
      }
      // Content identity (R3): spot-verify every planned file byte-equals its
      // source (cheap: clonefile copies, ~850 small files).
      for (const e of plan.react) {
        if (
          !fileEquals(
            path.join(headersDir, e.relPath),
            path.join(RN_ROOT, e.source),
          )
        ) {
          fail(`${slice}: content drift vs source: ${e.relPath}`);
        }
      }
      const umbrella = path.join(headersDir, 'React-umbrella.h');
      if (
        fs.existsSync(umbrella) &&
        fs.readFileSync(umbrella, 'utf8') !==
          renderUmbrellaHeader(plan.umbrella)
      ) {
        fail(`${slice}: umbrella header drift`);
      }
      const moduleMap = path.join(
        reactXcfw,
        slice,
        'React.framework',
        'Modules',
        'module.modulemap',
      );
      if (
        !fs.existsSync(moduleMap) ||
        fs.readFileSync(moduleMap, 'utf8') !== renderReactModuleMap()
      ) {
        fail(`${slice}: framework module map missing or drifted`);
      }
    }
  }

  // ---- ReactNativeHeaders.xcframework (R2, R5) ----
  const rnhXcfw = path.join(zeroIDir, 'ReactNativeHeaders.xcframework');
  if (!fs.existsSync(rnhXcfw)) {
    fail(`missing ${rnhXcfw}`);
  } else {
    const rnhSlices = fs
      .readdirSync(rnhXcfw)
      .filter(d => fs.existsSync(path.join(rnhXcfw, d, 'Headers')));
    if (rnhSlices.length === 0) {
      fail('no ReactNativeHeaders slices found');
    }
    for (const slice of rnhSlices) {
      const headersDir = path.join(rnhXcfw, slice, 'Headers');
      for (const e of plan.reactNativeHeaders) {
        if (!fs.existsSync(path.join(headersDir, e.relPath))) {
          fail(`RNH ${slice}: missing planned header ${e.relPath}`);
        }
      }
      for (const ns of plan.depsNamespaces) {
        if (!fs.existsSync(path.join(headersDir, ns))) {
          fail(`RNH ${slice}: missing deps namespace ${ns}`);
        }
      }
      const moduleMap = path.join(headersDir, 'module.modulemap');
      if (
        !fs.existsSync(moduleMap) ||
        fs.readFileSync(moduleMap, 'utf8') !==
          renderNamespaceModuleMap(plan.namespaceModules)
      ) {
        fail(`RNH ${slice}: namespace module map missing or drifted`);
      }
    }
  }

  if (failures > 0) {
    console.error(
      `\nGate A: ${failures} contract violation(s)${failures > 25 ? ' (first 25 shown)' : ''}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Gate A: artifacts conform to headers-spec (${plan.react.length} React headers × slices, ` +
        `${plan.reactNativeHeaders.length} RNH headers, ${plan.depsNamespaces.length} deps namespaces, dual-emit intact)`,
    );
  }
}

main();
