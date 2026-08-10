import { icon } from './icons.js';
import { escapeHtml } from './utils.js';

export function showToast(message, type = 'success') {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  root.appendChild(toast);
  window.setTimeout(() => toast.remove(), 2400);
}

export function openOverlay({ title, content, variant = 'sheet', submitLabel = '', onSubmit = null, onClose = null, dismissible = true }) {
  const root = document.getElementById('overlay-root');
  const overlay = document.createElement('div');
  overlay.className = `overlay overlay-${variant}`;
  overlay.innerHTML = `
    <section class="overlay-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <header class="overlay-header">
        <h2>${escapeHtml(title)}</h2>
        <button type="button" class="icon-button" data-close aria-label="关闭">${icon('close')}</button>
      </header>
      <div class="overlay-body">${content}</div>
      ${submitLabel ? `<footer class="overlay-footer"><button type="button" class="primary-button" data-submit>${submitLabel}</button></footer>` : ''}
    </section>`;
  root.appendChild(overlay);
  document.body.classList.add('overlay-open');

  const close = (notify = true) => {
    if (!overlay.isConnected) return;
    overlay.remove();
    if (!root.children.length) document.body.classList.remove('overlay-open');
    if (notify && onClose) onClose();
  };
  overlay.querySelector('[data-close]').addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && variant !== 'full' && dismissible) close();
  });
  if (submitLabel && onSubmit) {
    overlay.querySelector('[data-submit]').addEventListener('click', () => onSubmit({ overlay, close }));
  }
  window.setTimeout(() => {
    const focusTarget = overlay.querySelector('input, button, [tabindex]');
    if (focusTarget) focusTarget.focus();
  }, 0);
  return { overlay, close };
}

export function openActionSheet(title, actions) {
  const content = `<div class="action-list">${actions.map((action, index) => `
    <button type="button" class="action-row ${action.danger ? 'danger' : ''}" data-index="${index}">
      <span class="action-icon">${icon(action.icon)}</span>
      <span>${action.label}</span>
    </button>`).join('')}</div>`;
  const panel = openOverlay({ title, content });
  panel.overlay.querySelector('.action-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-index]');
    if (!button) return;
    const action = actions[Number(button.dataset.index)];
    panel.close();
    if (action && action.run) action.run();
  });
  return panel;
}

export function promptText({ title, label, value = '', submitLabel = '确定' }) {
  return new Promise((resolve) => {
    const content = `
      <form class="dialog-form" data-form>
        <label class="field-label" for="dialog-value">${label}</label>
        <input id="dialog-value" class="text-field" name="value" value="${String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" autocomplete="off" required>
      </form>`;
    const panel = openOverlay({
      title,
      content,
      submitLabel,
      onClose: () => resolve(null),
      onSubmit: ({ overlay, close }) => {
        const input = overlay.querySelector('[name="value"]');
        const nextValue = input.value.trim();
        if (!nextValue) {
          input.focus();
          return;
        }
        close(false);
        resolve(nextValue);
      },
    });
    panel.overlay.querySelector('[data-form]').addEventListener('submit', (event) => {
      event.preventDefault();
      panel.overlay.querySelector('[data-submit]').click();
    });
  });
}

export function confirmDialog({ title, message, confirmLabel = '删除', danger = false }) {
  return new Promise((resolve) => {
    const panel = openOverlay({
      title,
      content: `<p class="dialog-message">${message}</p>`,
      submitLabel: confirmLabel,
      onClose: () => resolve(false),
      onSubmit: ({ close }) => {
        close(false);
        resolve(true);
      },
    });
    if (danger) panel.overlay.querySelector('[data-submit]').classList.add('danger-button');
  });
}

export async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export function loadingView(label = '加载中') {
  return `<div class="state-view"><span class="spinner" aria-hidden="true"></span><p>${label}</p></div>`;
}

export function errorView(label = '加载失败') {
  return `<div class="state-view state-error">${icon('info')}<p>${label}</p></div>`;
}
