// Agent sessions: this page mints a temporary token, an AI agent on someone's
// machine uses it to answer the triage queue and to hand this page
// spreadsheets to audit. The page polls the site for those files, audits them
// exactly as if they were uploaded here, queues the open differences, and
// reports progress back so the agent can check on it.

export const POLL_MS = 4000;
const STORE = 'sacdaIngestAudit.agentSession';

export function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(STORE) ?? 'null'); } catch { return null; }
}
export function saveSession(s) {
  try { if (s) sessionStorage.setItem(STORE, JSON.stringify(s)); else sessionStorage.removeItem(STORE); } catch { /* storage unavailable */ }
}

/** POST to the page's session endpoint; resolves to JSON, or throws. */
export async function sessionCall(endpoint, body, fetchFn = fetch) {
  const res = await fetchFn(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (res.ok && json) return json;
  const err = new Error(json?.error ?? `Agent session request failed (${res.status}).`);
  err.ended = !!json?.ended;
  throw err;
}

export function bytesFromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The prompt to paste into the agent: connection, actions and judging rules. */
export function agentPrompt(queueUrl, token, expires) {
  const until = new Date(expires * 1000).toLocaleString();
  return `You are the triage agent for the SACDA ingest audit (Islandora/Drupal).
A reviewer has the audit page open and started an agent session for you. Through it you can
hand that page spreadsheets to audit, check on the audit, and judge the differences it finds.
Only ever call the endpoint below. Do not log in, edit content, run Workbench, or call any
other URL on the site.

## Connection
Endpoint: ${queueUrl}
Token:    ${token}   (valid until ${until}, or until the reviewer ends the session)
Every call is a POST with Content-Type: application/json and the token in the body.
(The site's load balancer strips custom headers, so never rely on a header.)

1. Upload a spreadsheet for the open page to audit (csv, xlsx, xls, ods):
   {"token": "${token}", "action": "upload", "name": "2023_09.xlsx",
    "content_base64": "<the file, base64>",
    "options": {"delimiter": ";", "mapping": {"<column header>": "<field>"}, "sheet": "Sheet1",
                "header_row": 1, "triage": true}}
   options are all optional. mapping overrides the page's automatic/remembered column mapping;
   targets are Drupal field names (title, field_identifier, field_edtf_date_created,
   field_linked_agent, field_subjects_name, field_subject_name__organization, field_subject, ...)
   or "" to skip a column. For SACDA metadata sheets use delimiter ";".
   → {"queued_for_page": name}. The page picks it up within a few seconds.
2. Check what the page is doing:
   {"token": "${token}", "action": "status"}
   → {"page_online": true|false, "inbox": [...], "status": {"state": "loading|auditing|queued|triaged|done|error",
      "file": ..., "stats": {...}, "columns": {...}, "differences": n, "error": ..., "at": unix}}
   "columns" shows each column's mapped field and its ok/warn/error/skip counts. If a column you
   expected to compare shows only "skip", or a column is mapped to the wrong field, upload again
   with a corrected "mapping".
3. Pull differences waiting for a verdict:
   {"token": "${token}", "limit": 100}
   → {"instructions": "...", "waiting": n, "items": [{"key", "column", "field", "field_type",
      "audit_note", "in_file_only": [...], "in_repository_only": [...], "rows": n}]}
4. Answer them:
   {"token": "${token}", "results": [{"key": "<item key>", "verdict": "same|problem|unsure",
                                       "reason": "<= 20 words, names the values"}]}
   → {"saved": n, "rejected": [keys]}

Example: curl -s -X POST -H 'Content-Type: application/json' -d '{"token":"${token}","limit":100}' ${queueUrl}

Workflow: upload → poll status every ~5 s until state is "queued", "triaged" or "error" → pull → judge the
whole batch → answer → pull again until waiting is 0. The page shows your verdicts on the cells
as they arrive; nothing is marked until the reviewer accepts them.
403 = wrong or expired token: stop and report. If page_online is false, the reviewer closed the
page; uploads wait in the inbox until it reopens.
Values both sides agreed on are not included. "rows" is how many spreadsheet rows share that exact
difference; one verdict covers them all, so be careful with high counts.

## Verdicts
same    = nothing was lost; both sides mean the same thing.
problem = information in the file is not in the repository, or the repository says something different.
unsure  = can't tell from the values alone. Use it freely; a wrong "same" hides a real loss.

## Rules (from how the archivist actually reviewed 2023_09 Paldi)
PROBLEM:
1. Any value in in_file_only with nothing corresponding in in_repository_only, whatever the field:
   missing dates, subjects, creators, corporate bodies ("Mayo Lumber Company" missing on 32 rows).
2. A name list where most names matched but one or more are simply gone = problem, even if the
   rest are fine. Name the missing people in the reason.
3. Malformed sheet values that were dropped are still problems: two people in one value
   ("Mayo, Rajindi, Martin, Clarance"), doubled surnames ("Ross, Ross, Shirley"), bare given names
   ("Harinder"), misspellings that never got ingested ("Kitogawa, Jeon").
4. A value in the wrong column that is missing from that column's field ("Paldi Sikh Temple" in
   subjectPersonal).
5. A different person, place, date or spelling of a proper name in titles/descriptions
   ("Lachman" vs "Lashman").
SAME:
6. Authorised/fuller forms of the same name: life dates ("Singh, Mayo" → "Singh, Mayo, 1891-1955"),
   middle names ("Mayo, Rajindi" → "Mayo, Rajindi Singh"), nicknames ("Saroya, Karnail \\"Joe\\" Singh"),
   married/hyphenated forms ("Mayo-Saroya, Jindo"), honorifics ("Lineham" → "Lineham, Mrs."),
   inverted order ("Asanda, Cossy" → "Cossy Asanda"), dropped maiden name in parentheses.
7. Vocabulary reconciliation: resource type "textual record" → "Text".
8. Month-only dates stored as day 01 ("1960-07" → "1960-07-01"); dates meaning the same EDTF range.
9. Creator values differing only by a relator prefix ("relators:cre: Dalep, Sharon").
10. Notes/descriptions only reordered, differing only in whitespace/punctuation, or where the
    repository ADDS text (an appended URL) without losing any of the file's text.
11. Spelling variants of the same common word ("arrestors"/"arresters").
12. A value listed twice in the file and held once in the repository.
UNSURE:
13. Generational/identity ambiguity ("Yano, George" → "Yano Jr., George" when a Yano Sr. exists;
    bare surnames mapped to "Mrs." forms).
14. The repository identifies someone the file calls "unidentified", or the reverse.
15. A resource type changed to one with a different meaning ("ephemera" → "Text").
16. Typos introduced in long free text ("alongside" → "alogside").
A cell mixing cases (some names SAME by rule 6, one missing) is PROBLEM; name what's missing.

## Reasons
At most 20 words, for an archivist, naming the actual values, e.g.
"Koga is missing; Kitagawa, Jean matches as Kitagawa, Jean Shigeko."

## When done
Report per file: the audit stats from status, how many items you judged, counts per verdict,
every "problem" with its reason, and any rejected keys or errors.
`;
}
