import css from './theme.css';

let injected = false;

export function injectThemeStylesheet(root: Document | ShadowRoot = document): void {
  if (injected && root === document) return;
  const style = document.createElement('style');
  style.setAttribute('data-liveinterface-theme', '');
  style.textContent = css;
  (root === document ? document.head : (root as ShadowRoot)).appendChild(style);
  if (root === document) injected = true;
}

export const themeCss = css;
