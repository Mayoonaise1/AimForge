// Nur für Builds unter Linux (mit Wine): Icon und Programminfos in AimForge.exe schreiben.
// Unter Windows erledigt electron-builder das selbst – dort ist dieses Skript wirkungslos.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32' || process.platform === 'win32') return;
  if (ctx.packager.platformSpecificBuildOptions.signAndEditExecutable !== false) return;
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  const root = path.join(os.homedir(), '.cache/electron-builder/winCodeSign');
  const dir = fs.readdirSync(root).find((d) => d.startsWith('winCodeSign-') && fs.statSync(path.join(root, d)).isDirectory());
  const rcedit = path.join(root, dir, 'rcedit-x64.exe');
  const info = ctx.packager.appInfo;
  const args = [rcedit, exe, '--set-icon', path.join(__dirname, '..', 'build', 'icon.ico'),
    '--set-file-version', info.version, '--set-product-version', info.version,
    '--set-version-string', 'ProductName', info.productName, '--set-version-string', 'FileDescription', info.productName,
    '--set-version-string', 'CompanyName', info.companyName || info.productName, '--set-version-string', 'LegalCopyright', info.copyright,
    '--set-version-string', 'OriginalFilename', `${info.productFilename}.exe`, '--set-version-string', 'InternalName', info.productName];
  for (let i = 1; i <= 3; i++) {
    try { execFileSync('wine', args, { stdio: 'ignore', env: { ...process.env, WINEDEBUG: '-all' } }); console.log('  • Icon und Programminfos gesetzt (rcedit über Wine)'); return; }
    catch (e) { console.log(`  • rcedit Versuch ${i} fehlgeschlagen (${e.signal || e.status})`); }
  }
  // Testbuild trotzdem fertigstellen – die offizielle Version baut GitHub Actions unter Windows (mit Icon)
  console.log('  ⚠ Wine funktioniert hier nicht: AimForge.exe bleibt ohne Icon (nur für Testbuilds)');
};
