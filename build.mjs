import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const out = await build({ entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2020' });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('src/index.html', 'utf8').replace('<script>/*BUNDLE*/</script>', () => `<script>${js}</script>`);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/AimForge.html', html);
console.log('dist/AimForge.html', (html.length / 1024).toFixed(0) + ' KB');
