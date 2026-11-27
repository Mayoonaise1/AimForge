// Erzeugt build/icon.png (512 px) und build/icon.ico (16–256 px) aus build/icon.svg
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const root = path.join(__dirname, '..');
  const svg = fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8');
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 512, height: 512 } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="512" height="512" ')}</body></html>`);
  await p.screenshot({ path: path.join(root, 'build/icon.png'), omitBackground: true });
  for (const s of [256]) {
    await p.setViewportSize({ width: s, height: s });
    await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
    await p.screenshot({ path: path.join(root, `build/icon-${s}.png`), omitBackground: true });
  }
  await b.close();
  const { default: pngToIco } = await import('png-to-ico');
  fs.writeFileSync(path.join(root, 'build/icon.ico'), await pngToIco(path.join(root, 'build/icon-256.png')));
  fs.unlinkSync(path.join(root, 'build/icon-256.png'));
  console.log('build/icon.png + build/icon.ico erzeugt');
})();
