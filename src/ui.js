// Kleine UI-Bausteine: Bestätigungsdialog, Hinweis-Toasts
import { icon } from './icons.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Eigener Dialog statt window.confirm(). Ergebnis: true (OK) oder false (Abbrechen / ESC / Klick daneben) */
export function confirmDialog({ title, text = '', ok = 'OK', cancel = 'Abbrechen', danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'dialog-wrap';
    wrap.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="dialog-icon ${danger ? 'danger' : ''}">${icon(danger ? 'triangle-alert' : 'info', 22)}</div>
      <h3>${esc(title)}</h3>${text ? `<p class="muted">${esc(text)}</p>` : ''}
      <div class="row end"><button data-r="0">${esc(cancel)}</button><button data-r="1" class="${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div></div>`;
    const close = (v) => { document.removeEventListener('keydown', onKey, true); wrap.classList.add('out'); setTimeout(() => wrap.remove(), 140); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } if (e.key === 'Enter') { e.preventDefault(); close(true); } };
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(false); });
    wrap.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => close(b.dataset.r === '1')));
    document.addEventListener('keydown', onKey, true);
    document.body.append(wrap);
    wrap.querySelector('[data-r="1"]').focus();
  });
}

/** kurzer Hinweis unten rechts */
export function toast(text, kind = 'ok') {
  let host = document.getElementById('toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.append(host); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `${icon(kind === 'ok' ? 'circle-check' : kind === 'warn' ? 'triangle-alert' : 'info', 18)}<span>${esc(text)}</span>`;
  host.append(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3500);
}
