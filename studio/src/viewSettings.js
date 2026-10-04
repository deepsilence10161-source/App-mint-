/* ============================================================================
   SETTINGS — the raw configuration, and what it actually resolves to
   ----------------------------------------------------------------------------
   The design prompt asks for a tabbed settings layout (General / Signing /
   Permissions / Build Engine / Diagnostics) with an Advanced Mode toggle that
   "unlocks raw configuration, Gradle, manifest, and signing details".

   Most of that is here to show honestly. The one part that is not is a
   generated Gradle file or manifest document rendered in the browser: the
   generator that produces those imports node:fs and pulls in the 1,800-line
   native screen generator, so it cannot run in a page, and a hand-written
   approximation of its output would be a document that looks like the build
   without being it. What Advanced Mode shows instead is the source those files
   are generated from — the specification verbatim — plus the two derivations
   that do run in the browser and are the same code the build uses: the
   permissions that will land in the manifest, and the toolchain versions the
   build will resolve.
   ========================================================================= */

const SETTINGS_TABS = [
  ['general', 'General'],
  ['backend', 'Backend'],
  ['signing', 'Signing'],
  ['permissions', 'Permissions'],
  ['engine', 'Build Engine'],
  ['diagnostics', 'Diagnostics'],
];

function sw(checked, label, onchange) {
  return el('div', { class: 'sw' }, [
    el('input', { type: 'checkbox', checked: checked === true, role: 'switch', 'aria-label': label, onchange }),
    el('span', { class: 'track' }), el('span', { class: 'knob' }),
  ]);
}

function choose(label, ariaLabel, options, value, onpick, sub) {
  return field(label, el('div', { class: 'selectwrap' }, el('select', {
    'aria-label': ariaLabel,
    onchange: (e) => onpick(e.target.value),
  }, ...options.map(([v, text]) => el('option', { value: v, selected: v === value ? 'selected' : null }, text)))), sub);
}

/** A read-only block of something that was computed, not typed. */
function codeBlock(title, text, note) {
  return el('div', { class: 'rawbox' },
    el('div', { class: 'rawhead' },
      el('span', { class: 'rawname' }, title),
      el('button', {
        class: 'btn ghost small', type: 'button',
        onclick: async (e) => {
          try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; }
          catch { e.target.textContent = 'Copy failed'; }
          setTimeout(() => { e.target.textContent = 'Copy'; }, 1600);
        },
      }, 'Copy'),
    ),
    note ? el('p', { class: 'hint' }, note) : null,
    el('pre', { class: 'raw' }, text),
  );
}

/* ── the five tabs ──────────────────────────────────────────────────────── */

function tabGeneral(spec) {
  const id = spec.identity;
  const a = spec.android;
  return [
    section('Application', {
      icon: I.tag, open: true,
      summary: `${id.appName || 'Untitled'} · ${id.packageName || 'no package'}`,
      children: [
        field('Application name', el('input', {
          type: 'text', value: id.appName || '', 'aria-label': 'Application name (settings)',
          oninput: (e) => { id.appName = e.target.value; touch(); softUpdate(); },
        })),
        field('Package name', el('input', {
          type: 'text', value: id.packageName || '', spellcheck: 'false', autocapitalize: 'off',
          'aria-label': 'Package name (settings)',
          oninput: (e) => { id.packageName = e.target.value.trim(); touch(); softUpdate(); },
        }), 'This cannot be changed on Google Play once the app is published.'),
        field('Version name', el('input', {
          type: 'text', value: id.versionName || '', 'aria-label': 'Version name',
          oninput: (e) => { id.versionName = e.target.value.trim(); touch(); softUpdate(); },
        })),
        field('Version code', el('input', {
          type: 'number', min: '1', value: String(id.versionCode || 1), 'aria-label': 'Version code',
          oninput: (e) => { id.versionCode = parseInt(e.target.value, 10) || 1; touch(); softUpdate(); },
        }), 'Must go up with every release, or the store rejects the upload.'),
        choose('Version source', 'Version source',
          [['manual', 'Manual — I set the code'], ['git-commit-count', 'From the git commit count']],
          id.versionStrategy || 'manual',
          (v) => { id.versionStrategy = v; touch(); hardUpdate(); },
          'Counting commits means the code can never go backwards by accident.'),
      ],
    }),

    section('Android', {
      icon: I.square,
      summary: `minSdk ${a.minSdk} · targetSdk ${a.targetSdk} · ${a.theme}`,
      children: [
        field('Minimum Android version (minSdk)', el('input', {
          type: 'number', min: '21', max: '36', value: String(a.minSdk), 'aria-label': 'Minimum Android version',
          oninput: (e) => { a.minSdk = parseInt(e.target.value, 10) || 21; touch(); hardUpdate(); },
        }), 'Lower reaches more devices and inherits more compatibility bugs.'),
        field('Target Android version (targetSdk)', el('input', {
          type: 'number', min: '21', max: '36', value: String(a.targetSdk), 'aria-label': 'Target Android version',
          oninput: (e) => { a.targetSdk = parseInt(e.target.value, 10) || 36; touch(); hardUpdate(); },
        }), 'Play requires API 36 for new apps and updates since 31 August 2026.'),
        choose('Screen orientation', 'Screen orientation (settings)',
          [['portrait', 'Portrait'], ['landscape', 'Landscape'], ['sensor', 'Follow the sensor'], ['unspecified', 'Unspecified']],
          a.orientation || 'portrait', (v) => { a.orientation = v; touch(); hardUpdate(); }),
        choose('System theme', 'System theme',
          [['system', 'Follow the system'], ['light', 'Light'], ['dark', 'Dark']],
          a.theme || 'system', (v) => { a.theme = v; touch(); hardUpdate(); }),
        field('Allow backup of app data', sw(a.allowBackup, 'Allow backup of app data',
          (e) => { a.allowBackup = e.target.checked; touch(); hardUpdate(); }),
          'Off is the safer default: with it on, app data can be pulled off a device that has USB debugging enabled.'),
        field('Allow cleartext HTTP', sw(a.cleartextTraffic, 'Allow cleartext HTTP',
          (e) => { a.cleartextTraffic = e.target.checked; touch(); hardUpdate(); }),
          'Turning this on lets traffic be read or altered in transit. The security check will report it.'),
      ],
    }),
  ];
}

function tabSigning(spec) {
  const sg = spec.signing || (spec.signing = { mode: 'debug', failClosed: true });
  const outs = (spec.build || {}).outputs || ['debug-apk'];
  const wantsRelease = outs.some((o) => o !== 'debug-apk');

  return [
    section('Signing', {
      icon: I.shield, open: true,
      summary: `${sg.mode}${sg.failClosed === false ? ' · not fail-closed' : ''}`,
      children: [
        choose('Signing mode', 'Signing mode', [
          ['none', 'None — do not sign'],
          ['debug', 'Debug key'],
          ['secret-store', 'A keystore held as a CI secret'],
        ], sg.mode || 'debug', (v) => { sg.mode = v; touch(); hardUpdate(); },
          'A debug key is fine for testing. It cannot be used to publish, and an app signed with it can never be updated by a differently-signed build.'),

        field('Refuse to build if the keystore is missing', sw(sg.failClosed, 'Refuse to build if the keystore is missing',
          (e) => { sg.failClosed = e.target.checked; touch(); hardUpdate(); }),
          'If this is off and the keystore is missing, a new one would be generated — which silently changes the app identity and permanently breaks every future update.'),

        sg.mode === 'secret-store'
          ? field('Secret name holding the keystore', el('input', {
              type: 'text', value: sg.storeFileSecretName || '', spellcheck: 'false', 'aria-label': 'Keystore secret name',
              oninput: (e) => { sg.storeFileSecretName = e.target.value.trim(); touch(); softUpdate(); },
            }), 'The name of the repository secret, never the keystore itself. Nothing sensitive belongs in a specification.')
          : null,
      ],
    }),

    sg.mode === 'secret-store' && sg.failClosed === false
      ? el('div', { class: 'banner fail' }, el('div', {}, [
          el('strong', {}, 'This combination is blocked. '),
          'Signing from a secret store with fail-closed off means a missing keystore would be replaced by a fresh one. The validator reports this as critical and the build will not start.',
        ]))
      : null,

    wantsRelease && sg.mode === 'none'
      ? el('div', { class: 'banner fail' }, el('div', {}, [
          el('strong', {}, 'A release output is requested with signing disabled. '),
          `Requested outputs: ${outs.join(', ')}. An unsigned release could not be installed on any device.`,
        ]))
      : null,

    el('div', { class: 'banner info' }, el('div', {}, [
      el('strong', {}, 'What the build actually verifies. '),
      'After compiling, the finished file is checked with apksigner and zipalign, and the signing scheme is read back off the APK rather than assumed from the configuration. The result appears in the build report.',
    ])),
  ];
}

function tabBackend(spec) {
  const b = spec.backend || (spec.backend = { kind: 'none' });
  const rt = runtimeReport(spec);
  const generated = dataRuntime(spec);
  const tables = Array.isArray(b.tablesRequiringRls) ? b.tablesRequiringRls : [];

  return [
    section('Backend', {
      icon: I.briefcase, open: true,
      summary: b.kind === 'none' ? 'no backend' : `${b.kind}${b.url ? ' · ' + String(b.url).replace(/^https?:\/\//, '').slice(0, 28) : ' · no address'}`,
      children: [
        choose('Backend', 'Backend kind', [
          ['none', 'None — the app has no server'],
          ['supabase', 'Supabase'],
          ['firebase', 'Firebase'],
          ['custom-rest', 'Your own REST API'],
        ], b.kind || 'none', (v) => { b.kind = v; touch(); hardUpdate(); },
          'Choosing a backend is what makes the generated app talk to a server at all. Without it there is nothing to configure and no data runtime is emitted.'),

        b.kind !== 'none'
          ? field('Backend address', el('input', {
              type: 'url', value: b.url || '', spellcheck: 'false', autocapitalize: 'off',
              'aria-label': 'Backend address', placeholder: 'https://your-project.supabase.co',
              oninput: (e) => { b.url = e.target.value.trim(); touch(); hardUpdate(); },
            }), 'Must be https. Over plain HTTP every request, including sign-in, can be read or altered in transit.')
          : null,

        b.kind !== 'none'
          ? field('The app requires sign-in', sw(b.requiresAuth, 'Backend requires authentication',
              (e) => { b.requiresAuth = e.target.checked; touch(); hardUpdate(); }),
              'With this on, the data runtime refuses to query a table that is not listed below.')
          : null,
      ],
    }),

    b.kind !== 'none' && b.requiresAuth
      ? section('Tables needing row-level security', {
          icon: I.shield, open: true,
          summary: tables.length ? `${tables.length} declared` : 'none declared',
          children: [
            field('One table name per line', el('textarea', {
              rows: '4', 'aria-label': 'Tables needing row-level security',
              value: tables.join('\n'), spellcheck: 'false',
              oninput: (e) => {
                b.tablesRequiringRls = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean);
                touch(); hardUpdate();
              },
            }), 'Row-level security is the only thing standing between one signed-in user and another user\'s rows. The RLS gate checks these policies on every build, and a critical finding blocks it.'),
          ],
        })
      : null,

    // What the app will actually be given. Shown because a configuration screen
    // that does not say what it produces leaves a person guessing whether the
    // backend they picked did anything.
    b.kind !== 'none'
      ? section('What the app is given', {
          icon: I.code,
          summary: rt.generated ? 'a data runtime, generated' : 'nothing yet — see below',
          children: [
            generated.ok
              ? el('div', { class: 'banner pass' }, el('div', {}, [
                  el('strong', {}, 'The build emits one module that talks to this backend. '),
                  `data-runtime.js, ${(rt.bytes / 1024).toFixed(1)} KB. It owns authentication, queries, mutations, retries, offline behaviour, error normalisation and rollback, and it is the only file in the app that knows the address.`,
                ]))
              : el('div', { class: 'banner fail' }, el('div', {}, [
                  el('strong', {}, 'No data runtime can be generated. '),
                  rt.errors.join(' '),
                ])),
            el('dl', { class: 'kv' },
              el('dt', {}, 'Runtime generated'), el('dd', {}, rt.generated ? 'yes' : 'no'),
              el('dt', {}, 'Requires sign-in'), el('dd', {}, rt.requiresAuth ? 'yes' : 'no'),
              el('dt', {}, 'Tables declared'), el('dd', {}, String(rt.tables.length)),
              el('dt', {}, 'Unsafe patterns'), el('dd', {}, String(rt.unsafe.length))),
            el('p', { class: 'hint' },
              'A privileged key is never written into the app, and the build fails if one appears in generated output. Entitlement is read from the server and is read-only in the runtime: there is no setter for premium status, because anything the client can write, the client can fake.'),
          ],
        })
      : null,
  ];
}

function tabPermissions(spec) {
  const rep = permissionReport(spec);
  const derived = derivePermissions(spec);
  const rows = rep.rows.length
    ? rep.rows.map((r) => el('tr', {},
        el('td', {}, el('code', {}, r.permission)),
        el('td', {}, r.why),
        el('td', {}, r.prompt),
        el('td', {}, r.scope),
      ))
    : [el('tr', {}, el('td', { colspan: '4', class: 'hint' }, 'No permissions are requested.'))];

  return [
    section('Requested', {
      icon: I.shield, open: true,
      summary: `${rep.total} requested · ${rep.prompts} prompt at runtime`,
      children: [
        el('table', { class: 'ptable' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Permission'), el('th', {}, 'Why'), el('th', {}, 'Prompts'), el('th', {}, 'Scope'))),
          el('tbody', {}, ...rows)),
        el('p', { class: 'hint' }, 'Every row is traced to the capability that asked for it. Nothing is requested because it seemed useful.'),
      ],
    }),

    section('Deliberately not requested', {
      icon: I.list,
      summary: `${(derived.dropped || []).length} refused`,
      children: (derived.dropped || []).length
        ? [el('ul', { class: 'dropped' }, ...(derived.dropped || []).map((d) => el('li', {},
            el('code', {}, d.permission || d), ' — ', d.reason || 'no capability asked for it')))]
        : [el('p', { class: 'hint' }, 'Nothing was refused, which usually means more capabilities are enabled than the app needs.')],
    }),

    (derived.unknownCapabilities || []).length
      ? el('div', { class: 'banner warn' }, el('div', {}, [
          el('strong', {}, 'Capabilities nothing knows about. '),
          (derived.unknownCapabilities || []).join(', ') + ' are enabled but no permission rule matched them, so they will do nothing.',
        ]))
      : null,
  ];
}

function tabEngine(spec) {
  const b = spec.build || (spec.build = {});
  const tc = resolveToolchain(spec);
  const ALL_OUTPUTS = ['debug-apk', 'release-apk', 'signed-apk', 'aab'];
  const on = new Set(b.outputs || ['debug-apk']);

  const outputs = ALL_OUTPUTS.map((o) => el('label', { class: 'opt' }, [
    el('div', { class: 'txt' }, el('div', { class: 'name' }, o)),
    sw(on.has(o), `Output ${o}`, (e) => {
      const s = new Set(b.outputs || ['debug-apk']);
      if (e.target.checked) s.add(o); else s.delete(o);
      b.outputs = [...s];
      touch(); hardUpdate();
    }),
  ]));

  return [
    section('Engine', {
      icon: I.build, open: true,
      summary: `${b.engine || 'github-actions'} · ${(b.outputs || []).join(', ') || 'no outputs'}`,
      children: [
        choose('Build engine', 'Build engine', [
          ['github-actions', 'GitHub Actions'],
          ['local-termux', 'Local — Termux on the phone'],
          ['local-desktop', 'Local — desktop JDK'],
        ], b.engine || 'github-actions', (v) => { b.engine = v; touch(); hardUpdate(); },
          'GitHub Actions needs no local toolchain and is what the device test runs on.'),
        el('div', { class: 'optlist' }, ...outputs),
        field('Shrink and obfuscate (R8)', sw(b.r8, 'Shrink and obfuscate',
          (e) => { b.r8 = e.target.checked; touch(); hardUpdate(); }),
          'Smaller and harder to read, but it can break reflection. Test a shrunk build before releasing one.'),
        field('Minify resources', sw(b.minify, 'Minify resources',
          (e) => { b.minify = e.target.checked; touch(); hardUpdate(); })),
        field('Split by CPU architecture', sw(b.abiSplits, 'Split by CPU architecture',
          (e) => { b.abiSplits = e.target.checked; touch(); hardUpdate(); }),
          'Smaller downloads, more artifacts to manage.'),
        field('Cache the Gradle build', sw(b.cache, 'Cache the Gradle build',
          (e) => { b.cache = e.target.checked; touch(); hardUpdate(); }),
          'The device test reports what the cache saved on every run.'),
      ],
    }),

    section('Toolchain this resolves to', {
      icon: I.sliders,
      summary: `AGP ${tc.agp} · Gradle ${tc.gradle} · JDK ${tc.jdk} · SDK ${tc.compileSdk}`,
      children: [
        el('dl', { class: 'kv' },
          ...['agp', 'gradle', 'buildTools', 'jdk', 'compileSdk', 'profile'].flatMap((k) => (
            tc[k] === undefined ? [] : [el('dt', {}, k), el('dd', {}, String(tc[k]))]
          ))),
        el('p', { class: 'hint' },
          'Resolved by the same resolveToolchain() the build runs, so these are the versions that will be used and not a description of them.'),
      ],
    }),
  ];
}

function tabDiagnostics(spec) {
  const r = check();
  const layers = LAYERS.map((L) => {
    const found = (r.byLayer[L.n] && r.byLayer[L.n].issues) || [];
    const bad = found.filter((i) => i.severity === 'critical' || i.severity === 'error').length;
    return el('div', { class: 'layerline' }, [
      el('span', { class: bad ? 'chip fail' : (found.length ? 'chip warn' : 'chip pass') }, bad ? 'FAIL' : (found.length ? 'WARN' : 'PASS')),
      el('span', { class: 'nm' }, `Layer ${L.n} — ${L.name}`),
      el('span', { class: 'n' }, found.length ? say(found.length, 'finding') : ''),
    ]);
  });

  return [
    section('Validation', {
      icon: I.shield, open: true,
      summary: `${r.counts.critical} critical · ${r.counts.error} error · ${r.counts.warning} warning · ${r.counts.info} info`,
      children: [
        ...layers,
        r.issues.length
          ? el('ul', { class: 'diag' }, ...r.issues.map((i) => el('li', { class: `s-${i.severity}` },
              el('code', {}, i.code),
              el('span', { class: 'dpath' }, i.path || '(root)'),
              el('span', { class: 'dmsg' }, i.message),
            )))
          : el('p', { class: 'hint' }, 'Nothing to report. All five layers passed.'),
      ],
    }),

    section('This screen', {
      icon: I.eye,
      summary: 'what the Studio itself is doing',
      children: [
        el('dl', { class: 'kv' },
          el('dt', {}, 'Specification version'), el('dd', {}, String(spec.specVersion || '—')),
          el('dt', {}, 'Architecture'), el('dd', {}, String((spec.app || {}).mode || '—')),
          el('dt', {}, 'Capabilities'), el('dd', {}, String((spec.capabilities || []).length)),
          el('dt', {}, 'Screens'), el('dd', {}, String((spec.screens || []).length)),
          el('dt', {}, 'Build watcher'), el('dd', {}, S.pipeline.polling ? 'following a run' : 'idle')),
        el('p', { class: 'hint' },
          'The Studio runs the same validator, permission derivation and component list as the command line and CI. Nothing is forked, so this screen cannot disagree with a build.'),
      ],
    }),
  ];
}

/* ── advanced mode ──────────────────────────────────────────────────────── */

/** The manifest permission lines the generator will write, from the same
 *  derivation the build uses. This is derived, not a generated document. */
function manifestPermissions(spec) {
  const { permissions } = derivePermissions(spec);
  if (!permissions.length) return '<!-- no permissions -->';
  return permissions.map((p) => {
    const max = p.attrs && p.attrs.maxSdkVersion ? ` android:maxSdkVersion="${p.attrs.maxSdkVersion}"` : '';
    return `<uses-permission android:name="android.permission.${p.short}"${max} />`;
  }).join('\n');
}

function tabAdvanced(spec) {
  const tc = resolveToolchain(spec);
  const rep = permissionReport(spec);
  return [
    codeBlock('spec.json — the source everything is generated from',
      JSON.stringify(spec, null, 2),
      'This is the actual object the build reads. Edit it here and every screen follows; import it elsewhere and you get the same app.'),
    codeBlock('resolveToolchain(spec)', JSON.stringify(tc, null, 2),
      'The versions the build will resolve for this specification.'),
    codeBlock('permissions that will be written into AndroidManifest.xml', manifestPermissions(spec),
      'Derived by the same derivePermissions() the generator calls, so these are the lines that will be written and not an approximation of them.'),
    codeBlock('permissionReport(spec)', JSON.stringify(rep, null, 2), null),
    el('div', { class: 'banner info' }, el('div', {}, [
      el('strong', {}, 'Why there is no Gradle file here. '),
      'The generator that writes build.gradle imports node:fs and pulls in the native screen generator, so it cannot run in a page. An approximation of its output would look like the build without being it, so the source is shown instead — and the finished Gradle and manifest are in the build artifact, where they can be read as they really are.',
    ])),
  ];
}

/* ── the screen ─────────────────────────────────────────────────────────── */

function viewSettings() {
  const spec = S.active.spec;
  const st = S.settings || (S.settings = { tab: 'general', advanced: false });

  const tabs = el('div', { class: 'subtabs', role: 'tablist', 'aria-label': 'Settings sections' },
    ...SETTINGS_TABS.map(([id, label]) => el('button', {
      class: 'subtab' + (st.tab === id ? ' on' : ''),
      role: 'tab', type: 'button', 'aria-selected': st.tab === id ? 'true' : 'false',
      onclick: () => { st.tab = id; hardUpdate(); },
    }, label)));

  const adv = el('div', { class: 'advbar' },
    el('div', { class: 'advtext' },
      el('strong', {}, 'Advanced Mode'),
      el('span', {}, 'Unlocks the raw configuration: the specification as the build reads it, the resolved toolchain, and the permissions that will be written into the manifest.'),
    ),
    sw(st.advanced, 'Advanced Mode', (e) => { st.advanced = e.target.checked; hardUpdate(); }),
  );

  const panel = st.tab === 'general' ? tabGeneral(spec)
    : st.tab === 'backend' ? tabBackend(spec)
    : st.tab === 'signing' ? tabSigning(spec)
    : st.tab === 'permissions' ? tabPermissions(spec)
    : st.tab === 'engine' ? tabEngine(spec)
    : tabDiagnostics(spec);

  return [
    el('div', { class: 'settingshead' }, tabs, adv),
    ...panel,
    ...(st.advanced ? tabAdvanced(spec) : []),
  ];
}
