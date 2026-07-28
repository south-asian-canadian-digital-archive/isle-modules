/**
 * @file
 * <sacda-exhibit> custom element.
 *
 * Fetches an exhibit's index.html, rewrites its relative asset paths against
 * the module's asset route, and injects the result into a Shadow DOM root so
 * exhibit CSS and the SACDA theme CSS cannot leak into each other.
 *
 * Attributes:
 *   src  - URL of the exhibit's index.html (served by the asset route).
 *   base - Base URL (trailing slash) relative paths are rewritten against.
 *
 * Known prototype limitations (see exhibits/README.md):
 * - Exhibit <script>s execute in the page's global scope, not the shadow
 *   scope. document.querySelector() will not see exhibit markup; scripts can
 *   use the shadow root exposed at window.sacdaExhibitRoot instead.
 * - url(...) references inside CSS files resolve against the stylesheet's own
 *   URL, which lives under the asset route, so relative url()s work unchanged.
 */
(function () {
  'use strict';

  /** Attributes that may hold relative URLs needing rewriting. */
  const URL_ATTRS = ['src', 'href', 'poster', 'data-src'];

  /** True when a URL is relative to the exhibit (not absolute/anchor/data:). */
  function isRelative(url) {
    return url && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(url);
  }

  function rewriteUrls(root, base) {
    for (const el of root.querySelectorAll('*')) {
      for (const attr of URL_ATTRS) {
        const val = el.getAttribute(attr);
        if (isRelative(val)) {
          el.setAttribute(attr, base + val);
        }
      }
      const srcset = el.getAttribute('srcset');
      if (srcset) {
        el.setAttribute(
          'srcset',
          srcset
            .split(',')
            .map((part) => {
              const [url, size] = part.trim().split(/\s+/, 2);
              return (isRelative(url) ? base + url : url) + (size ? ' ' + size : '');
            })
            .join(', ')
        );
      }
    }
  }

  class SacdaExhibit extends HTMLElement {
    async connectedCallback() {
      if (this.shadowRoot) {
        return;
      }
      const src = this.getAttribute('src');
      const base = this.getAttribute('base') || '';
      if (!src) {
        return;
      }

      const shadow = this.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<slot></slot>'; // Keep the loading fallback visible.

      let doc;
      try {
        const res = await fetch(src, { credentials: 'same-origin' });
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      }
      catch (e) {
        shadow.innerHTML = '<p style="padding:2rem;text-align:center">Sorry, this exhibit failed to load.</p>';
        console.error('[sacda-exhibit] failed to load', src, e);
        return;
      }

      rewriteUrls(doc, base);
      shadow.innerHTML = '';

      // Carry over <head> styles/stylesheets, then the body markup.
      for (const el of doc.head.querySelectorAll('style, link[rel="stylesheet"]')) {
        shadow.appendChild(el.cloneNode(true));
      }
      const scripts = [];
      for (const el of Array.from(doc.body.children)) {
        const node = el.cloneNode(true);
        shadow.appendChild(node);
        for (const s of node.matches('script') ? [node] : node.querySelectorAll('script')) {
          scripts.push(s);
        }
      }
      for (const s of doc.head.querySelectorAll('script')) {
        scripts.push(shadow.appendChild(s.cloneNode(true)));
      }

      // Scripts inserted via innerHTML/cloneNode never execute; recreate them.
      // Expose the shadow root so exhibit JS can query its own markup.
      window.sacdaExhibitRoot = shadow;
      for (const old of scripts) {
        const fresh = document.createElement('script');
        for (const attr of old.attributes) {
          fresh.setAttribute(attr.name, attr.value);
        }
        fresh.textContent = old.textContent;
        if (old.src) {
          // Preserve execution order for external scripts.
          await new Promise((resolve) => {
            fresh.onload = fresh.onerror = resolve;
            old.replaceWith(fresh);
          });
        }
        else {
          old.replaceWith(fresh);
        }
      }
    }
  }

  if (!customElements.get('sacda-exhibit')) {
    customElements.define('sacda-exhibit', SacdaExhibit);
  }
})();
