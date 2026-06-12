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
 * Phase 0 of the xcframework header transition: inventory, classify and group
 * every header the React xcframework ships.
 *
 * Enumerates headers through the SAME podspec-driven discovery the prebuild
 * uses (headers.js), so the inventory cannot drift from the shipped set. For
 * each header it records:
 *
 *  - both identities: the pod-namespaced layout path (`Headers/<Pod>/<target>`,
 *    what xcframework.js emits today) and the natural/VFS path (the include
 *    path consumers write, what the merged ReactCoreHeaders tree serves)
 *  - language surface: objc | objcxx | cxx | c (with `#ifdef __cplusplus`
 *    guard awareness, so ObjC headers that only reach C++ behind guards are
 *    not misclassified)
 *  - third-party leakage: direct and transitive includes of
 *    folly/boost/fmt/glog/double-conversion/fast_float in the public surface
 *  - a modularizability bucket (can this header live in a Clang module?)
 *  - de-dupe data: natural-path collisions (two sources, one include path),
 *    multi-identity sources (one file shipped under several include paths),
 *    and basename collisions in the natural layout
 *
 * Usage:
 *   node scripts/ios-prebuild/header-inventory.js [--root <pkgRoot>] [--out <json>]
 *
 * Prints a summary to stdout and writes the full manifest as JSON (default:
 * <root>/build/header-inventory.json). Read-only: never touches the trees it
 * describes.
 */

const {getHeaderFilesFromPodspecs} = require('./headers');
const fs = require('fs');
const path = require('path');

/*::
type Identity = {
  pod: string, // pod folder name in Headers/ (specName with '-' -> '_')
  spec: string, // (sub)spec name the header came from
  namespacedPath: string, // path inside the xcframework Headers/ dir
  source: string, // repo-relative path to the physical file
  bareAlias?: boolean, // synthetic root-level alias (React_RCTAppDelegate rule)
};

type IncludeRef = {
  token: string, // text between <> or ""
  cxxGuarded: boolean, // true when only reachable under #ifdef __cplusplus
};

type HeaderEntry = {
  naturalPath: string,
  identities: Array<Identity>,
  lang: 'objc' | 'objcxx' | 'cxx' | 'c',
  hasGuardedCxx: boolean,
  bucket: 'objc-modular-candidate' | 'objc-blocked' | 'objcxx' | 'cxx',
  group: string,
  includes: {
    internal: Array<{naturalPath: string, cxxGuarded: boolean}>,
    thirdParty: Array<{lib: string, token: string, cxxGuarded: boolean}>,
    hermes: Array<string>,
    system: Array<string>,
    std: Array<{token: string, cxxGuarded: boolean}>,
    metaInternal: Array<string>,
    otherPlatform: Array<string>,
    notShipped: Array<string>,
    unresolved: Array<string>,
  },
  directThirdParty: Array<string>,
  transitiveThirdParty: Array<string>,
  objcBlockers: ?{reachesCxx: boolean, thirdParty: Array<string>},
};
*/

// Third-party C++ libraries that RN's public headers re-expose (Tier 3 of the
// modularization doc). Keyed by the first include-path segment.
const THIRD_PARTY_LIBS = new Set([
  'folly',
  'boost',
  'fmt',
  'glog',
  'double-conversion',
  'fast_float',
]);

// Apple SDK / platform include roots (first path segment). Includes resolving
// here are "system": always modular or always available, never our problem.
const SDK_PREFIXES = new Set([
  'Accelerate',
  'Accessibility',
  'AVFoundation',
  'AVKit',
  'CommonCrypto',
  'CoreFoundation',
  'CoreGraphics',
  'CoreLocation',
  'CoreMedia',
  'CoreServices',
  'CoreText',
  'CoreVideo',
  'Foundation',
  'ImageIO',
  'JavaScriptCore',
  'MachO',
  'Metal',
  'MetalKit',
  'MobileCoreServices',
  'Network',
  'PhotosUI',
  'QuartzCore',
  'SafariServices',
  'Security',
  'SwiftUI',
  'TargetConditionals.h',
  'UIKit',
  'UserNotifications',
  'WebKit',
  'XCTest',
  'arm',
  'dispatch',
  'libkern',
  'mach',
  'mach-o',
  'malloc',
  'objc',
  'os',
  'simd',
  'sys',
]);

/**
 * Scans a header's text line by line, tracking the preprocessor-conditional
 * stack just enough to know whether a line is only compiled under
 * `__cplusplus`. Returns the include list and language-marker observations.
 * Heuristic by design: nested #if logic beyond __cplusplus is treated as
 * "other" and ignored.
 */
function scanHeader(text /*: string */) /*: {
  includes: Array<IncludeRef>,
  hasObjC: boolean,
  hasUnguardedCxx: boolean,
  hasGuardedCxx: boolean,
} */ {
  const includes /*: Array<IncludeRef> */ = [];
  let hasObjC = false;
  let hasUnguardedCxx = false;
  let hasGuardedCxx = false;

  // Stack frames: 'cpp' (only under __cplusplus), 'notcpp', 'other'.
  const stack /*: Array<'cpp' | 'notcpp' | 'other'> */ = [];
  const inCxxOnly = () => stack.includes('cpp');

  const includeRe = /^\s*#\s*(?:include|import)\s+(?:<([^>]+)>|"([^"]+)")/;
  const objcRe =
    /^\s*(@(interface|protocol|implementation|class\s|end)|NS_ASSUME_NONNULL_BEGIN)/;
  const cxxRe =
    /^\s*(namespace\s+[A-Za-z_]|template\s*<|extern\s+"C\+\+"|using\s+(namespace\s|[A-Za-z_]\w*\s*=))/;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '');
    const cond = line.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/);
    if (cond) {
      const [, directive, rest] = cond;
      const mentionsCpp = /__cplusplus/.test(rest);
      if (directive === 'ifdef' || directive === 'if') {
        stack.push(
          mentionsCpp &&
            !/!\s*defined|defined\s*\(\s*__cplusplus\s*\)\s*==\s*0/.test(rest)
            ? 'cpp'
            : 'other',
        );
      } else if (directive === 'ifndef') {
        stack.push(mentionsCpp ? 'notcpp' : 'other');
      } else if (directive === 'else') {
        const top = stack.pop() ?? 'other';
        stack.push(
          top === 'cpp' ? 'notcpp' : top === 'notcpp' ? 'cpp' : 'other',
        );
      } else if (directive === 'elif') {
        const popped = stack.pop() ?? 'other';
        stack.push(mentionsCpp ? 'cpp' : popped === 'cpp' ? 'other' : 'other');
      } else if (directive === 'endif') {
        stack.pop();
      }
      continue;
    }

    const inc = line.match(includeRe);
    if (inc) {
      includes.push({
        token: inc[1] != null ? inc[1] : `"${inc[2]}"`,
        cxxGuarded: inCxxOnly(),
      });
    }
    if (objcRe.test(line)) {
      hasObjC = true;
    }
    if (cxxRe.test(line)) {
      if (inCxxOnly()) {
        hasGuardedCxx = true;
      } else {
        hasUnguardedCxx = true;
      }
    }
  }
  return {includes, hasObjC, hasUnguardedCxx, hasGuardedCxx};
}

// Meta-internal headers referenced behind RN_DISABLE_OSS_PLUGIN_HEADER (the
// FB*Plugins pattern) or fbjni/FBI18n — never resolvable in OSS, by design.
const META_INTERNAL_RE = /^(fbjni|FBI18n)\/|^React\/FB\w+Plugins\.h$/;
// Non-Apple platform headers (Android-only branches in shared headers).
const OTHER_PLATFORM_PREFIXES = new Set(['android', 'jni']);

// C++ standard library headers have no slash and no extension (<memory>);
// C standard headers have no slash and a .h (<stdio.h>).
function classifyExternal(
  token /*: string */,
  ownNamespaces /*: Set<string> */,
  rootFolder /*: string */,
) /*: string */ {
  const first = token.split('/')[0];
  if (THIRD_PARTY_LIBS.has(first)) {
    return 'thirdParty';
  }
  if (first === 'hermes') {
    return 'hermes';
  }
  if (META_INTERNAL_RE.test(token)) {
    return 'metaInternal';
  }
  if (OTHER_PLATFORM_PREFIXES.has(first)) {
    return 'otherPlatform';
  }
  if (!token.includes('/')) {
    return token.endsWith('.h') ? 'system' : 'std';
  }
  if (SDK_PREFIXES.has(first)) {
    return 'system';
  }
  // RN's own include namespace but absent from the shipped set: either a
  // genuinely unshipped header or a header_dir-flattening mismatch (headers.js
  // ships <dir>/<basename>, dropping inner subdirs like mounting/stubs/).
  if (
    ownNamespaces.has(first) ||
    fs.existsSync(path.join(rootFolder, 'ReactCommon', token))
  ) {
    return 'notShipped';
  }
  return 'unresolved';
}

// Grouping key for the summary: first natural-path segment, except `react/...`
// which is large enough to split one level deeper (react/renderer, react/bridging, ...).
function groupOf(naturalPath /*: string */) /*: string */ {
  const parts = naturalPath.split('/');
  if (parts.length === 1) {
    return '<root>';
  }
  if (parts[0] === 'react' && parts.length > 2) {
    return `react/${parts[1]}`;
  }
  return parts[0];
}

function buildInventory(rootFolder /*: string */) /*: {
  entries: Map<string, HeaderEntry>,
  sourceToNatural: Map<string, Array<string>>,
  collisions: Array<{naturalPath: string, sources: Array<string>}>,
} */ {
  const podSpecsWithHeaderFiles = getHeaderFilesFromPodspecs(rootFolder);

  // naturalPath -> entry skeleton; absolute source -> naturalPaths it serves.
  const entries /*: Map<string, HeaderEntry> */ = new Map();
  const sourceToNatural /*: Map<string, Array<string>> */ = new Map();
  const naturalToSources /*: Map<string, Set<string>> */ = new Map();

  const addIdentity = (
    naturalPath /*: string */,
    identity /*: Identity */,
    absSource /*: string */,
  ) => {
    let entry = entries.get(naturalPath);
    if (!entry) {
      entry = {
        naturalPath,
        identities: [],
        lang: 'c',
        hasGuardedCxx: false,
        bucket: 'cxx',
        group: groupOf(naturalPath),
        includes: {
          internal: [],
          thirdParty: [],
          hermes: [],
          system: [],
          std: [],
          metaInternal: [],
          otherPlatform: [],
          notShipped: [],
          unresolved: [],
        },
        directThirdParty: [],
        transitiveThirdParty: [],
        objcBlockers: null,
      };
      entries.set(naturalPath, entry);
    }
    entry.identities.push(identity);

    const naturals = sourceToNatural.get(absSource) ?? [];
    if (!naturals.includes(naturalPath)) {
      naturals.push(naturalPath);
    }
    sourceToNatural.set(absSource, naturals);

    const sources = naturalToSources.get(naturalPath) ?? new Set();
    sources.add(absSource);
    naturalToSources.set(naturalPath, sources);
  };

  for (const podspecPath of Object.keys(podSpecsWithHeaderFiles)) {
    const headerMaps = podSpecsWithHeaderFiles[podspecPath];
    // xcframework.js and vfs.js both use the ROOT spec's name (first map) as
    // the pod folder, with the same first-occurrence '-' -> '_' replacement.
    const podName = headerMaps[0].specName.replace('-', '_');

    for (const headerMap of headerMaps) {
      for (const header of headerMap.headers) {
        // Some header patterns are written as *.{m,mm,cpp,h}; only headers ship.
        if (!/\.(h|hpp)$/.test(header.source)) {
          continue;
        }
        // Natural path = the VFS key: the podspec target, with root-level
        // targets of header_dir-less pods prefixed by the pod name (vfs.js rule).
        let naturalPath = header.target;
        if (
          !naturalPath.includes('/') &&
          (!headerMap.headerDir || headerMap.headerDir === '')
        ) {
          naturalPath = `${podName}/${naturalPath}`;
        }
        const identity /*: Identity */ = {
          pod: podName,
          spec: headerMap.specName,
          namespacedPath: path.join(podName, header.target),
          source: path.relative(rootFolder, header.source),
        };
        addIdentity(naturalPath, identity, header.source);

        // The merged ReactCoreHeaders tree ALSO exposes React_RCTAppDelegate
        // headers bare at the root (hosts write #import <RCTDefaultReactNativeFactoryDelegate.h>).
        // Model that second identity explicitly.
        if (podName === 'React_RCTAppDelegate') {
          addIdentity(
            path.basename(header.target),
            {
              ...identity,
              bareAlias: true,
            },
            header.source,
          );
        }
      }
    }
  }

  const collisions = [];
  for (const [naturalPath, sources] of naturalToSources) {
    if (sources.size > 1) {
      collisions.push({
        naturalPath,
        sources: Array.from(sources)
          .map(s => path.relative(rootFolder, s))
          .sort(),
      });
    }
  }
  collisions.sort((a, b) => a.naturalPath.localeCompare(b.naturalPath));

  return {entries, sourceToNatural, collisions};
}

function classifyEntries(
  entries /*: Map<string, HeaderEntry> */,
  sourceToNatural /*: Map<string, Array<string>> */,
  rootFolder /*: string */,
) /*: void */ {
  // RN's own top-level include namespaces, derived from the shipped set, so
  // "in our namespace but not shipped" is detectable.
  const ownNamespaces = new Set(
    Array.from(entries.keys())
      .map(p => p.split('/')[0])
      .filter(p => p.includes('.') === false),
  );

  // Scan each entry's primary source once.
  for (const entry of entries.values()) {
    const absSource = path.join(rootFolder, entry.identities[0].source);
    let text;
    try {
      text = fs.readFileSync(absSource, 'utf8');
    } catch {
      entry.includes.unresolved.push('<unreadable source>');
      continue;
    }
    const scan = scanHeader(text);
    entry.hasGuardedCxx = scan.hasGuardedCxx;
    const isHpp = absSource.endsWith('.hpp');
    if (scan.hasObjC && scan.hasUnguardedCxx) {
      entry.lang = 'objcxx';
    } else if (scan.hasObjC) {
      entry.lang = 'objc';
    } else if (scan.hasUnguardedCxx || isHpp) {
      entry.lang = 'cxx';
    } else {
      entry.lang = 'c';
    }

    for (const inc of scan.includes) {
      let token = inc.token;
      // Quoted include: resolve against the source dir and map back to a
      // natural path if the resolved file is itself a shipped header.
      if (token.startsWith('"')) {
        const resolved = path.resolve(
          path.dirname(absSource),
          token.slice(1, -1),
        );
        const naturals = sourceToNatural.get(resolved);
        if (naturals && naturals.length > 0) {
          entry.includes.internal.push({
            naturalPath: naturals[0],
            cxxGuarded: inc.cxxGuarded,
          });
        }
        // Quoted includes that don't land on a shipped header are
        // pod-internal/private — not part of the public surface contract.
        continue;
      }
      if (entries.has(token)) {
        entry.includes.internal.push({
          naturalPath: token,
          cxxGuarded: inc.cxxGuarded,
        });
        continue;
      }
      const kind = classifyExternal(token, ownNamespaces, rootFolder);
      if (kind === 'thirdParty') {
        entry.includes.thirdParty.push({
          lib: token.split('/')[0],
          token,
          cxxGuarded: inc.cxxGuarded,
        });
      } else if (kind === 'hermes') {
        entry.includes.hermes.push(token);
      } else if (kind === 'system') {
        entry.includes.system.push(token);
      } else if (kind === 'std') {
        entry.includes.std.push({token, cxxGuarded: inc.cxxGuarded});
      } else if (kind === 'metaInternal') {
        entry.includes.metaInternal.push(token);
      } else if (kind === 'otherPlatform') {
        entry.includes.otherPlatform.push(token);
      } else if (kind === 'notShipped') {
        entry.includes.notShipped.push(token);
      } else {
        entry.includes.unresolved.push(token);
      }
    }
    entry.directThirdParty = Array.from(
      new Set(entry.includes.thirdParty.map(t => t.lib)),
    ).sort();
  }

  // Fixpoint propagation of third-party leakage along ALL internal edges
  // (guarded or not: for a C++ consumer everything is active). This is the
  // Tier 3 wall inventory.
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries.values()) {
      const acc = new Set(entry.transitiveThirdParty);
      const before = acc.size;
      for (const lib of entry.directThirdParty) {
        acc.add(lib);
      }
      for (const dep of entry.includes.internal) {
        const target = entries.get(dep.naturalPath);
        if (target) {
          for (const lib of target.transitiveThirdParty) {
            acc.add(lib);
          }
        }
      }
      if (acc.size !== before) {
        entry.transitiveThirdParty = Array.from(acc).sort();
        changed = true;
      }
    }
  }

  // Fixpoint over UNGUARDED edges only: what an Obj-C (non-C++) consumer of
  // this header actually pulls in. Decides modularizability of the ObjC surface.
  const reachesCxx /*: Map<string, boolean> */ = new Map();
  const reachesTp /*: Map<string, Set<string>> */ = new Map();
  for (const [naturalPath, entry] of entries) {
    reachesCxx.set(
      naturalPath,
      entry.lang === 'cxx' ||
        entry.lang === 'objcxx' ||
        entry.includes.std.some(s => !s.cxxGuarded),
    );
    reachesTp.set(
      naturalPath,
      new Set(
        entry.includes.thirdParty.filter(t => !t.cxxGuarded).map(t => t.lib),
      ),
    );
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const [naturalPath, entry] of entries) {
      let cxx = reachesCxx.get(naturalPath) ?? false;
      const tp = reachesTp.get(naturalPath) ?? new Set();
      const beforeCxx = cxx;
      const beforeTp = tp.size;
      for (const dep of entry.includes.internal) {
        if (dep.cxxGuarded) {
          continue;
        }
        cxx = cxx || (reachesCxx.get(dep.naturalPath) ?? false);
        for (const lib of reachesTp.get(dep.naturalPath) ?? []) {
          tp.add(lib);
        }
      }
      if (cxx !== beforeCxx || tp.size !== beforeTp) {
        reachesCxx.set(naturalPath, cxx);
        reachesTp.set(naturalPath, tp);
        changed = true;
      }
    }
  }

  for (const [naturalPath, entry] of entries) {
    if (entry.lang === 'cxx') {
      entry.bucket = 'cxx';
    } else if (entry.lang === 'objcxx') {
      entry.bucket = 'objcxx';
    } else {
      const cxx = reachesCxx.get(naturalPath) ?? false;
      const tp = Array.from(reachesTp.get(naturalPath) ?? []).sort();
      if (!cxx && tp.length === 0) {
        entry.bucket = 'objc-modular-candidate';
      } else {
        entry.bucket = 'objc-blocked';
        entry.objcBlockers = {reachesCxx: cxx, thirdParty: tp};
      }
    }
  }
}

function summarize(
  entries /*: Map<string, HeaderEntry> */,
  sourceToNatural /*: Map<string, Array<string>> */,
  collisions /*: Array<{naturalPath: string, sources: Array<string>}> */,
  rootFolder /*: string */,
) /*: {summaryText: string, manifest: {...}} */ {
  const sorted = Array.from(entries.values()).sort((a, b) =>
    a.naturalPath.localeCompare(b.naturalPath),
  );

  const buckets = ['objc-modular-candidate', 'objc-blocked', 'objcxx', 'cxx'];
  const bucketCounts /*: {[string]: number} */ = {};
  for (const b of buckets) {
    bucketCounts[b] = 0;
  }
  const groups /*: Map<string, {[string]: number}> */ = new Map();
  const tpDirect /*: Map<string, number> */ = new Map();
  const tpTransitive /*: Map<string, number> */ = new Map();
  const unresolvedTokens /*: Map<string, number> */ = new Map();
  const notShippedTokens /*: Map<string, Array<string>> */ = new Map();
  const basenames /*: Map<string, Array<string>> */ = new Map();

  for (const e of sorted) {
    bucketCounts[e.bucket]++;
    const g /*: {[string]: number} */ = groups.get(e.group) ?? {total: 0};
    g.total = (g.total ?? 0) + 1;
    g[e.bucket] = (g[e.bucket] ?? 0) + 1;
    groups.set(e.group, g);
    for (const lib of e.directThirdParty) {
      tpDirect.set(lib, (tpDirect.get(lib) ?? 0) + 1);
    }
    for (const lib of e.transitiveThirdParty) {
      tpTransitive.set(lib, (tpTransitive.get(lib) ?? 0) + 1);
    }
    for (const t of e.includes.unresolved) {
      unresolvedTokens.set(t, (unresolvedTokens.get(t) ?? 0) + 1);
    }
    for (const t of e.includes.notShipped) {
      const includers = notShippedTokens.get(t) ?? [];
      includers.push(e.naturalPath);
      notShippedTokens.set(t, includers);
    }
    const base = path.basename(e.naturalPath);
    const list = basenames.get(base) ?? [];
    list.push(e.naturalPath);
    basenames.set(base, list);
  }

  const multiIdentitySources = Array.from(sourceToNatural.entries())
    .filter(([, naturals]) => naturals.length > 1)
    .map(([src, naturals]) => ({
      source: path.relative(rootFolder, src),
      naturalPaths: [...naturals].sort(),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));

  const basenameCollisions = Array.from(basenames.entries())
    .filter(([, list]) => list.length > 1)
    .map(([basename, list]) => ({basename, naturalPaths: list.sort()}))
    .sort((a, b) => a.basename.localeCompare(b.basename));

  const lines = [];
  lines.push(`Shipped headers (unique natural paths): ${sorted.length}`);
  lines.push('');
  lines.push('Buckets:');
  for (const b of buckets) {
    lines.push(`  ${b.padEnd(24)} ${String(bucketCounts[b]).padStart(5)}`);
  }
  lines.push('');
  lines.push(
    'By group (group / total / modular-candidate / objc-blocked / objcxx / cxx):',
  );
  for (const [group, g] of Array.from(groups.entries()).sort()) {
    lines.push(
      `  ${group.padEnd(36)} ${String(g.total).padStart(5)}` +
        ` ${String(g['objc-modular-candidate'] ?? 0).padStart(5)}` +
        ` ${String(g['objc-blocked'] ?? 0).padStart(5)}` +
        ` ${String(g.objcxx ?? 0).padStart(5)}` +
        ` ${String(g.cxx ?? 0).padStart(5)}`,
    );
  }
  lines.push('');
  lines.push('Third-party leakage (headers including each lib):');
  for (const lib of Array.from(THIRD_PARTY_LIBS).sort()) {
    lines.push(
      `  ${lib.padEnd(20)} direct ${String(tpDirect.get(lib) ?? 0).padStart(5)}` +
        `   transitive ${String(tpTransitive.get(lib) ?? 0).padStart(5)}`,
    );
  }
  lines.push('');
  lines.push(
    `Natural-path collisions (one include path, multiple sources): ${collisions.length}`,
  );
  for (const c of collisions.slice(0, 10)) {
    lines.push(`  ${c.naturalPath}`);
    for (const s of c.sources) {
      lines.push(`    <- ${s}`);
    }
  }
  lines.push(
    `Multi-identity sources (one file, several include paths): ${multiIdentitySources.length}`,
  );
  lines.push(
    `Basename collisions in natural layout: ${basenameCollisions.length}`,
  );
  lines.push('');
  const notShippedSorted = Array.from(notShippedTokens.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  lines.push(
    `Includes in RN's namespace that are NOT in the shipped set: ${notShippedSorted.length}`,
  );
  lines.push(
    '(unshipped headers or header_dir flattening mismatches — each include below cannot resolve against the shipped layout)',
  );
  for (const [token, includers] of notShippedSorted) {
    lines.push(`  <${token}>  included by ${includers.join(', ')}`);
  }
  lines.push('');
  const unresolvedSorted = Array.from(unresolvedTokens.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  lines.push(
    `Unresolved angle-includes (distinct tokens): ${unresolvedSorted.length}`,
  );
  for (const [token, count] of unresolvedSorted.slice(0, 20)) {
    lines.push(`  ${String(count).padStart(4)}x  <${token}>`);
  }
  lines.push('');
  lines.push(
    unresolvedSorted.length === 0
      ? 'Exit criterion met: zero unclassified includes.'
      : 'Exit criterion NOT met: unresolved includes above need a classification rule.',
  );

  const manifest = {
    formatVersion: 1,
    generatedBy: 'scripts/ios-prebuild/header-inventory.js',
    root: rootFolder,
    totals: {headers: sorted.length, buckets: bucketCounts},
    groups: Object.fromEntries(Array.from(groups.entries()).sort()),
    thirdParty: {
      direct: Object.fromEntries(Array.from(tpDirect.entries()).sort()),
      transitive: Object.fromEntries(Array.from(tpTransitive.entries()).sort()),
    },
    collisions,
    multiIdentitySources,
    basenameCollisions,
    notShippedIncludes: Object.fromEntries(notShippedSorted),
    unresolvedIncludes: Object.fromEntries(unresolvedSorted),
    headers: sorted,
  };

  return {summaryText: lines.join('\n'), manifest};
}

function main() /*: void */ {
  const argv = process.argv.slice(2);
  const getFlag = (name /*: string */) /*: ?string */ => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const rootFolder = path.resolve(
    getFlag('--root') ?? path.join(__dirname, '..', '..'),
  );
  const outPath = path.resolve(
    getFlag('--out') ?? path.join(rootFolder, 'build', 'header-inventory.json'),
  );

  const {entries, sourceToNatural, collisions} = buildInventory(rootFolder);
  classifyEntries(entries, sourceToNatural, rootFolder);
  const {summaryText, manifest} = summarize(
    entries,
    sourceToNatural,
    collisions,
    rootFolder,
  );

  fs.mkdirSync(path.dirname(outPath), {recursive: true});
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(summaryText);
  console.log(`\nFull manifest: ${outPath}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildInventory,
  classifyEntries,
  scanHeader,
  THIRD_PARTY_LIBS,
  META_INTERNAL_RE,
};
