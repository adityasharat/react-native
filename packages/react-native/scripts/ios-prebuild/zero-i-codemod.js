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
 * ZERO-I SPIKE (part 2) — consumer-side include codemod.
 *
 * Rewrites #include/#import lines in CONSUMER code (app native sources,
 * spmModules, codegen output) from the bare natural-path form served by the
 * old `-I` (`<react/renderer/...>`, `<jsi/jsi.h>`, ...) to the framework form
 * served by the repackaged artifact (`<React/react/renderer/...>`). Tokens
 * already in `<React/...>` form are framework-correct and left alone; tokens
 * that are NOT shipped React headers (the app's own codegen components, its
 * own headers, system/SDK includes) are left alone.
 *
 * This is the spike-scale prototype of the Workstream E / step 10 ecosystem
 * codemod. In-place and idempotent.
 *
 * Usage:
 *   node scripts/ios-prebuild/zero-i-codemod.js <dir> [<dir> ...]
 */

const fs = require('fs');
const path = require('path');
const {globSync} = require('tinyglobby');

const RN_ROOT = path.join(__dirname, '..', '..');
const MANIFEST = path.join(RN_ROOT, 'build', 'header-inventory.json');

const SOURCE_GLOB = '**/*.{h,hpp,m,mm,c,cc,cpp,cxx}';
const SOURCE_IGNORE = ['**/node_modules/**', '**/Pods/**'];
// Any preprocessor line that mentions a header token: #include/#import lines
// AND #if/#elif __has_include(<...>) conditions — both must be rewritten
// together or a __has_include chain falls through to a stale branch.
const PP_LINE_RE = /^\s*#\s*(include|import|if|elif)\b/;
const TOKEN_RE = /<([^<>"]+)>/g;

function codemodDirs(
  dirs /*: Array<string> */,
) /*: {filesChanged: number, linesRewritten: number} */ {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const naturalPaths /*: Set<string> */ = new Set(
    manifest.headers.map(h => h.naturalPath),
  );

  let filesChanged = 0;
  let linesRewritten = 0;
  for (const dir of dirs) {
    const files = globSync(SOURCE_GLOB, {
      cwd: path.resolve(dir),
      absolute: true,
      ignore: SOURCE_IGNORE,
    });
    for (const file of files) {
      const original = fs.readFileSync(file, 'utf8');
      let changed = false;
      const updated = original
        .split('\n')
        .map(line => {
          if (!PP_LINE_RE.test(line)) {
            return line;
          }
          let lineChanged = false;
          const next = line.replace(TOKEN_RE, (full, token) => {
            if (naturalPaths.has(token) && !token.startsWith('React/')) {
              lineChanged = true;
              return `<React/${token}>`;
            }
            return full;
          });
          if (lineChanged) {
            changed = true;
            linesRewritten++;
          }
          return next;
        })
        .join('\n');
      if (changed) {
        fs.writeFileSync(file, updated);
        filesChanged++;
      }
    }
  }
  return {filesChanged, linesRewritten};
}

if (require.main === module) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('usage: zero-i-codemod.js <dir> [<dir> ...]');
    process.exit(2);
  }
  const {filesChanged, linesRewritten} = codemodDirs(dirs);
  console.log(
    `zero-i codemod: rewrote ${linesRewritten} include lines in ${filesChanged} files`,
  );
}

module.exports = {codemodDirs, MANIFEST};
