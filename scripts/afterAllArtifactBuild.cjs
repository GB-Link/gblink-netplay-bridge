const fs = require('node:fs');

/**
 * Rename architecture slugs in finished artifacts to the words users
 * recognize, so a download page makes the right choice obvious.
 */
const RENAMES = [
  [/-macOS-x64\.dmg$/, '-macOS-Intel.dmg'],
  [/-macOS-arm64\.dmg$/, '-macOS-AppleSilicon.dmg'],
  [/-Linux-x64\.AppImage$/, '-Linux-x86_64.AppImage'],
];

exports.default = async function afterAllArtifactBuild(result) {
  for (const artifact of result.artifactPaths) {
    const rule = RENAMES.find(([pattern]) => pattern.test(artifact));
    if (!rule) continue;
    const renamed = artifact.replace(rule[0], rule[1]);
    fs.renameSync(artifact, renamed);
    if (fs.existsSync(`${artifact}.blockmap`)) {
      fs.renameSync(`${artifact}.blockmap`, `${renamed}.blockmap`);
    }
  }
};
