/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Creates a logger trio {log, warn, die} that prefixes messages with [name].
 *   log  – green prefix, writes to stdout
 *   warn – yellow prefix, writes to stderr
 *   die  – red prefix, writes to stderr, sets exitCode=1, throws
 */
function makeLogger(name /*: string */) /*: {
  log: (msg: string) => void,
  warn: (msg: string) => void,
  die: (msg: string) => empty,
} */ {
  // Prefix every newline-separated line of the message so multi-line output
  // wraps cleanly when terminal log scrapers look for the `[name]` tag.
  function format(color /*: string */, msg /*: string */) /*: string */ {
    const prefix = `\x1b[${color}m[${name}]\x1b[0m`;
    return msg
      .split('\n')
      .map(line => `${prefix} ${line}`)
      .join('\n');
  }
  return {
    log(msg /*: string */) /*: void */ {
      console.log(format('32', msg));
    },
    warn(msg /*: string */) /*: void */ {
      console.warn(format('33', msg));
    },
    die(msg /*: string */) /*: empty */ {
      console.error(format('31', msg));
      process.exitCode = 1;
      throw new Error(msg);
    },
  };
}

/**
 * Returns a short, human-readable representation of an absolute path:
 *   - Paths under $HOME are shown as ~/...
 *   - Paths under cwd are shown as relative (if ≤2 levels up)
 *   - Otherwise the absolute path is returned unchanged
 */
function displayPath(p /*: string */) /*: string */ {
  const home = os.homedir();
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) {
    return '~' + p.slice(home.length);
  }
  const rel = path.relative(process.cwd(), p);
  if (rel && !rel.startsWith('../../..')) {
    return rel;
  }
  return p;
}

/**
 * Canonical React Native binary cache root. Mirrors CocoaPods'
 * `ReactNativePodsUtils.shared_cache_dir()` (~/Library/Caches/ReactNative, added
 * in #56847) so SPM and CocoaPods share one cache root — and so SPM stops using
 * a `com.facebook.ReactNative` (bundle-id) dir that other tools may also touch.
 * Honor `RCT_SKIP_CACHES=1` (same env var as CocoaPods) to bypass the shared
 * tarball cache.
 */
function sharedCacheDir() /*: string */ {
  return path.join(os.homedir(), 'Library', 'Caches', 'ReactNative');
}

/**
 * Returns the default versioned cache directory for SPM's EXTRACTED xcframeworks,
 * nested under the canonical cache root. Downloaded tarballs themselves go in the
 * flat shared cache (sharedCacheDir()) so they are reused across SPM/CocoaPods.
 *
 * @param {string} versionKey  Version string used as directory name.
 *                             Pass the raw --version arg (e.g. 'nightly') so the
 *                             cache slot is stable regardless of the resolved hash.
 * @param {string} flavor      'debug' or 'release'
 */
function defaultCacheDir(
  versionKey /*: string */,
  flavor /*: string */,
) /*: string */ {
  return path.join(sharedCacheDir(), 'spm-artifacts', versionKey, flavor);
}

/**
 * Sanitize a package/app name to a valid Swift identifier.
 * e.g. "@react-native/tester" -> "RNTester", "my-app" -> "MyApp"
 */
function toSwiftName(name /*: string */) /*: string */ {
  const base = name.replace(/^@[^/]+\//, '');
  return base
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/**
 * Derive a default app name from the raw package name and source path.
 * Prefers the source directory name when it's meaningful (e.g. "RNTester"),
 * falls back to the package name for generic dirs like "ios" or "src".
 */
function deriveAppName(
  rawName /*: string */,
  sourcePath /*: string */,
) /*: string */ {
  const genericSourceDirs = new Set(['ios', 'app', 'sources', 'src']);
  const cleanName = rawName.replace(/^@[^/]+\//, '');
  return toSwiftName(
    sourcePath !== toSwiftName(cleanName) &&
      !genericSourceDirs.has(sourcePath.toLowerCase())
      ? sourcePath
      : cleanName,
  );
}

// $FlowFixMe[unclear-type] JSON data has dynamic shape
function readPackageJson(dir /*: string */) /*: Object | null */ {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return null;
  }
  // $FlowFixMe[incompatible-return] JSON.parse returns any
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

/**
 * Walk up from startDir until we find a directory containing package.json.
 * Returns startDir itself if it contains package.json, or startDir as fallback
 * if no package.json is found anywhere up the tree.
 */
function findProjectRoot(startDir /*: string */) /*: string */ {
  const start = path.resolve(startDir);
  let dir = start;
  // Bounded by filesystem depth — path.dirname converges to '/' or 'C:\\'.
  // The `dir = ...` updates would otherwise drop the start-fallback narrowing.
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // At filesystem root — last check before falling back.
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    return dir;
  }
  return start;
}

/**
 * Resolve the react-native package root from an app directory.
 * Checks appRoot/projectRoot and their ancestors for node_modules/react-native,
 * then falls back to __dirname-relative resolution (monorepo layout).
 *
 * Returns null if react-native cannot be found.
 */
function resolveReactNativeRoot(
  appRoot /*: string */,
  projectRoot /*: string */,
) /*: string | null */ {
  const candidates /*: Array<string> */ = [];
  const seen /*: Set<string> */ = new Set();

  function addAncestorCandidates(startDir /*: string */) /*: void */ {
    let dir = path.resolve(startDir);
    while (true) {
      const candidate = path.join(dir, 'node_modules', 'react-native');
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  addAncestorCandidates(appRoot);
  addAncestorCandidates(projectRoot);
  candidates.push(path.resolve(__dirname, '../..'));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

// The per-app farm lives INSIDE the codegen package (build/generated/ios) so
// it can be vended as a normal SPM headers target ("ReactAppHeaders") — under
// zero-I the farm reaches consumers via SPM product dependencies, not -I.
const PER_APP_HEADERS_REL = 'build/generated/ios/ReactAppHeaders';

// Marker at the top of a scaffolder-generated Package.swift. Lives here (not in
// scaffold-package-swift.js) so the autolinker can recognize scaffolded files
// without a circular import (scaffold-package-swift requires the autolinker).
const SCAFFOLDER_MARKER =
  '// AUTO-SCAFFOLDED by react-native spm scaffold — safe to edit & commit via patch-package.';

// The locally composed zero-I layout (see zero-i-compose.ensureZeroILayout):
// generate-spm-package keeps it fresh from the cache slot whenever the slot's
// artifacts don't already ship the spec layout. These helpers expose the
// composed header roots for the community-manifest paths.json (grandfathered
// `-I` contract — see writeSharedPathsJson).
const ZERO_I_DIR = path.resolve(__dirname, '..', '..', 'build', 'zero-i');
function composedHeaderRoots() /*: {react: ?string, rnh: ?string} */ {
  const reactXcfw = path.join(ZERO_I_DIR, 'React.xcframework');
  const rnhXcfw = path.join(ZERO_I_DIR, 'ReactNativeHeaders.xcframework');
  let react = null;
  let rnh = null;
  try {
    const slice = fs
      .readdirSync(reactXcfw)
      .find(d =>
        fs.existsSync(path.join(reactXcfw, d, 'React.framework', 'Headers')),
      );
    if (slice != null) {
      react = path.join(reactXcfw, slice, 'React.framework', 'Headers');
    }
  } catch {}
  try {
    const slice = fs
      .readdirSync(rnhXcfw)
      .find(d => fs.existsSync(path.join(rnhXcfw, d, 'Headers')));
    if (slice != null) {
      rnh = path.join(rnhXcfw, slice, 'Headers');
    }
  } catch {}
  return {react, rnh};
}

function perAppHeadersDir(appRoot /*: string */) /*: string */ {
  return path.join(appRoot, PER_APP_HEADERS_REL);
}

/**
 * Renders the inlined Swift loader that every generated build-dir manifest
 * (aggregator, synth wrapper, codegen template) emits to read the per-app
 * spm-paths.json. `relPath` is the manifest's directory-relative path to the
 * `build/generated/autolinking/` dir that holds spm-paths.json ("" for the
 * aggregator, "../.." for a synth wrapper, "../autolinking" for codegen).
 *
 * Because the absolute paths live in the JSON and not in the manifest text, the
 * manifest is machine-independent and its SPM manifest hash stays stable across
 * machines and cache slots. File reads during manifest evaluation are supported
 * by SPM (the scaffolder already walks the filesystem at eval time).
 */
function renderRNPathsLoader(relPath /*: string */) /*: string */ {
  const rel = relPath === '' ? '' : `${relPath}/`;
  return `let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

// Single source of truth for React Native paths (spm-paths.json, written by
// \`npx react-native spm\`). Read here so this manifest's text holds no
// absolute paths. Headers need no paths at all — they are served by the
// React/ReactNativeHeaders binaryTargets and the ReactAppHeaders target.
struct RNSpmPaths: Decodable {
    let formatVersion: Int
    let appRoot: String
}
let rnSpmPaths: RNSpmPaths = {
    let url = URL(fileURLWithPath: packageDir + "/${rel}spm-paths.json").standardized
    guard let data = try? Data(contentsOf: url),
          let decoded = try? JSONDecoder().decode(RNSpmPaths.self, from: data) else {
        fatalError("React Native SPM: cannot read \\(url.path). Run 'npx react-native spm' to (re)generate it.")
    }
    precondition(
        decoded.formatVersion == 1,
        "React Native SPM: spm-paths.json formatVersion \\(decoded.formatVersion) is unsupported (expected 1). Upgrade react-native or re-run 'npx react-native spm'."
    )
    return decoded
}()
let appRoot = rnSpmPaths.appRoot`;
}

/**
 * Creates a first-wins symlink linker rooted at `outDir`. `linkInto` maps a
 * virtual import path to a physical file; `foldDir` recursively links every
 * .h/.hpp under a source root. `seen` records virtual->realpath so identical
 * duplicates collapse to one inode and non-identical collisions are surfaced.
 * Each header tree gets its OWN linker (own `seen` map) so first-wins does not
 * span the shared/per-app boundary.
 */
function createHeaderLinker(
  outDir /*: string */,
  logger /*: {log: (msg: string) => void} */,
) /*: {
  seen: Map<string, string>,
  stats: {collisions: number},
  linkInto: (virtualPath: string, physical: string) => void,
  foldDir: (srcRoot: string) => void,
} */ {
  const seen /*: Map<string, string> */ = new Map();
  const stats = {collisions: 0};

  function linkInto(
    virtualPath /*: string */,
    physical /*: string */,
  ) /*: void */ {
    let real;
    try {
      real = fs.realpathSync(physical);
    } catch {
      return; // physical file missing — skip
    }
    const prev = seen.get(virtualPath);
    if (prev != null) {
      if (prev !== real) {
        stats.collisions++;
        logger.log(
          `WARNING: merged headers: non-identical collision for ${virtualPath} (kept first)`,
        );
      }
      return;
    }
    seen.set(virtualPath, real);
    const dest = path.join(outDir, virtualPath);
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.symlinkSync(real, dest);
  }

  function foldDir(srcRoot /*: string */) /*: void */ {
    let real;
    try {
      real = fs.realpathSync(srcRoot);
    } catch {
      return;
    }
    if (!fs.statSync(real).isDirectory()) {
      return;
    }
    const dirs /*: Array<string> */ = [real];
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir == null) {
        break;
      }
      for (const ent of fs.readdirSync(dir, {withFileTypes: true})) {
        const name = String(ent.name);
        const child = path.join(dir, name);
        // statSync (not the Dirent flags) so symlinks are followed — the
        // autolinking header farm is itself a symlink farm, so its leaf
        // headers are symlinks, not regular files.
        let st;
        try {
          st = fs.statSync(child);
        } catch {
          continue; // broken symlink — skip
        }
        if (st.isDirectory()) {
          dirs.push(child);
        } else if (
          st.isFile() &&
          (name.endsWith('.h') || name.endsWith('.hpp'))
        ) {
          linkInto(path.relative(real, child), child);
        }
      }
    }
  }

  return {seen, stats, linkInto, foldDir};
}

/*::
type HeaderTreeResult = {path: ?string, virtualPaths: Set<string>};
*/

/**
 * Materializes the PER-APP header tree at
 * <appRoot>/build/xcframeworks/ReactAppHeaders: autolinking dep headers + codegen
 * output. Per-app because it depends on which libraries the app links and the
 * app's generated specs. Returns {path, virtualPaths}.
 */
function buildPerAppHeaderTree(
  appRoot /*: string */,
  logger /*: {log: (msg: string) => void} */ = {log() {}},
) /*: HeaderTreeResult */ {
  const outDir = perAppHeadersDir(appRoot);
  // Build into a temp sibling, then swap: the farm now lives INSIDE
  // build/generated/ios (one of the trees being folded), so building in place
  // would make foldDir walk the half-built farm itself.
  const tmpDir = outDir + '.tmp';
  fs.rmSync(tmpDir, {recursive: true, force: true});
  fs.rmSync(outDir, {recursive: true, force: true});
  fs.mkdirSync(tmpDir, {recursive: true});

  const linker = createHeaderLinker(tmpDir, logger);
  linker.foldDir(
    path.join(appRoot, 'build', 'generated', 'autolinking', 'headers'),
  );
  linker.foldDir(path.join(appRoot, 'build', 'generated', 'ios'));
  linker.foldDir(
    path.join(appRoot, 'build', 'generated', 'ios', 'ReactCodegen'),
  );

  // Stub source so the farm is a valid SPM target (vended headers-only —
  // see the ReactAppHeaders target in the codegen Package.swift template).
  fs.writeFileSync(
    path.join(tmpDir, 'ReactAppHeadersStub.c'),
    '// ReactAppHeaders vends the per-app generated headers; this stub\n' +
      '// satisfies SPM, which requires at least one source file per target.\n' +
      'static int ReactAppHeadersStub __attribute__((unused)) = 0;\n',
  );
  fs.renameSync(tmpDir, outDir);

  logger.log(
    `Built per-app header tree (${linker.seen.size} headers` +
      (linker.stats.collisions > 0
        ? `, ${linker.stats.collisions} non-identical collisions`
        : '') +
      ')',
  );
  return {path: outDir, virtualPaths: new Set(linker.seen.keys())};
}

/**
 * Writes the PER-APP single-source-of-truth spm-paths.json. Generated build-dir
 * manifests read it at SPM-eval time (appRoot — used to locate the ReactNative
 * and codegen packages). Header resolution itself needs NO paths: headers are
 * served by the React/ReactNativeHeaders binaryTargets and the ReactAppHeaders
 * SPM target. Holds machine-absolute paths.
 */
function writeAppPathsJson(
  appRoot /*: string */,
  logger /*: {log: (msg: string) => void} */ = {log() {}},
) /*: void */ {
  const outDir = path.join(appRoot, 'build', 'generated', 'autolinking');
  fs.mkdirSync(outDir, {recursive: true});
  const json = {
    formatVersion: 1,
    appRoot,
    // Retained for older scaffolded manifests that still decode it.
    appHeaders: perAppHeadersDir(appRoot),
    // The generated ReactNative binary-target package (React/Hermes/deps
    // xcframeworks). Provided so consumer manifests can `.package(path:)` it
    // without hardcoding the build/xcframeworks layout.
    reactNativePackage: path.join(appRoot, 'build', 'xcframeworks'),
    cxxStd: 'c++20',
  };
  fs.writeFileSync(
    path.join(outDir, 'spm-paths.json'),
    JSON.stringify(json, null, 2) + '\n',
    'utf8',
  );
  logger.log('Wrote spm-paths.json');
}

/**
 * Writes the APP-INDEPENDENT repo-root .react-native/paths.json that
 * hand-authored community Package.swift files read (via nearest-ancestor walk)
 * for the shared RN-core `-I`. Holds machine-absolute paths — must be gitignored.
 */
function writeSharedPathsJson(
  projectRoot /*: string */,
  slotVersion /*: string */,
  reactNativeVersion /*: string */,
  logger /*: {log: (msg: string) => void} */ = {log() {}},
) /*: void */ {
  const roots = composedHeaderRoots();
  const outDir = path.join(projectRoot, '.react-native');
  fs.mkdirSync(outDir, {recursive: true});
  // Self-ignoring .gitignore: the whole .react-native/ dir is generated,
  // machine-specific build state. A folder-local `*` keeps it out of git in
  // every layout (single-app or monorepo, where .react-native/ sits at the
  // project root above the app's own .gitignore). `*` also ignores this file
  // itself, so the dir disappears from git entirely.
  fs.writeFileSync(path.join(outDir, '.gitignore'), '*\n', 'utf8');
  // GRANDFATHERED `-I` contract for hand-authored community manifests:
  // rnCoreHeaders now points INSIDE the composed artifact (the one canonical
  // React/react header root); rnhHeaders carries the remaining namespaces.
  // The community-scaffold redesign (product-deps based) supersedes this.
  const json = {
    formatVersion: 1,
    rnCoreHeaders: roots.react ?? '',
    rnhHeaders: roots.rnh ?? '',
    reactNativeVersion,
    cacheSlot: slotVersion,
  };
  fs.writeFileSync(
    path.join(outDir, 'paths.json'),
    JSON.stringify(json, null, 2) + '\n',
    'utf8',
  );
  logger.log('Wrote .react-native/paths.json');
}

/**
 * Runs React Native codegen and installs the SPM Package.swift template
 * into build/generated/ios/. Used by both setup-apple-spm.js and
 * sync-spm-autolinking.js.
 */

/**
 * Installs the SPM codegen template into build/generated/ios/Package.swift.
 * No-op when the template or the generated/ios dir is missing — codegen
 * may not have produced output yet, or the project may be SPM-only.
 *
 * The template is copied verbatim: it embeds the renderRNPathsLoader block,
 * which reads the two header-tree paths from spm-paths.json at SPM-eval time, so
 * there are no absolute/cache-slot paths in the manifest text to substitute. The
 * trees are refreshed per slot by the split header builders, while the manifest
 * text — and thus SPM's manifest hash — stays constant.
 */
function installSpmCodegenTemplate(
  appRoot /*: string */,
  reactNativeRoot /*: string */,
  logger /*: {log: (msg: string) => void} */ = {log() {}},
) /*: void */ {
  const spmTemplate = path.join(
    reactNativeRoot,
    'scripts',
    'codegen',
    'templates',
    'Package.swift.spm-template',
  );
  const codegenPkgSwift = path.join(
    appRoot,
    'build',
    'generated',
    'ios',
    'Package.swift',
  );
  if (
    !fs.existsSync(spmTemplate) ||
    !fs.existsSync(path.dirname(codegenPkgSwift))
  ) {
    return;
  }
  fs.writeFileSync(
    codegenPkgSwift,
    fs.readFileSync(spmTemplate, 'utf8'),
    'utf8',
  );
  logger.log('Installed SPM codegen template');
}

function runCodegenAndInstallTemplate(
  projectRoot /*: string */,
  appRoot /*: string */,
  reactNativeRoot /*: string */,
  logger /*: {log: (msg: string) => void} */ = {log() {}},
  opts /*: {installTemplate?: boolean} */ = {},
) /*: void */ {
  const codegenScript = path.join(
    reactNativeRoot,
    'scripts',
    'generate-codegen-artifacts.js',
  );
  if (!fs.existsSync(codegenScript)) {
    return;
  }
  logger.log('Running codegen...');
  const {execSync} = require('child_process');
  const codegenArgs =
    `node "${codegenScript}" -p "${projectRoot}" -t ios` +
    (projectRoot !== appRoot ? ` -o "${appRoot}"` : '');
  execSync(codegenArgs, {stdio: 'inherit', cwd: projectRoot});
  // Callers that re-point the xcframework symlinks after codegen (e.g. the SPM
  // sync, which runs generate-spm-package afterwards) install the template
  // themselves once the symlinks are final; they pass installTemplate: false to
  // avoid a wasted write that the later install would immediately supersede.
  if (opts.installTemplate !== false) {
    installSpmCodegenTemplate(appRoot, reactNativeRoot, logger);
  }
}

module.exports = {
  makeLogger,
  displayPath,
  sharedCacheDir,
  defaultCacheDir,
  toSwiftName,
  deriveAppName,
  readPackageJson,
  findProjectRoot,
  resolveReactNativeRoot,
  buildPerAppHeaderTree,
  composedHeaderRoots,
  writeAppPathsJson,
  writeSharedPathsJson,
  renderRNPathsLoader,
  installSpmCodegenTemplate,
  runCodegenAndInstallTemplate,
  SCAFFOLDER_MARKER,
};
