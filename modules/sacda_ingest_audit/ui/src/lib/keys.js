// Whether a key press belongs to a form control the viewer is typing in.
// Checkboxes, radios and buttons don't take text, so review shortcuts still
// work after ticking a filter.
const NON_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);

export function typingIn(target) {
  if (!target?.closest) return false;
  if (target.closest('textarea, select, [contenteditable]:not([contenteditable="false"])')) return true;
  const input = target.closest('input');
  return !!input && !NON_TEXT.has((input.type || 'text').toLowerCase());
}
