/**
 * COMPONENT LIBRARY
 * =================
 * The single definition of every building block a generated app can contain.
 *
 * This file is the authority for:
 *   - what properties each component has, and their types
 *   - which events each component can fire
 *   - which actions each event can run
 *   - what accessibility information each component must carry
 *   - how it behaves on a small vs large screen
 *
 * The Studio renders its designer and its live preview from this file, and the
 * Android generator emits code from it. One definition, so the editor and the
 * running app cannot disagree about what a component is.
 *
 * No AI, no dependencies. Deterministic.
 */

/* ------------------------------------------------------------------ *
 * ACTIONS — what an event can do.
 * Every action is deterministic and needs no code from the user.
 * ------------------------------------------------------------------ */
export const ACTIONS = {
  none:        { label: 'Do nothing',            props: {} },
  navigate:    { label: 'Go to another screen',  props: { screen: { type: 'screen', label: 'Screen', required: true } } },
  openUrl:     { label: 'Open a web address',    props: { url: { type: 'string', label: 'Address', required: true, placeholder: 'https://…' } } },
  share:       { label: 'Share text',            props: { text: { type: 'string', label: 'Text to share', required: true }, title: { type: 'string', label: 'Dialog title' } } },
  call:        { label: 'Call a number',         props: { number: { type: 'string', label: 'Phone number', required: true, placeholder: '+91…' } } },
  email:       { label: 'Send an email',         props: { to: { type: 'string', label: 'To', required: true }, subject: { type: 'string', label: 'Subject' } } },
  sms:         { label: 'Send a message',        props: { number: { type: 'string', label: 'Phone number', required: true }, body: { type: 'string', label: 'Message' } } },
  upi:         { label: 'Open a UPI payment',    props: { vpa: { type: 'string', label: 'UPI ID', required: true, placeholder: 'name@bank' }, name: { type: 'string', label: 'Payee name' }, amount: { type: 'string', label: 'Amount (₹)' }, note: { type: 'string', label: 'Note' } } },
  copy:        { label: 'Copy to clipboard',     props: { text: { type: 'string', label: 'Text', required: true } } },
  toast:       { label: 'Show a message',        props: { message: { type: 'string', label: 'Message', required: true } } },
  openApp:     { label: 'Open another app',      props: { url: { type: 'string', label: 'App link', required: true, placeholder: 'whatsapp://send?text=…' } } },
  openDrawer:  { label: 'Open the side menu',    props: {} },
  closeScreen: { label: 'Go back',               props: {} },
  scrollTo:    { label: 'Scroll to a section',   props: { target: { type: 'componentId', label: 'Target' } } },
  setTheme:    { label: 'Switch light/dark',     props: { mode: { type: 'choice', label: 'Mode', options: [['light', 'Light'], ['dark', 'Dark'], ['system', 'Follow device']] } } },
  download:    { label: 'Open a file link',      props: { url: { type: 'string', label: 'File address', required: true } } },
  // Deliberately absent: any action that launches an arbitrary Intent built from
  // a URL. That is the intent-redirection hole we refuse to reproduce.
};

/* ------------------------------------------------------------------ *
 * EVENTS — what each component can respond to.
 * ------------------------------------------------------------------ */
export const EVENTS = {
  onClick:     { label: 'When tapped' },
  onLongClick: { label: 'When held down' },
  onChange:    { label: 'When the value changes' },
  onSubmit:    { label: 'When submitted' },
  onLoad:      { label: 'When the screen opens' },
  onRefresh:   { label: 'When pulled down to refresh' },
  onScrollEnd: { label: 'When scrolled to the end' },
};

/* ------------------------------------------------------------------ *
 * COMPONENTS
 * ------------------------------------------------------------------ */

/** Shared property fragments, so they cannot drift between components. */
const P = {
  id: { type: 'string', label: 'Name', help: 'Used only inside this project' },
  text: { type: 'string', label: 'Text', required: true },
  color: { type: 'color', label: 'Colour' },
  size: { type: 'choice', label: 'Size', options: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large'], ['xl', 'Extra large']] },
  weight: { type: 'boolean', label: 'Bold' },
  align: { type: 'choice', label: 'Alignment', options: [['start', 'Left'], ['center', 'Centre'], ['end', 'Right']] },
  margin: { type: 'choice', label: 'Spacing around', options: [['none', 'None'], ['xs', 'Tight'], ['sm', 'Small'], ['md', 'Normal'], ['lg', 'Large']] },
  padding: { type: 'choice', label: 'Spacing inside', options: [['none', 'None'], ['sm', 'Small'], ['md', 'Normal'], ['lg', 'Large']] },
  visible: { type: 'boolean', label: 'Visible', default: true },
  a11yLabel: { type: 'string', label: 'Screen-reader label', help: 'Describe this for someone who cannot see it. Required when the component has no visible text.' },
  responsive: { type: 'boolean', label: 'Improve on larger screens', help: 'Centres the content and caps its width so it does not stretch on a tablet.' },
};

export const COMPONENTS = {
  /* ── layout ─────────────────────────────────────────────────────── */
  Screen: {
    label: 'Screen', group: 'Layout', container: true, single: true,
    props: {
      title: { type: 'string', label: 'Screen title' },
      backgroundColor: { type: 'color', label: 'Background' },
      scroll: { type: 'boolean', label: 'Allow scrolling', default: true },
      safeArea: { type: 'boolean', label: 'Keep clear of notches', default: true },
    },
    a11y: { role: 'none' },
  },
  Container: {
    label: 'Group', group: 'Layout', container: true,
    props: {
      direction: { type: 'choice', label: 'Arrange', options: [['column', 'Stacked'], ['row', 'Side by side']], default: 'column' },
      gap: { type: 'choice', label: 'Gap between children', options: [['none', 'None'], ['sm', 'Small'], ['md', 'Normal'], ['lg', 'Large']], default: 'md' },
      ...pick(P, 'padding', 'margin', 'backgroundColor'),
      backgroundColor: { type: 'color', label: 'Background' },
      visible: P.visible, responsive: P.responsive,
    },
    a11y: { role: 'none' },
  },
  Card: {
    label: 'Card', group: 'Layout', container: true,
    props: {
      elevated: { type: 'boolean', label: 'Raised shadow', default: true },
      radius: { type: 'choice', label: 'Corner roundness', options: [['none', 'Square'], ['sm', 'Slight'], ['md', 'Normal'], ['lg', 'Round'], ['pill', 'Very round']], default: 'md' },
      ...pick(P, 'padding', 'margin'),
      visible: P.visible, responsive: P.responsive,
    },
    a11y: { role: 'none' },
  },
  Divider: {
    label: 'Divider', group: 'Layout',
    props: { thickness: { type: 'choice', label: 'Thickness', options: [['hairline', 'Hairline'], ['sm', 'Thin'], ['md', 'Thick']], default: 'hairline' }, margin: P.margin, visible: P.visible },
    a11y: { role: 'separator' },
  },
  Spacer: {
    label: 'Space', group: 'Layout',
    props: { height: { type: 'choice', label: 'Height', options: [['xs', 'Tight'], ['sm', 'Small'], ['md', 'Normal'], ['lg', 'Large'], ['xl', 'Huge']], default: 'md' } },
    a11y: { role: 'none' },
  },

  /* ── text ───────────────────────────────────────────────────────── */
  Text: {
    label: 'Text', group: 'Text',
    props: { text: P.text, size: { ...P.size, default: 'md' }, weight: P.weight, color: P.color, align: P.align, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'text' },
  },
  Heading: {
    label: 'Heading', group: 'Text',
    props: { text: P.text, size: { type: 'choice', label: 'Size', options: [['lg', 'Large'], ['xl', 'Extra large'], ['2xl', 'Page title']], default: 'xl' }, color: P.color, align: P.align, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'heading' },
  },
  Badge: {
    label: 'Badge', group: 'Text',
    props: { text: P.text, tone: { type: 'choice', label: 'Tone', options: [['neutral', 'Neutral'], ['info', 'Info'], ['success', 'Success'], ['warning', 'Warning'], ['danger', 'Danger']], default: 'neutral' }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'status' },
  },
  Chip: {
    label: 'Chip', group: 'Text',
    props: { text: P.text, selected: { type: 'boolean', label: 'Selected', default: false }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'button' },
    events: ['onClick'],
  },

  /* ── media ──────────────────────────────────────────────────────── */
  Image: {
    label: 'Image', group: 'Media',
    props: {
      source: { type: 'string', label: 'Image address', placeholder: 'https://… or a bundled file', required: true },
      height: { type: 'choice', label: 'Height', options: [['xs', 'Tiny'], ['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large'], ['xl', 'Full screen']], default: 'md' },
      fit: { type: 'choice', label: 'Fitting', options: [['cover', 'Fill the frame'], ['contain', 'Fit inside']], default: 'cover' },
      radius: { type: 'choice', label: 'Corner roundness', options: [['none', 'Square'], ['sm', 'Slight'], ['md', 'Normal'], ['pill', 'Circle']], default: 'sm' },
      margin: P.margin, visible: P.visible,
      a11yLabel: { ...P.a11yLabel, required: true, help: 'Required: describe the image for someone who cannot see it. Android and Play both expect this.' },
    },
    a11y: { role: 'image', requiresLabel: true },
  },
  Avatar: {
    label: 'Avatar', group: 'Media',
    props: { source: { type: 'string', label: 'Image address', placeholder: 'https://…' }, fallback: { type: 'string', label: 'Initials if no image', placeholder: 'AB' }, size: { type: 'choice', label: 'Size', options: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']], default: 'md' }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'image' },
  },
  Progress: {
    label: 'Progress bar', group: 'Media',
    props: { value: { type: 'number', label: 'Value (0–100)', min: 0, max: 100, default: 40 }, showLabel: { type: 'boolean', label: 'Show the percentage', default: false }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'progressbar' },
  },
  Loading: {
    label: 'Loading spinner', group: 'Media',
    props: { size: { type: 'choice', label: 'Size', options: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']], default: 'md' }, label: { type: 'string', label: 'Label beside it', default: 'Loading…' }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'progressbar' },
  },

  /* ── inputs ─────────────────────────────────────────────────────── */
  Button: {
    label: 'Button', group: 'Input',
    props: {
      text: P.text,
      style: { type: 'choice', label: 'Style', options: [['primary', 'Filled'], ['ghost', 'Outlined'], ['text', 'Text only'], ['danger', 'Destructive']], default: 'primary' },
      size: { ...P.size, default: 'md' }, fullWidth: { type: 'boolean', label: 'Full width', default: true },
      icon: { type: 'icon', label: 'Icon' },
      disabled: { type: 'boolean', label: 'Disabled', default: false },
      margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel,
    },
    a11y: { role: 'button' },
    events: ['onClick', 'onLongClick'],
  },
  IconButton: {
    label: 'Icon button', group: 'Input',
    props: { icon: { type: 'icon', label: 'Icon', required: true }, size: { type: 'choice', label: 'Size', options: [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']], default: 'md' }, margin: P.margin, visible: P.visible, a11yLabel: { ...P.a11yLabel, required: true } },
    a11y: { role: 'button', requiresLabel: true },
    events: ['onClick'],
  },
  Input: {
    label: 'Text field', group: 'Input',
    props: {
      label: { type: 'string', label: 'Label' }, placeholder: { type: 'string', label: 'Placeholder' },
      inputType: { type: 'choice', label: 'Keyboard', options: [['text', 'Text'], ['number', 'Numbers'], ['phone', 'Phone'], ['email', 'Email'], ['multiline', 'Multiple lines']], default: 'text' },
      required: { type: 'boolean', label: 'Must be filled in', default: false },
      maxLength: { type: 'number', label: 'Maximum characters', min: 1, max: 5000 },
      helper: { type: 'string', label: 'Helper text below' },
      margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel,
    },
    a11y: { role: 'textfield' },
    events: ['onChange', 'onSubmit'],
  },
  PasswordInput: {
    label: 'Password field', group: 'Input',
    props: { label: { type: 'string', label: 'Label' }, placeholder: { type: 'string', label: 'Placeholder' }, minLength: { type: 'number', label: 'Minimum length', min: 1, max: 128, default: 8 }, helper: { type: 'string', label: 'Helper text below' }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'textfield', secure: true },
    events: ['onChange', 'onSubmit'],
  },
  Search: {
    label: 'Search box', group: 'Input',
    props: { placeholder: { type: 'string', label: 'Placeholder', default: 'Search' }, action: { type: 'action', label: 'When searched', event: 'onSubmit' }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'search' },
    events: ['onChange', 'onSubmit'],
  },
  Dropdown: {
    label: 'Dropdown', group: 'Input',
    props: { label: { type: 'string', label: 'Label' }, options: { type: 'list', label: 'Options', help: 'One option per line' }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'combobox' },
    events: ['onChange'],
  },
  Checkbox: {
    label: 'Checkbox', group: 'Input',
    props: { text: P.text, checked: { type: 'boolean', label: 'Checked by default', default: false }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'checkbox' },
    events: ['onChange'],
  },
  Switch: {
    label: 'Switch', group: 'Input',
    props: { text: P.text, checked: { type: 'boolean', label: 'On by default', default: false }, subtitle: { type: 'string', label: 'Description below' }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'switch' },
    events: ['onChange'],
  },
  Slider: {
    label: 'Slider', group: 'Input',
    props: { label: { type: 'string', label: 'Label' }, min: { type: 'number', label: 'Minimum', default: 0 }, max: { type: 'number', label: 'Maximum', default: 100 }, value: { type: 'number', label: 'Starting value', default: 50 }, step: { type: 'number', label: 'Step', default: 1 }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'slider' },
    events: ['onChange'],
  },
  Form: {
    label: 'Form', group: 'Input', container: true,
    props: { submitLabel: { type: 'string', label: 'Submit button label', default: 'Submit' }, validate: { type: 'boolean', label: 'Check the fields before submitting', default: true }, action: { type: 'action', label: 'When submitted', event: 'onSubmit' }, padding: P.padding, margin: P.margin, visible: P.visible },
    a11y: { role: 'form' },
    events: ['onSubmit'],
  },

  /* ── collections ────────────────────────────────────────────────── */
  List: {
    label: 'List', group: 'Collection', container: true,
    props: {
      source: { type: 'choice', label: 'Items come from', options: [['static', 'A fixed list I type'], ['remote', 'A web address returning JSON']], default: 'static' },
      items: { type: 'list', label: 'Items', help: 'One item per line' },
      url: { type: 'string', label: 'JSON address', placeholder: 'https://…/items.json' },
      itemTemplate: { type: 'choice', label: 'Each item shows', options: [['title', 'Title only'], ['titleSubtitle', 'Title and subtitle'], ['titleImage', 'Title and image'], ['card', 'A card']], default: 'titleSubtitle' },
      dividers: { type: 'boolean', label: 'Lines between items', default: true },
      margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel,
    },
    a11y: { role: 'list' },
    events: ['onClick', 'onScrollEnd', 'onRefresh'],
  },
  Grid: {
    label: 'Grid', group: 'Collection', container: true,
    props: { columns: { type: 'choice', label: 'Columns', options: [['2', 'Two'], ['3', 'Three'], ['4', 'Four']], default: '2' }, items: { type: 'list', label: 'Items', help: 'One item per line' }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'list' },
    events: ['onClick'],
  },
  Tabs: {
    label: 'Tabs', group: 'Collection',
    props: { tabs: { type: 'list', label: 'Tab names', help: 'One per line' }, margin: P.margin, visible: P.visible, a11yLabel: P.a11yLabel },
    a11y: { role: 'tablist' },
    events: ['onClick'],
  },

  /* ── navigation & structure ─────────────────────────────────────── */
  AppBar: {
    label: 'Top bar', group: 'Navigation',
    props: { title: { type: 'string', label: 'Title' }, showBack: { type: 'boolean', label: 'Show a back arrow', default: false }, showMenu: { type: 'boolean', label: 'Show the side-menu button', default: false }, menuIcon: { type: 'icon', label: 'Side-menu icon' }, actionIcon: { type: 'icon', label: 'Action icon' }, action: { type: 'action', label: 'When the action is tapped', event: 'onClick' }, visible: P.visible },
    a11y: { role: 'toolbar' },
    events: ['onClick'],
  },
  BottomNavigation: {
    label: 'Bottom navigation', group: 'Navigation',
    props: {
      items: { type: 'list', label: 'Items', help: 'One per line, as "Icon: Label"' },
      targets: { type: 'list', label: 'Screens', help: 'One screen name per line, in the same order as the items' },
      activeIndex: { type: 'number', label: 'Highlighted item', min: 0, max: 6, default: 0 },
      visible: P.visible,
    },
    a11y: { role: 'tablist' },
    events: ['onClick'],
  },
  Drawer: {
    label: 'Side menu', group: 'Navigation', container: true,
    props: { title: { type: 'string', label: 'Header title' }, subtitle: { type: 'string', label: 'Header subtitle' }, width: { type: 'choice', label: 'Width', options: [['sm', 'Narrow'], ['md', 'Normal'], ['lg', 'Wide']], default: 'md' }, visible: P.visible },
    a11y: { role: 'navigation' },
  },
  Dialog: {
    label: 'Dialog', group: 'Navigation', container: true,
    props: { title: { type: 'string', label: 'Title' }, message: { type: 'string', label: 'Message', type2: 'text' }, confirmLabel: { type: 'string', label: 'Confirm button', default: 'OK' }, cancelLabel: { type: 'string', label: 'Cancel button' }, action: { type: 'action', label: 'When confirmed', event: 'onSubmit' }, visible: P.visible },
    a11y: { role: 'dialog' },
    events: ['onSubmit'],
  },
  BottomSheet: {
    label: 'Bottom sheet', group: 'Navigation', container: true,
    props: { title: { type: 'string', label: 'Title' }, swipeToClose: { type: 'boolean', label: 'Close by swiping down', default: true }, visible: P.visible },
    a11y: { role: 'dialog' },
  },
  FloatingButton: {
    label: 'Floating button', group: 'Navigation',
    props: { icon: { type: 'icon', label: 'Icon', required: true }, label: { type: 'string', label: 'Label' }, visible: P.visible, a11yLabel: { ...P.a11yLabel, required: true } },
    a11y: { role: 'button', requiresLabel: true },
    events: ['onClick'],
  },
};

function pick(obj, ...keys) {
  const out = {};
  for (const k of keys) if (obj[k]) out[k] = obj[k];
  return out;
}

/* ------------------------------------------------------------------ *
 * VALIDATION of a screen tree
 * ------------------------------------------------------------------ */
const MAX_DEPTH = 12;

/**
 * The value of a property, wherever it is allowed to be written.
 *
 * `a11yLabel` is the one property that may sit on the component itself or among
 * its props, because the editor treats it as belonging to the component rather
 * than to its appearance. Both places reach the generated app, so validation
 * has to look in both — otherwise a label that works is reported as missing.
 */
export function effectiveProp(node, key) {
  if (!node) return undefined;
  if (key === 'a11yLabel') return node.a11yLabel ?? node.props?.a11yLabel;
  return node.props?.[key];
}

/**
 * Walk a screen's component tree and report every problem.
 * @returns {Array<issue>} issues with a precise path so the Studio can point at
 *          the exact component.
 */
export function validateScreens(spec, out) {
  const screens = spec.screens || [];
  const nav = spec.navigation || {};

  // Unique screen ids
  const seen = new Set();
  for (const [i, s] of screens.entries()) {
    if (!s || typeof s !== 'object') { out.push(p('E_SCREEN_SHAPE', 'error', `screens[${i}]`, 'This screen is not a valid screen.')); continue; }
    if (!s.id) { out.push(p('E_SCREEN_ID', 'error', `screens[${i}].id`, 'This screen has no id.')); continue; }
    if (seen.has(s.id)) out.push(p('E_SCREEN_DUP', 'error', `screens[${i}].id`, `Two screens are both called "${s.id}".`));
    seen.add(s.id);
    if (!s.name) out.push(p('W_SCREEN_NAME', 'warning', `screens[${i}].name`, `Screen "${s.id}" has no display name.`));
  }

  if (screens.length > 0 && nav.type === 'none')
    out.push(p('W_NAV_MISSING', 'warning', 'navigation.type',
      `This app has ${screens.length} screen${screens.length === 1 ? '' : 's'} but no navigation, so there is no way to reach any of them.`,
      { fix: { kind: 'set', path: 'navigation.type', value: screens.length > 1 ? 'bottom-tabs' : 'stack' } }));

  if (nav.type === 'bottom-tabs') {
    const tabs = screens.filter((s) => s && s.showInTabs !== false);
    if (tabs.length < 2) out.push(p('W_TABS_THIN', 'warning', 'navigation.type', 'Bottom tabs with fewer than two screens leaves empty tabs.'));
    if (tabs.length > 5) out.push(p('E_TABS_MANY', 'error', 'navigation.type', `Bottom tabs support at most 5 items; ${tabs.length} screens are marked to appear there.`));
  }

  const screenIds = new Set(screens.map((s) => s && s.id).filter(Boolean));
  const componentIds = new Set(); // across the whole app, for the warning below
  const perScreenIds = new Map(); // screen id -> ids seen in that screen
  const usedCapabilities = new Set();

  for (const [si, screen] of screens.entries()) {
    if (!screen || !Array.isArray(screen.components)) continue;
    walk(screen.components, `screens[${si}].components`, 1);
  }

  function walk(nodes, basePath, depth) {
    if (depth > MAX_DEPTH) {
      out.push(p('E_NESTING', 'error', basePath, `This is nested more than ${MAX_DEPTH} levels deep. Such a layout is almost impossible to work with on a phone screen.`));
      return;
    }
    for (const [ci, node] of nodes.entries()) {
      const path = `${basePath}[${ci}]`;
      if (!node || typeof node !== 'object') { out.push(p('E_NODE', 'error', path, 'This component is not valid.')); continue; }

      const def = COMPONENTS[node.type];
      if (!def) {
        const near = nearComponents(node.type);
        out.push(p('E_UNKNOWN_COMPONENT', 'error', `${path}.type`,
          `"${node.type}" is not a component that exists.` + (near.length ? ` Did you mean ${near.map((n) => `"${n}"`).join(' or ')}?` : ''),
          { options: near, fix: near.length ? { kind: 'set', path: `${path}.type`, value: near[0], label: `Use ${near[0]}` } : undefined }));
        continue;
      }

      if (node.id) {
        const screenId = screenOf(path, screens) || '?';
        let inScreen = perScreenIds.get(screenId);
        if (!inScreen) { inScreen = new Set(); perScreenIds.set(screenId, inScreen); }
        if (inScreen.has(node.id)) {
          out.push(p('E_COMP_DUP_ID', 'error', `${path}.id`,
            `Two components in this screen are both called "${node.id}". The app keeps one view per name, so the second would silently take over the first one's behaviour.`,
            { reveal: { screen: screenId, nodeId: node.id }, fix: { kind: 'set', path: `${path}.id`, value: `${node.id}2` } }));
        } else if (componentIds.has(node.id)) {
          out.push(p('W_COMP_DUP_ID', 'warning', `${path}.id`,
            `A component in another screen is also called "${node.id}". This is allowed, but a distinct name will make the reports easier to follow.`));
        }
        inScreen.add(node.id);
        componentIds.add(node.id);
      }

      // Required properties
      for (const [key, propDef] of Object.entries(def.props || {})) {
        const value = effectiveProp(node, key);
        if (propDef.required && (value === undefined || value === null || value === ''))
          out.push(p('E_PROP_REQUIRED', 'error', `${path}.props.${key}`, `${def.label}: "${propDef.label}" must be filled in.`, { reveal: { screen: screenOf(path, screens), nodeId: node.id } }));
      }

      // Colour values must be real colours
      for (const [key, propDef] of Object.entries(def.props || {})) {
        if (propDef.type !== 'color') continue;
        const v = (node.props || {})[key];
        if (v && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(String(v)))
          out.push(p('E_PROP_COLOR', 'error', `${path}.props.${key}`, `"${v}" is not a colour. Use a value like #2563EB.`));
      }

      // Number ranges
      for (const [key, propDef] of Object.entries(def.props || {})) {
        if (propDef.type !== 'number') continue;
        const v = effectiveProp(node, key);
        if (v === undefined || v === '') continue;
        const n = Number(v);
        if (!Number.isFinite(n)) { out.push(p('E_PROP_NUMBER', 'error', `${path}.props.${key}`, `"${v}" is not a number.`)); continue; }
        if (propDef.min != null && n < propDef.min) out.push(p('E_PROP_RANGE', 'error', `${path}.props.${key}`, `${n} is below the minimum of ${propDef.min}.`));
        if (propDef.max != null && n > propDef.max) out.push(p('E_PROP_RANGE', 'error', `${path}.props.${key}`, `${n} is above the maximum of ${propDef.max}.`));
      }

      // Accessibility: an image with no label is a real defect, not a nitpick.
      if (def.a11y?.requiresLabel && !(node.a11yLabel || node.props?.a11yLabel))
        out.push(p('E_A11Y_IMAGE', 'error', `${path}.props.a11yLabel`,
          `${def.label}: describe this for someone using a screen reader. Android and Google Play both expect images to carry a description.`,
          { reveal: { screen: screenOf(path, screens), nodeId: node.id } }));

      // Events and their actions
      const events = def.events || [];
      for (const [ev, action] of Object.entries(node.events || {})) {
        if (!EVENTS[ev]) { out.push(p('W_UNKNOWN_EVENT', 'warning', `${path}.events.${ev}`, `"${ev}" is not something ${def.label} can do.`)); continue; }
        if (!events.includes(ev)) { out.push(p('W_EVENT_UNSUPPORTED', 'warning', `${path}.events.${ev}`, `${def.label} cannot respond to "${ev}".`)); continue; }
        if (!action || action.kind === 'none' || !action.kind) continue;
        const aDef = ACTIONS[action.kind];
        if (!aDef) { out.push(p('E_UNKNOWN_ACTION', 'error', `${path}.events.${ev}.kind`, `"${action.kind}" is not an action that exists.`)); continue; }
        for (const [key, pd] of Object.entries(aDef.props || {})) {
          const v = (action.props || {})[key];
          if (pd.required && (v === undefined || v === null || v === ''))
            out.push(p('E_ACTION_PROP', 'error', `${path}.events.${ev}.props.${key}`, `${def.label} → ${aDef.label}: "${pd.label}" must be filled in.`));
        }
        // Navigation targets must exist
        if (action.kind === 'navigate' && action.props?.screen && !screenIds.has(action.props.screen))
          out.push(p('E_NAV_TARGET', 'error', `${path}.events.${ev}.props.screen`, `No screen is called "${action.props.screen}".`));

        // Capability implications — the engine tells you when a screen needs a
        // capability you have not enabled, instead of failing at runtime.
        const caps = (spec.capabilities || []);
        if (action.kind === 'share' && !caps.includes('share')) usedCapabilities.add('share');
        if (action.kind === 'copy' && !caps.includes('clipboard')) usedCapabilities.add('clipboard');
        if (action.kind === 'upi' && !caps.includes('upi')) usedCapabilities.add('upi');
        if (action.kind === 'call' && !caps.includes('telephone')) usedCapabilities.add('telephone');
        if (action.kind === 'email' && !caps.includes('email')) usedCapabilities.add('email');
        if (action.kind === 'openApp' && !caps.includes('deepLinks')) usedCapabilities.add('deepLinks');
      }

      // Container rules
      if (def.container && !Array.isArray(node.children)) node.children = [];
      if (!def.container && Array.isArray(node.children) && node.children.length)
        out.push(p('E_NOT_CONTAINER', 'error', `${path}.children`, `${def.label} cannot contain other components. Put it inside a Group instead.`));
      if (Array.isArray(node.children)) walk(node.children, `${path}.children`, depth + 1);
    }
  }

  for (const cap of usedCapabilities)
    out.push(p('W_ACTION_NEEDS_CAP', 'warning', 'capabilities',
      `A screen uses the "${cap}" action but that capability is not enabled, so the button would do nothing.`,
      { fix: { kind: 'addArrayItem', path: 'capabilities', value: cap } }));
}

function screenOf(path, screens) {
  const m = /^screens\[(\d+)\]/.exec(path);
  if (!m) return null;
  const s = screens[Number(m[1])];
  return s ? s.id : null;
}

let CODE_N = 0;
function p(code, severity, path, message, extra = {}) {
  return { id: `${code}-${++CODE_N}`, code, severity, path, message, ...extra };
}

/* ------------------------------------------------------------------ *
 * ONE SOURCE OF TRUTH FOR BOOLEAN DEFAULTS
 *
 * The renderer has a fallback for every boolean it reads, and the editor needs
 * a starting value for every switch it draws. If these disagree the preview and
 * the app differ, which is the worst possible failure in a design tool. Rather
 * than trusting that two lists stay in step, this fills in the value the
 * renderer already uses, and a test checks the two against each other.
 * ------------------------------------------------------------------ */
for (const def of Object.values(COMPONENTS)) {
  for (const prop of Object.values(def.props || {})) {
    if (prop.type === 'boolean' && !('default' in prop)) prop.default = false;
  }
  // The walk already treats a missing flag as "cannot hold children". Saying so
  // explicitly means the editor's drop target and the validator agree without
  // either having to guess.
  if (!('container' in def)) def.container = false;
  if (!('a11y' in def)) def.a11y = { role: 'none' };
}

/* ------------------------------------------------------------------ *
 * PALETTE HELPERS
 *
 * The Studio draws its component palette from these, so the editor and the
 * generator read one definition. Adding a component to COMPONENTS above makes
 * it appear in the editor, validate the same way, and generate the same code,
 * with nothing else to update.
 * ------------------------------------------------------------------ */

/** The groups, in the order they should be shown. */
export const GROUPS = (() => {
  const order = [];
  for (const def of Object.values(COMPONENTS)) if (!order.includes(def.group)) order.push(def.group);
  return order;
})();

/** True when this component must carry a screen-reader label. */
export function needsLabel(name) {
  return Boolean(COMPONENTS[name]?.a11y?.requiresLabel);
}

/**
 * Every component as a flat list, in a fixed order (definition order, grouped).
 * Deterministic: the palette never reshuffles between page loads.
 */
export function componentList() {
  return GROUPS.flatMap((group) => Object.entries(COMPONENTS)
    .filter(([, def]) => def.group === group)
    .map(([name, def]) => ({
      name,
      label: def.label || name,
      group,
      container: Boolean(def.container),
      single: Boolean(def.single),
      requiresLabel: Boolean(def.a11y?.requiresLabel),
      role: def.a11y?.role || 'none',
      props: def.props || {},
      events: def.events || [],
      actions: def.actions || [],
      help: def.help || null,
    })));
}

/** One component by name, or null. */
export function findComponent(name) {
  const def = COMPONENTS[name];
  if (!def) return null;
  return componentList().find((c) => c.name === name) || { name, ...def };
}

/**
 * A short list of real components closest to a mistyped name.
 * Tolerates the ways people actually mistype: a prefix, a typo, or the
 * consonants only ("btn" for Button).
 */
export function nearComponents(name, limit = 3) {
  const target = String(name || '').toLowerCase();
  if (!target) return [];
  const scored = [];
  for (const c of componentList()) {
    const cand = c.name.toLowerCase();
    let score = 0;
    if (cand === target) {
      score = 100;
    } else {
      // a typo, a missing letter or two letters swapped
      const d = editDistance(target, cand, 3);
      if (d <= 2) score = 80 - d * 10;
      else if (cand.startsWith(target)) score = 60;
      else if (cand.includes(target)) score = 40;
      else if (isSubsequence(target, cand)) {
        // "btn" is a subsequence of both Button and BottomNavigation. The one
        // it fills more of is the one the person meant.
        score = 20 + Math.round((target.length / cand.length) * 15);
      } else if (commonPrefix(target, cand) >= 3) score = 15;
    }
    if (score > 0) scored.push([score, cand.length, c.name]);
  }
  // highest score, then the shorter name, then alphabetical — a typo of a short
  // name is far more likely than a typo of a long one
  scored.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2].localeCompare(b[2]));
  return scored.slice(0, limit).map(([, , n]) => n);
}

/**
 * Edit distance, stopping as soon as it is clear the answer is above `max`.
 * The bound is what makes this cheap enough to run over the whole library for
 * every unknown component.
 */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // a transposition counts as one mistake, which is how people type
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], (prev[j - 2] ?? 99) + 1);
      }
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function isSubsequence(needle, hay) {
  let i = 0;
  for (const ch of hay) { if (ch === needle[i]) i++; if (i === needle.length) return needle.length >= 2; }
  return needle.length === 0;
}

/**
 * The closest real component to a name someone typed.
 * Used to turn "unknown component" into a useful suggestion instead of a wall.
 */
export function suggestComponent(name) {
  return nearComponents(name, 1)[0] || null;
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
