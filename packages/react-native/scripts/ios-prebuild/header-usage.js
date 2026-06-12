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
 * Phase 0 (part 2) of the xcframework header transition: measure CONSUMER-side
 * demand on the shipped header surface.
 *
 * header-inventory.js describes what we ship; this script scans the code that
 * compiles AGAINST the xcframework — the app's native sources, its codegen
 * output, and community libraries (node_modules packages with a podspec) — and
 * resolves every #include/#import against the shipped natural layout. Per
 * shipped header it records real demand: how often it is imported, in which
 * form (namespaced angle include, bare angle include, quoted), and from which
 * language context (.m vs .mm vs .cpp). This answers, with data instead of
 * guesses:
 *
 *  - which of the multi-identity paths are load-bearing (can aliases collapse
 *    in Phase 1?)
 *  - whether any header classified objc-blocked is imported from plain .m
 *    files (classification cross-check for the Phase 2 module map)
 *  - which part of the surface consumers never touch (deprioritize, don't
 *    modularize)
 *  - which demanded includes CANNOT resolve against the shipped layout (the
 *    consumer-side mirror of the inventory's notShipped finding)
 *
 * Usage:
 *   node scripts/ios-prebuild/header-usage.js [--root <rnPkgRoot>] [--app <appRoot>]
 *     [--libs <packagesDir>]... [--out <json>]
 *
 * Defaults: --app <root>/../rn-tester (this monorepo's consumer), output at
 * <root>/build/header-usage.json. --libs adds a directory of packages to scan
 * (e.g. an extracted set of community libraries, or a monorepo packages/ dir
 * like Expo's); it may be repeated. Read-only. Swift files are not scanned —
 * Swift imports modules, not headers, so it exerts no demand on the `-I` tree.
 */

const {
  META_INTERNAL_RE,
  THIRD_PARTY_LIBS,
  buildInventory,
  classifyEntries,
  scanHeader,
} = require('./header-inventory');
const fs = require('fs');
const path = require('path');
const {globSync} = require('tinyglobby');

/*::
type ScanRoot = {
  name: string, // 'app' | 'codegen' | package name
  dir: string,
};

type Demand = {
  naturalPath: string,
  bucket: string,
  total: number,
  forms: {[string]: number}, // angle-namespaced | angle-bare | quoted
  contexts: {[string]: number}, // m | mm | cpp | h | ...
  roots: {[string]: number},
};
*/

const SOURCE_GLOB = '**/*.{h,hpp,m,mm,c,cc,cpp,cxx}';
const SOURCE_IGNORE = [
  '**/node_modules/**',
  '**/Pods/**',
  '**/build/**',
  '**/android/**',
  '**/windows/**',
  '**/__tests__/**',
];

// File extension -> compilation context the import happens in.
function contextOf(file /*: string */) /*: string */ {
  const ext = path.extname(file).slice(1);
  return ext === 'cc' || ext === 'cxx' ? 'cpp' : ext === 'hpp' ? 'h' : ext;
}

// Podspec locations relative to a packages dir: at the package root or under
// ios/ (the Expo modules convention), for plain and scoped packages alike.
const PODSPEC_PATTERNS = [
  '*/*.podspec',
  '*/ios/*.podspec',
  '@*/*/*.podspec',
  '@*/*/ios/*.podspec',
];

/**
 * Finds consumer packages (dirs that ship a podspec — the autolinking signal
 * for "has native code that compiles against RN") under `searchDir`. A podspec
 * in <pkg>/ios/ identifies <pkg>. Packages named react-native (any copy of the
 * producer) and already-seen realpaths are skipped.
 */
function findPodspecPackages(
  searchDir /*: string */,
  realRnRoot /*: string */,
  seen /*: Set<string> */,
) /*: Array<ScanRoot> */ {
  const roots /*: Array<ScanRoot> */ = [];
  const podspecs = globSync(PODSPEC_PATTERNS, {
    cwd: searchDir,
    absolute: true,
    ignore: ['**/node_modules/**'],
  });
  for (const podspec of podspecs) {
    let pkgDir = path.dirname(podspec);
    if (path.basename(pkgDir) === 'ios') {
      pkgDir = path.dirname(pkgDir);
    }
    let realPkgDir;
    try {
      realPkgDir = fs.realpathSync(pkgDir);
    } catch {
      continue;
    }
    if (realPkgDir === realRnRoot || seen.has(realPkgDir)) {
      continue;
    }
    let pkgName = path.relative(searchDir, pkgDir);
    try {
      const pkgJson = JSON.parse(
        fs.readFileSync(path.join(realPkgDir, 'package.json'), 'utf8'),
      );
      if (typeof pkgJson.name === 'string') {
        pkgName = pkgJson.name;
      }
    } catch {}
    if (pkgName === 'react-native') {
      continue;
    }
    seen.add(realPkgDir);
    roots.push({name: pkgName, dir: realPkgDir});
  }
  return roots;
}

/**
 * Discovers the roots to scan: the app's own native code, its codegen output,
 * every node_modules podspec package (node_modules dirs are collected from the
 * app root upward, so monorepo hoisting is covered), and any extra --libs
 * directories of packages. react-native itself is excluded — it is the
 * producer, not a consumer.
 */
function discoverScanRoots(
  appRoot /*: string */,
  rnRoot /*: string */,
  libsDirs /*: Array<string> */,
) /*: Array<ScanRoot> */ {
  const roots /*: Array<ScanRoot> */ = [{name: 'app', dir: appRoot}];

  const codegenDir = path.join(appRoot, 'build', 'generated', 'ios');
  if (fs.existsSync(codegenDir)) {
    roots.push({name: 'codegen', dir: codegenDir});
  }

  const realRnRoot = fs.realpathSync(rnRoot);
  const seen /*: Set<string> */ = new Set();
  let dir = path.resolve(appRoot);
  while (true) {
    const nm = path.join(dir, 'node_modules');
    if (fs.existsSync(nm)) {
      roots.push(...findPodspecPackages(nm, realRnRoot, seen));
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  for (const libsDir of libsDirs) {
    roots.push(...findPodspecPackages(path.resolve(libsDir), realRnRoot, seen));
  }
  return roots;
}

function main() /*: void */ {
  const argv = process.argv.slice(2);
  const getFlag = (name /*: string */) /*: ?string */ => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const getFlagAll = (name /*: string */) /*: Array<string> */ => {
    const values = [];
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === name) {
        values.push(argv[i + 1]);
      }
    }
    return values;
  };
  const rnRoot = path.resolve(
    getFlag('--root') ?? path.join(__dirname, '..', '..'),
  );
  const appRoot = path.resolve(
    getFlag('--app') ?? path.join(rnRoot, '..', 'rn-tester'),
  );
  const outPath = path.resolve(
    getFlag('--out') ?? path.join(rnRoot, 'build', 'header-usage.json'),
  );

  // Rebuild the shipped-surface inventory in-memory so usage and inventory can
  // never disagree about what is shipped.
  const {entries, sourceToNatural} = buildInventory(rnRoot);
  classifyEntries(entries, sourceToNatural, rnRoot);
  const ownNamespaces = new Set(
    Array.from(entries.keys())
      .map(p => p.split('/')[0])
      .filter(p => !p.includes('.')),
  );
  // Quoted-include resolution needs realpath keys (node_modules symlinks).
  const realSourceToNatural /*: Map<string, Array<string>> */ = new Map();
  for (const [src, naturals] of sourceToNatural) {
    try {
      realSourceToNatural.set(fs.realpathSync(src), naturals);
    } catch {}
  }

  const scanRoots = discoverScanRoots(appRoot, rnRoot, getFlagAll('--libs'));

  const demand /*: Map<string, Demand> */ = new Map();
  const unresolvable /*: Map<string, Array<string>> */ = new Map();
  const depsDemand /*: Map<string, number> */ = new Map(); // folly/glog/... in consumer code
  const perAppDemand /*: Map<string, number> */ = new Map(); // codegen/ReactAppHeaders tokens
  const libraryCodegen /*: Map<string, number> */ = new Map(); // libs' own codegen components
  const filesScanned /*: Map<string, number> */ = new Map();

  // Conventional header-search roots libraries add for their own pods; a token
  // resolving here is the library including ITSELF via an RN-style namespace
  // (e.g. screens' common/cpp/react/renderer/components/rnscreens/...).
  const LIB_SOURCE_ROOTS = [
    '',
    'common/cpp',
    'Common/cpp',
    'cpp',
    'ios',
    'apple',
    'src',
  ];
  const resolvesInsideLibrary = (
    pkgDir /*: string */,
    token /*: string */,
  ) /*: boolean */ =>
    LIB_SOURCE_ROOTS.some(prefix =>
      fs.existsSync(path.join(pkgDir, prefix, token)),
    );

  const bump = (
    naturalPath /*: string */,
    form /*: string */,
    context /*: string */,
    rootName /*: string */,
  ) => {
    let d = demand.get(naturalPath);
    if (!d) {
      const entry = entries.get(naturalPath);
      const fresh /*: Demand */ = {
        naturalPath,
        bucket: entry ? entry.bucket : 'unknown',
        total: 0,
        forms: {},
        contexts: {},
        roots: {},
      };
      demand.set(naturalPath, fresh);
      d = fresh;
    }
    d.total++;
    d.forms[form] = (d.forms[form] ?? 0) + 1;
    d.contexts[context] = (d.contexts[context] ?? 0) + 1;
    d.roots[rootName] = (d.roots[rootName] ?? 0) + 1;
  };

  for (const root of scanRoots) {
    const files = globSync(SOURCE_GLOB, {
      cwd: root.dir,
      absolute: true,
      ignore: SOURCE_IGNORE,
    });
    filesScanned.set(root.name, files.length);

    for (const file of files) {
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const context = contextOf(file);
      for (const inc of scanHeader(text).includes) {
        const token = inc.token;
        if (token.startsWith('"')) {
          // Quoted include: only interesting if it physically lands on a
          // shipped RN header (rare from consumers, but it is demand).
          const resolved = path.resolve(path.dirname(file), token.slice(1, -1));
          let real;
          try {
            real = fs.realpathSync(resolved);
          } catch {
            continue; // consumer-internal or nonexistent — not our surface
          }
          const naturals = realSourceToNatural.get(real);
          if (naturals && naturals.length > 0) {
            bump(naturals[0], 'quoted', context, root.name);
          }
          continue;
        }
        if (entries.has(token)) {
          bump(
            token,
            token.includes('/') ? 'angle-namespaced' : 'angle-bare',
            context,
            root.name,
          );
          continue;
        }
        const first = token.split('/')[0];
        if (THIRD_PARTY_LIBS.has(first)) {
          // Consumer importing folly/glog/... directly: served by the
          // ReactNativeDependencies headers in the shared tree, but it is
          // exactly the Tier 3 coupling — count it.
          depsDemand.set(first, (depsDemand.get(first) ?? 0) + 1);
          continue;
        }
        if (META_INTERNAL_RE.test(token)) {
          continue; // Meta-internal plugins pattern — not OSS surface
        }
        if (token.startsWith('react/fabric/')) {
          continue; // Android JNI bindings namespace — not the iOS surface
        }
        if (resolvesInsideLibrary(root.dir, token)) {
          continue; // library-internal header exposed via an RN-style path
        }
        // Per-app tree (ReactAppHeaders): <ReactCodegen/...> plus the app's
        // own codegen components, which reuse RN's react/renderer namespace.
        if (
          first === 'ReactCodegen' ||
          fs.existsSync(
            path.join(appRoot, 'build', 'generated', 'ios', token),
          ) ||
          fs.existsSync(
            path.join(
              appRoot,
              'build',
              'generated',
              'ios',
              'ReactCodegen',
              token,
            ),
          )
        ) {
          perAppDemand.set(token, (perAppDemand.get(token) ?? 0) + 1);
          continue;
        }
        // A library importing react/renderer/components/<its own codegen
        // namespace>/...: generated into the per-app tree at app build time.
        if (/^react\/renderer\/components\//.test(token)) {
          libraryCodegen.set(token, (libraryCodegen.get(token) ?? 0) + 1);
          continue;
        }
        if (ownNamespaces.has(first)) {
          const sites = unresolvable.get(token) ?? [];
          sites.push(`${root.name}:${path.relative(root.dir, file)}`);
          unresolvable.set(token, sites);
        }
      }
    }
  }

  // ---- aggregate ----
  const demanded = Array.from(demand.values()).sort(
    (a, b) => b.total - a.total || a.naturalPath.localeCompare(b.naturalPath),
  );

  const buckets = ['objc-modular-candidate', 'objc-blocked', 'objcxx', 'cxx'];
  const shippedPerBucket /*: {[string]: number} */ = {};
  const demandedPerBucket /*: {[string]: number} */ = {};
  for (const b of buckets) {
    shippedPerBucket[b] = 0;
    demandedPerBucket[b] = 0;
  }
  for (const e of entries.values()) {
    shippedPerBucket[e.bucket]++;
  }
  for (const d of demanded) {
    if (demandedPerBucket[d.bucket] != null) {
      demandedPerBucket[d.bucket]++;
    }
  }

  // objc-blocked headers imported from plain ObjC (.m) — classification vs
  // practice mismatches that Phase 2 must resolve one way or the other.
  const blockedFromObjC = demanded.filter(
    d => d.bucket === 'objc-blocked' && (d.contexts.m ?? 0) > 0,
  );

  // Which identities of multi-identity sources are actually used.
  const identityUsage = [];
  for (const [src, naturals] of sourceToNatural) {
    if (naturals.length < 2) {
      continue;
    }
    const used = naturals
      .map(n => ({naturalPath: n, total: demand.get(n)?.total ?? 0}))
      .filter(u => u.total > 0);
    if (used.length > 0) {
      identityUsage.push({
        source: path.relative(rnRoot, src),
        identities: naturals.map(n => ({
          naturalPath: n,
          imports: demand.get(n)?.total ?? 0,
        })),
      });
    }
  }
  identityUsage.sort((a, b) => a.source.localeCompare(b.source));

  const unresolvableSorted = Array.from(unresolvable.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  // ---- report ----
  const lines = [];
  lines.push('Scan roots:');
  for (const root of scanRoots) {
    lines.push(
      `  ${root.name.padEnd(24)} ${String(filesScanned.get(root.name) ?? 0).padStart(5)} files  (${root.dir})`,
    );
  }
  lines.push('');
  lines.push(`Demanded shipped headers: ${demanded.length} of ${entries.size}`);
  lines.push('  bucket                    shipped  demanded');
  for (const b of buckets) {
    lines.push(
      `  ${b.padEnd(24)} ${String(shippedPerBucket[b]).padStart(8)} ${String(demandedPerBucket[b]).padStart(9)}`,
    );
  }
  lines.push('');
  lines.push('Top imported headers:');
  for (const d of demanded.slice(0, 15)) {
    lines.push(
      `  ${String(d.total).padStart(4)}x  ${d.naturalPath}  [${d.bucket}]` +
        `  forms=${JSON.stringify(d.forms)} contexts=${JSON.stringify(d.contexts)}`,
    );
  }
  lines.push('');
  lines.push(
    `objc-blocked headers imported from plain .m files: ${blockedFromObjC.length}`,
  );
  for (const d of blockedFromObjC) {
    lines.push(`  ${d.naturalPath} (${d.contexts.m ?? 0}x from .m)`);
  }
  lines.push('');
  lines.push(
    `Multi-identity sources with observed demand: ${identityUsage.length}`,
  );
  for (const u of identityUsage.slice(0, 10)) {
    lines.push(`  ${u.source}`);
    for (const id of u.identities) {
      lines.push(`    ${String(id.imports).padStart(4)}x  <${id.naturalPath}>`);
    }
  }
  lines.push('');
  lines.push('Consumer demand on third-party deps headers (Tier 3 coupling):');
  for (const [lib, count] of Array.from(depsDemand.entries()).sort()) {
    lines.push(`  ${lib.padEnd(20)} ${String(count).padStart(5)}`);
  }
  if (depsDemand.size === 0) {
    lines.push('  (none)');
  }
  lines.push('');
  lines.push(
    `Per-app tree demand (codegen/ReactAppHeaders, distinct tokens): ${perAppDemand.size}`,
  );
  lines.push(
    `Library codegen-component demand (generated per-app, distinct tokens): ${libraryCodegen.size}`,
  );
  lines.push('');
  lines.push(
    `Demanded but NOT resolvable against the shipped layout: ${unresolvableSorted.length}`,
  );
  for (const [token, sites] of unresolvableSorted) {
    lines.push(`  <${token}>`);
    for (const site of sites.slice(0, 3)) {
      lines.push(`    at ${site}`);
    }
  }

  const manifest = {
    formatVersion: 1,
    generatedBy: 'scripts/ios-prebuild/header-usage.js',
    rnRoot,
    appRoot,
    scanRoots: scanRoots.map(r => ({
      ...r,
      files: filesScanned.get(r.name) ?? 0,
    })),
    totals: {
      shipped: entries.size,
      demanded: demanded.length,
      shippedPerBucket,
      demandedPerBucket,
    },
    blockedFromObjC: blockedFromObjC.map(d => d.naturalPath),
    identityUsage,
    depsDemand: Object.fromEntries(Array.from(depsDemand.entries()).sort()),
    perAppDemand: Object.fromEntries(Array.from(perAppDemand.entries()).sort()),
    libraryCodegen: Object.fromEntries(
      Array.from(libraryCodegen.entries()).sort(),
    ),
    unresolvable: Object.fromEntries(unresolvableSorted),
    demand: demanded,
  };

  fs.mkdirSync(path.dirname(outPath), {recursive: true});
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(lines.join('\n'));
  console.log(`\nFull manifest: ${outPath}`);
}

if (require.main === module) {
  main();
}
