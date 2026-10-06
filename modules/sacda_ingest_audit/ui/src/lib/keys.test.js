import { expect, test } from 'bun:test';
import { typingIn } from './keys.js';

const el = (tag, type) => ({ closest: (sel) => (sel.split(',').map((s) => s.trim().split(/[:[]/)[0]).includes(tag) ? { type } : null) });

test('text fields swallow shortcuts; checkboxes and buttons do not', () => {
  expect(typingIn(el('input', 'text'))).toBe(true);
  expect(typingIn(el('input', 'search'))).toBe(true);
  expect(typingIn(el('textarea'))).toBe(true);
  expect(typingIn(el('select'))).toBe(true);
  expect(typingIn(el('input', 'checkbox'))).toBe(false);
  expect(typingIn(el('button'))).toBe(false);
});
