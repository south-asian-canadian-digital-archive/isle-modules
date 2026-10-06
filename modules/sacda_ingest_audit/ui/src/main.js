import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

// The page callback renders an empty <div id="sacda-ingest-audit"> and passes
// field schema + endpoints in drupalSettings.sacdaIngestAudit.
const target = document.getElementById('sacda-ingest-audit');
if (target) {
  mount(App, { target, props: { settings: window.drupalSettings?.sacdaIngestAudit ?? {} } });
}
