/**
 * Write a workspace package's version into the root package-lock.json.
 *
 * Release scripts bump `version` in a package's package.json; npm keeps a copy of it in
 * the root lockfile (`packages["packages/<name>"].version`) and only refreshes it on the
 * next `npm install`. Without this step a release commit carries a lockfile that
 * contradicts the released version.
 *
 * Usage from a release script:
 *   require('../../scripts/sync-lockfile-version.cjs').syncLockfileVersion(__dirname, newVersion)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCKFILE = path.join(ROOT, 'package-lock.json');

/**
 * Args:
 *   packageDir: absolute path of the workspace package (e.g. packages/host).
 *   version: the version just written to that package's package.json.
 * Returns the previous lockfile version. Throws if the lockfile has no entry for the
 * package or would not round-trip unchanged, so a release never rewrites it blindly.
 */
function syncLockfileVersion(packageDir, version) {
    const key = path.relative(ROOT, packageDir).split(path.sep).join('/');
    const text = fs.readFileSync(LOCKFILE, 'utf8');
    const lock = JSON.parse(text);
    if (JSON.stringify(lock, null, 2) + '\n' !== text) {
        throw new Error('package-lock.json is not in npm format; run `npm install` first');
    }
    const entry = lock.packages && lock.packages[key];
    if (!entry) {
        throw new Error(`package-lock.json has no entry for ${key}; run \`npm install\` first`);
    }
    const previous = entry.version;
    entry.version = version;
    fs.writeFileSync(LOCKFILE, JSON.stringify(lock, null, 2) + '\n', 'utf8');
    return previous;
}

module.exports = { syncLockfileVersion };
