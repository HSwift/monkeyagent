const pkg = require('../package.json');

/**
 * Derive extension version from pkg.version and pkg.beta fields.
 *
 * > manifest.version = `${pkg.version}.${pkg.beta}`
 */
function getVersion() {
  return (
    process.env.VERSION ||
    `${pkg.version.match(/\d+\.\d+/)[0]}.${pkg.beta || 0}`
  );
}

function isBeta() {
  const { BETA } = process.env;
  // An explicit BETA env (e.g. `BETA=0` for tagged releases) wins over pkg.beta
  if (BETA != null && BETA !== '') return BETA !== '0' && BETA !== 'false';
  return pkg.beta > 0;
}

exports.getVersion = getVersion;
exports.isBeta = isBeta;
