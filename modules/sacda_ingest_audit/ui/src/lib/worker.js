// Promise wrapper around the audit Web Worker (inlined into the bundle as a
// blob, so the Drupal library stays a single JS file).
import AuditWorker from './audit.worker.js?worker&inline';

let worker = null;
let seq = 0;
const pending = new Map();

function get() {
  if (worker) return worker;
  worker = new AuditWorker();
  worker.onmessage = ({ data }) => {
    const call = pending.get(data.id);
    if (!call) return;
    if (data.progress) return call.onProgress?.(data.progress);
    pending.delete(data.id);
    if (data.error) call.reject(new Error(data.error));
    else call.resolve(data.result);
  };
  worker.onerror = (e) => {
    for (const call of pending.values()) call.reject(new Error(e.message || 'The audit worker crashed.'));
    pending.clear();
    worker = null;
  };
  return worker;
}

function call(message, transfer = [], onProgress) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    get().postMessage({ id, ...message }, transfer);
  });
}

/** Parse a File or CSV text. */
export async function parse(name, fileOrText) {
  const data = typeof fileOrText === 'string' ? fileOrText : await fileOrText.arrayBuffer();
  return call({ type: 'parse', name, data }, typeof data === 'string' ? [] : [data]);
}

/** Run an audit; drupalSettings are passed with an absolute origin. */
export function audit(table, settings, options, onProgress) {
  return call({ type: 'audit', table, settings: { ...settings, origin: location.origin }, options }, [], onProgress);
}
