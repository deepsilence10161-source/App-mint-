/* ============================================================================
   LOG CONSOLE — what actually happened, as it happened
   ----------------------------------------------------------------------------
   The design prompt asks for a real-time log console: a collapsible drawer,
   monospace, colour-coded levels, searchable.

   The rule for what goes in it is the same as everywhere else in this app. A
   log console is very easy to fake — a few lines of plausible output on a timer
   look exactly like a build doing something. So the only entries here are real
   events: the specification being committed, the run appearing, each step
   changing state as GitHub reports it, the artifacts that were stored, and the
   times the Studio could not reach the API. Nothing is written to make the
   drawer look busy, and when nothing has happened the drawer is not there at all.
   ========================================================================= */

const LOG_LEVELS = ['all', 'info', 'step', 'ok', 'warn', 'error'];

function renderLogConsole() {
  const entries = S.log || [];
  const q = (S.logQuery || '').toLowerCase();
  const level = S.logLevel || 'all';

  const shown = entries.filter((e) =>
    (level === 'all' || e.level === level) &&
    (!q || e.text.toLowerCase().includes(q) || e.level.includes(q)));

  const head = el('button', {
    class: 'loghead', type: 'button', id: 'logtoggle',
    'aria-expanded': S.logOpen ? 'true' : 'false',
    onclick: () => {
      S.logOpen = !S.logOpen;
      const c = $('#logconsole');
      if (c) c.replaceWith(renderLogConsole());
    },
  },
    el('span', { class: 'logdot', 'aria-hidden': 'true' }),
    el('span', { class: 'logtitle' }, 'Build log'),
    el('span', { class: 'logcount' }, entries.length ? `${shown.length} of ${entries.length}` : 'nothing yet'),
    el('span', { class: 'logchev', html: svg('<path d="m6 9 6 6 6-6"/>'), 'aria-hidden': 'true' }),
  );

  if (!S.logOpen) return el('div', { class: 'logconsole', id: 'logconsole' }, head);

  const controls = el('div', { class: 'logbar' },
    el('input', {
      type: 'search', class: 'logsearch', placeholder: 'Filter the log',
      'aria-label': 'Filter the build log', value: S.logQuery || '',
      oninput: (e) => {
        S.logQuery = e.target.value;
        // Redraw only the list, so typing does not lose the field or the cursor.
        const list = $('#loglist');
        if (list) list.replaceWith(logList());
        const n = $('#logconsole .logcount');
        if (n) n.textContent = `${(S.log || []).filter((x) => matches(x)).length} of ${(S.log || []).length}`;
      },
    }),
    el('div', { class: 'loglevels', role: 'group', 'aria-label': 'Filter by level' },
      ...LOG_LEVELS.map((l) => el('button', {
        class: 'loglevel' + (level === l ? ' on' : ''), type: 'button',
        'aria-pressed': level === l ? 'true' : 'false',
        onclick: () => {
          S.logLevel = l;
          const c = $('#logconsole');
          if (c) c.replaceWith(renderLogConsole());
        },
      }, l)),
    ),
    entries.length
      ? el('button', {
          class: 'btn ghost small', type: 'button',
          onclick: () => {
            S.log = [];
            const c = $('#logconsole');
            if (c) c.replaceWith(renderLogConsole());
          },
        }, 'Clear')
      : null,
  );

  return el('div', { class: 'logconsole open', id: 'logconsole' }, head, controls, logList());
}

function matches(e) {
  const q = (S.logQuery || '').toLowerCase();
  const level = S.logLevel || 'all';
  return (level === 'all' || e.level === level) &&
    (!q || e.text.toLowerCase().includes(q) || e.level.includes(q));
}

function logList() {
  const shown = (S.log || []).filter(matches);
  return el('ol', { class: 'loglist', id: 'loglist' },
    shown.length
      ? shown.map((e) => el('li', { class: `lv-${e.level}` },
          el('span', { class: 'lt' }, e.t),
          el('span', { class: 'll' }, e.level),
          el('span', { class: 'lx' }, e.text),
        ))
      : el('li', { class: 'logempty' },
          (S.log || []).length
            ? 'Nothing matches that filter.'
            : 'Nothing has happened yet. Start a build and the entries here will be what GitHub reports, not a description of what a build usually does.'),
  );
}
