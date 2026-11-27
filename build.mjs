import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const out = await build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2020' });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
// Schrift (Inter, SIL Open Font License) direkt einbetten, damit die App offline gleich aussieht
const font = readFileSync('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2').toString('base64');
const html = readFileSync('src/index.html', 'utf8')
  .replace('/*FONT*/', () => font)
  .replace('<script>/*BUNDLE*/</script>', () => `<script>${js}</script>`);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/AimForge.html', html);
console.log('dist/AimForge.html', (html.length / 1024).toFixed(0) + ' KB');
