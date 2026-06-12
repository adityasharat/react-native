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
 * Zero-I compose — the SHARED emission of the headers-spec layout
 * (Option B + Form 2; rules R1–R8 in headers-spec.js). Two consumers:
 *
 *  1. the real prebuild compose step (xcframework.js, gated by
 *     RN_ZERO_I_LAYOUT=1): emits the spec layout into the freshly composed
 *     React.xcframework's slices and builds ReactNativeHeaders.xcframework
 *     beside it — BEFORE signing (R7);
 *  2. zero-i-repackage.js: applies the same emission to an existing cached
 *     artifact (binaries are header-independent), which is how the layout is
 *     validated without a full source build.
 *
 * One projector, spec-driven, byte-identical output either way.
 */

const {computeInventory} = require('./header-inventory');
const {
  DEPS_NAMESPACES,
  planFromInventory,
  renderNamespaceModuleMap,
  renderReactModuleMap,
  renderUmbrellaHeader,
} = require('./headers-spec');
const {execSync} = require('child_process');
const fs = require('fs');
const path = require('path');

/*:: import type {HeadersSpecPlan} from './headers-spec'; */

/**
 * Computes the spec plan from the live source tree. Throws on collisions
 * (R8) — a collision means the spec and the source tree disagree and the
 * artifact must not be produced.
 */
function computeSpecPlan(rnRoot /*: string */) /*: HeadersSpecPlan */ {
  const plan = planFromInventory(computeInventory(rnRoot));
  if (plan.collisions.length > 0) {
    throw new Error(
      `headers-spec collisions (R8):\n  ${plan.collisions.join('\n  ')}`,
    );
  }
  return plan;
}

/**
 * Emits the React.framework side of the spec (R1, R4, R6) into every slice
 * of an xcframework: Headers root = React/ ∪ react/ hoisted + bare aliases,
 * generated umbrella + framework module map. Replaces each slice's Headers
 * and Modules. The xcframework's ROOT Headers/ + VFS template (the legacy
 * CocoaPods surface) are left untouched — dual-emit.
 */
function emitReactFrameworkHeaders(
  xcfwPath /*: string */,
  plan /*: HeadersSpecPlan */,
  rnRoot /*: string */,
) /*: void */ {
  const stage = fs.mkdtempSync(
    path.join(path.dirname(xcfwPath), '.react-stage-'),
  );
  for (const e of plan.react) {
    const dest = path.join(stage, e.relPath);
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.copyFileSync(path.join(rnRoot, e.source), dest);
  }
  fs.writeFileSync(
    path.join(stage, 'React-umbrella.h'),
    renderUmbrellaHeader(plan.umbrella),
  );

  const slices = fs
    .readdirSync(xcfwPath)
    .filter(d =>
      fs.existsSync(path.join(xcfwPath, d, 'React.framework', 'Headers')),
    );
  for (const slice of slices) {
    const fwk = path.join(xcfwPath, slice, 'React.framework');
    fs.rmSync(path.join(fwk, 'Headers'), {recursive: true, force: true});
    execSync(`/bin/cp -Rc "${stage}" "${path.join(fwk, 'Headers')}"`);
    fs.rmSync(path.join(fwk, 'Modules'), {recursive: true, force: true});
    fs.mkdirSync(path.join(fwk, 'Modules'), {recursive: true});
    fs.writeFileSync(
      path.join(fwk, 'Modules', 'module.modulemap'),
      renderReactModuleMap(),
    );
  }
  fs.rmSync(stage, {recursive: true, force: true});
  console.log(
    `zero-i-compose: React.framework spec layout -> ${slices.join(', ')} ` +
      `(${plan.react.length} headers, umbrella ${plan.umbrella.length})`,
  );
}

/*::
type StubSlice = {
  name: string, // human label
  sdk: string, // xcrun --sdk name
  targets: Array<string>, // clang -target triples (lipo'd when > 1)
};
*/

const DEFAULT_STUB_SLICES /*: Array<StubSlice> */ = [
  {name: 'ios', sdk: 'iphoneos', targets: ['arm64-apple-ios15.0']},
  {
    name: 'ios-simulator',
    sdk: 'iphonesimulator',
    targets: [
      'arm64-apple-ios15.0-simulator',
      'x86_64-apple-ios15.0-simulator',
    ],
  },
];

// Mac Catalyst slice — used by the real compose (the cached-artifact
// repackage path skips it to stay fast; React.xcframework carries it).
const CATALYST_STUB_SLICE /*: StubSlice */ = {
  name: 'mac-catalyst',
  sdk: 'macosx',
  targets: ['arm64-apple-ios15.0-macabi', 'x86_64-apple-ios15.0-macabi'],
};

/**
 * Builds ReactNativeHeaders.xcframework (R2, R5): a headers-only LIBRARY
 * xcframework (stub static archives — nothing embeds in apps) whose Headers
 * root carries every non-React namespace incl. the third-party deps
 * namespaces, plus module.modulemap with the plain per-namespace modules.
 * SPM serves its Headers automatically to dependents — no flags.
 */
function buildReactNativeHeadersXcframework(
  outDir /*: string */,
  plan /*: HeadersSpecPlan */,
  depsHeaders /*: string */,
  rnRoot /*: string */,
  includeCatalyst /*: boolean */ = false,
) /*: string */ {
  // ---- stage headers ----
  const stage = fs.mkdtempSync(path.join(outDir, '.rnh-stage-'));
  for (const e of plan.reactNativeHeaders) {
    const dest = path.join(stage, e.relPath);
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.copyFileSync(path.join(rnRoot, e.source), dest);
  }
  for (const ns of plan.depsNamespaces) {
    const src = path.join(depsHeaders, ns);
    if (fs.existsSync(src)) {
      execSync(`/bin/cp -Rc "${src}" "${path.join(stage, ns)}"`);
    } else {
      console.warn(`zero-i-compose: deps namespace missing: ${ns}`);
    }
  }
  fs.writeFileSync(
    path.join(stage, 'module.modulemap'),
    renderNamespaceModuleMap(plan.namespaceModules),
  );

  // ---- stub static archives per slice ----
  const work = fs.mkdtempSync(path.join(outDir, '.stub-work-'));
  fs.writeFileSync(
    path.join(work, 'stub.c'),
    '// ReactNativeHeaders is headers-only; this stub satisfies xcframework tooling.\nstatic int RNHeadersStub __attribute__((unused)) = 0;\n',
  );
  const slices = includeCatalyst
    ? [...DEFAULT_STUB_SLICES, CATALYST_STUB_SLICE]
    : DEFAULT_STUB_SLICES;
  const libs = slices.map(slice => {
    const sdkPath = execSync(`xcrun --sdk ${slice.sdk} --show-sdk-path`)
      .toString()
      .trim();
    const thins = slice.targets.map((t, i) => {
      const obj = path.join(work, `stub-${slice.name}-${i}.o`);
      execSync(
        `xcrun clang -c -target ${t} -isysroot "${sdkPath}" "${path.join(work, 'stub.c')}" -o "${obj}"`,
      );
      const lib = path.join(work, `stub-${slice.name}-${i}.a`);
      execSync(`xcrun libtool -static -o "${lib}" "${obj}" 2>/dev/null`);
      return lib;
    });
    const outLib = path.join(work, `libReactNativeHeaders-${slice.name}.a`);
    if (thins.length === 1) {
      fs.copyFileSync(thins[0], outLib);
    } else {
      execSync(
        `xcrun lipo -create ${thins.map(l => `"${l}"`).join(' ')} -output "${outLib}"`,
      );
    }
    return outLib;
  });

  // ---- compose ----
  const outXcfw = path.join(outDir, 'ReactNativeHeaders.xcframework');
  fs.rmSync(outXcfw, {recursive: true, force: true});
  execSync(
    `xcodebuild -create-xcframework ` +
      libs.map(l => `-library "${l}" -headers "${stage}"`).join(' ') +
      ` -output "${outXcfw}"`,
    {stdio: 'pipe'},
  );
  fs.rmSync(stage, {recursive: true, force: true});
  fs.rmSync(work, {recursive: true, force: true});
  console.log(
    `zero-i-compose: ReactNativeHeaders.xcframework (${slices.map(s => s.name).join(', ')}) -> ${outXcfw} ` +
      `(${plan.reactNativeHeaders.length} RN headers + deps ${plan.depsNamespaces.join(', ')}; ` +
      `${Object.keys(plan.namespaceModules).length} namespace modules)`,
  );
  return outXcfw;
}

module.exports = {
  computeSpecPlan,
  emitReactFrameworkHeaders,
  buildReactNativeHeadersXcframework,
  DEPS_NAMESPACES,
};
