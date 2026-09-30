/**
 * NATIVE SCREEN GENERATOR
 * =======================
 * Turns a screen's component tree into a real Android view hierarchy.
 *
 * Design decision worth stating: the screens are emitted as DATA (a JSON asset)
 * plus ONE renderer that knows the component set. The alternative — generating a
 * bespoke Java file per screen — produces far more code, far more places for a
 * generation bug to hide, and it makes custom code impossible to reason about.
 *
 * The renderer is a known, finite set of components, so a data-driven approach is
 * both smaller and easier to prove correct. It also means the Studio's preview
 * and the running app read the same component tree.
 *
 * Accessibility is not optional here: every generated view gets a content
 * description, and decorative layout nodes are explicitly marked so a screen
 * reader does not announce empty containers.
 */

import { COMPONENTS, ACTIONS } from '../components/library.mjs';

import { SPACINGS, TEXT_SIZES, RADII, HEIGHTS, ICON_GLYPHS, ICON_FALLBACK, javaEscape } from '../components/scales.mjs';

/* Aliased to the local names the Java templates below interpolate. The tables
   themselves live in engine/components/scales.mjs, which the Studio preview
   reads as well, so a preview and a real screen cannot disagree. */
const spacings = SPACINGS;
const textSizes = TEXT_SIZES;
const radii = RADII;
const heights = HEIGHTS;


/**
 * Java will not compile a file that names a type it does not import, and the
 * ones this generator uses are easy to forget one at a time. Rather than
 * chasing them, the generator makes its own files consistent before returning
 * them: if a Java file mentions a type from org.json, the import is added.
 *
 * This is deliberately narrow. It handles the fixed set of types below and
 * nothing else, so it can never rewrite a file in a way nobody expected.
 */
const JAVA_IMPORTS = [
  ['JSONException', 'import org.json.JSONException;'],
  ['JSONObject', 'import org.json.JSONObject;'],
  ['JSONArray', 'import org.json.JSONArray;'],
];

function ensureJavaImports(files) {
  for (const f of files) {
    if (!/\.java$/.test(f.path)) continue;
    let src = typeof f.data === 'string' ? f.data : new TextDecoder().decode(f.data);
    if (/import\s+org\.json\.\*;/.test(src)) continue;
    const pkg = /^package\s+[\w.]+;/m.exec(src);
    if (!pkg) continue;
    const needed = JAVA_IMPORTS.filter(([type, imp]) => new RegExp(`\\b${type}\\b`).test(src) && !src.includes(imp));
    if (!needed.length) continue;
    // place it after the imports that are already there, so the block stays
    // in one piece
    const at = (() => {
      let idx = -1; let m;
      const re = /^import\s+[\w.*]+;\s*$/gm;
      while ((m = re.exec(src))) idx = m.index + m[0].length;
      return idx === -1 ? pkg.index + pkg[0].length : idx;
    })();
    f.data = src.slice(0, at) + '\n' + needed.map(([, imp]) => imp).join('\n') + src.slice(at);
  }
  return files;
}

/**
 * Emit one of the scale tables above as Java.
 * The renderer needs these numbers, and writing them out by hand in a second
 * language is how a preview and a real screen drift apart. They are generated
 * from the table that is right here, so they cannot disagree.
 */
function javaScaleMap(name, table, boxed) {
  const suffix = boxed === 'Float' ? 'f' : '';
  return [
    `private static final Map<String, ${boxed}> ${name} = new HashMap<>();`,
    'static {',
    ...Object.entries(table).map(([k, v]) => `    ${name}.put("${k}", ${v}${suffix});`),
    '}',
  ].join('\n    ');
}
const iconSizes = { sm: 18, md: 24, lg: 32 };

/**
 * @param {object} spec validated specification
 * @returns {{ok:boolean, errors:string[], files:Array<{path:string,data}>}}
 */
export function generateNativeScreens(spec) {
  const screens = spec.screens || [];
  if (screens.length === 0) return { ok: true, errors: [], files: [] };

  const pkg = spec.identity.packageName;
  const p = pkg.replace(/\./g, '/');
  const caps = spec.capabilities || [];
  const files = [];

  // The screen data travels inside the APK as an asset. It is plain data, so
  // there is nothing to execute and nothing to escape.
  const data = {
    version: '1.0',
    screens: screens.map((s) => ({
      id: s.id,
      name: s.name || s.id,
      title: s.title || s.name || s.id,
      showInTabs: s.showInTabs !== false,
      tabIcon: s.tabIcon || null,
      components: (s.components || []).map(serialiseNode),
    })),
  };
  files.push({
    path: 'android/app/src/main/assets/screens.json',
    data: JSON.stringify(data, null, 2) + '\n',
  });

  files.push({ path: `android/app/src/main/java/${p}/ScreenRenderer.java`, data: rendererJava(pkg) });
  files.push({ path: `android/app/src/main/java/${p}/Actions.java`, data: actionsJava(pkg, caps) });
  files.push({ path: `android/app/src/main/java/${p}/NativeActivity.java`, data: nativeActivityJava(pkg, spec, data) });
  files.push({ path: `android/app/src/main/java/${p}/Screens.java`, data: screensModelJava(pkg) });

  return { ok: true, errors: [], files: ensureJavaImports(files) };
}

function serialiseNode(node) {
  const def = COMPONENTS[node.type] || {};
  const out = {
    type: node.type,
    id: node.id || null,
    props: { ...(node.props || {}) },
    a11yLabel: node.a11yLabel || node.props?.a11yLabel || null,
  };
  if (def.container && Array.isArray(node.children) && node.children.length) {
    out.children = node.children.map(serialiseNode);
  }
  // Only the events the component actually supports are carried through, so the
  // running app can never be asked to handle something it has no code for.
  const supported = def.events || [];
  const events = {};
  for (const [k, v] of Object.entries(node.events || {})) {
    if (supported.includes(k) && v && v.kind && v.kind !== 'none') events[k] = v;
  }
  if (Object.keys(events).length) out.events = events;
  return out;
}

/* ==================================================================== *
 * Screens.java — plain model, parsed once
 * ==================================================================== */
function screensModelJava(pkg) {
  return `package ${pkg};

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Generated by Project1 Studio.
 * The screens are data, read once from the APK's own assets.
 */
public final class Screens {

    public static final class Node {
        public String type;
        public String id;
        public JSONObject props;
        public String a11yLabel;
        public final List<Node> children = new ArrayList<>();
        public final List<String> eventNames = new ArrayList<>();
        public final List<JSONObject> eventActions = new ArrayList<>();

        public String prop(String key, String fallback) {
            if (props == null) return fallback;
            String v = props.optString(key, null);
            return (v == null || v.isEmpty()) ? fallback : v;
        }

        public boolean flag(String key, boolean fallback) {
            return props == null ? fallback : props.optBoolean(key, fallback);
        }

        public int intProp(String key, int fallback) {
            return props == null ? fallback : props.optInt(key, fallback);
        }
    }

    public static final class Screen {
        public String id;
        public String name;
        public String title;
        public boolean showInTabs;
        public String tabIcon;
        public final List<Node> roots = new ArrayList<>();
    }

    private static List<Screen> CACHE;

    public static synchronized List<Screen> all(Context ctx) {
        if (CACHE != null) return CACHE;
        CACHE = parse(ctx);
        return CACHE;
    }

    public static Screen byId(Context ctx, String id) {
        for (Screen s : all(ctx)) if (s.id.equals(id)) return s;
        List<Screen> list = all(ctx);
        return list.isEmpty() ? null : list.get(0);
    }

    private static List<Screen> parse(Context ctx) {
        List<Screen> out = new ArrayList<>();
        try (InputStream in = ctx.getAssets().open("screens.json")) {
            byte[] buf = new byte[in.available()];
            int read = in.read(buf);
            String json = new String(buf, 0, Math.max(read, 0), StandardCharsets.UTF_8);
            JSONObject root = new JSONObject(json);
            JSONArray arr = root.optJSONArray("screens");
            if (arr == null) return out;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Screen s = new Screen();
                s.id = o.optString("id");
                s.name = o.optString("name", s.id);
                s.title = o.optString("title", s.name);
                s.showInTabs = o.optBoolean("showInTabs", true);
                s.tabIcon = o.optString("tabIcon", null);
                JSONArray comps = o.optJSONArray("components");
                if (comps != null) for (int c = 0; c < comps.length(); c++) s.roots.add(node(comps.getJSONObject(c)));
                out.add(s);
            }
        } catch (Exception e) {
            // A malformed asset must not crash the app on launch. An empty list
            // shows the built-in "nothing to display" state instead.
            android.util.Log.e("AppMint", "screens.json could not be read", e);
        }
        return out;
    }

    private static Node node(JSONObject o) throws JSONException {
        Node n = new Node();
        n.type = o.optString("type");
        n.id = o.optString("id", null);
        n.props = o.optJSONObject("props");
        n.a11yLabel = o.optString("a11yLabel", null);
        JSONArray kids = o.optJSONArray("children");
        if (kids != null) for (int i = 0; i < kids.length(); i++) n.children.add(node(kids.getJSONObject(i)));
        JSONObject ev = o.optJSONObject("events");
        if (ev != null) {
            java.util.Iterator<String> it = ev.keys();
            while (it.hasNext()) {
                String k = it.next();
                n.eventNames.add(k);
                n.eventActions.add(ev.optJSONObject(k));
            }
        }
        return n;
    }

    private Screens() {}
}
`;
}

/* ==================================================================== *
 * Actions.java — every action, built by hand, never parsed from a URL
 * ==================================================================== */
function actionsJava(pkg, caps) {
  const has = (c) => caps.includes(c);
  return `package ${pkg};

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * Generated by Project1 Studio.
 *
 * Every action here constructs its Intent explicitly. Nothing is ever
 * reconstructed from untrusted text, and no arbitrary component can be reached,
 * which removes the intent-redirection class of bug entirely rather than
 * blocklisting a few strings.
 */
public final class Actions {

    private final Activity activity;
    private final Navigator navigator;

    public interface Navigator {
        void goTo(String screenId);
        boolean goBack();
        void openDrawer();
        void setThemeMode(String mode);
    }

    public Actions(Activity activity, Navigator navigator) {
        this.activity = activity;
        this.navigator = navigator;
    }

    /** Run an action described by the screen data. */
    public void run(JSONObject action, View source) {
        if (action == null) return;
        String kind = action.optString("kind", "none");
        JSONObject p = action.optJSONObject("props");
        if (p == null) p = new JSONObject();

        switch (kind) {
            case "navigate":
                navigator.goTo(p.optString("screen", ""));
                break;
            case "closeScreen":
                if (!navigator.goBack()) activity.finish();
                break;
            case "openDrawer":
                navigator.openDrawer();
                break;
            case "setThemeMode":
                navigator.setThemeMode(p.optString("mode", "system"));
                break;
            case "toast":
                toast(p.optString("message", ""));
                break;
            case "copy":
                copy(p.optString("text", ""));
                break;
            case "openUrl":
                openWeb(p.optString("url", ""));
                break;
            case "download":
                openWeb(p.optString("url", ""));
                break;
            case "share":
                share(p.optString("text", ""), p.optString("title", "Share via"));
                break;
            case "call":
                dial(p.optString("number", ""));
                break;
            case "email":
                mail(p.optString("to", ""), p.optString("subject", ""));
                break;
            case "sms":
                message(p.optString("number", ""), p.optString("body", ""));
                break;
            case "upi":
                upi(p.optString("vpa", ""), p.optString("name", ""), p.optString("amount", ""), p.optString("note", ""));
                break;
            case "openApp":
                openAppScheme(p.optString("url", ""));
                break;
            case "scrollTo":
                scrollTo(source, p.optString("target", ""));
                break;
            default:
                // Unknown action: say so rather than failing silently.
                toast("This button is not set up yet.");
                break;
        }
    }

    /* ---------------------------------------------------------------- */

    private void toast(String m) {
        if (m != null && !m.isEmpty()) Toast.makeText(activity, m, Toast.LENGTH_SHORT).show();
    }

    private void copy(String text) {
        if (text == null || text.isEmpty()) return;
        String safe = text.length() > 8000 ? text.substring(0, 8000) : text;
        android.content.ClipboardManager cm =
                (android.content.ClipboardManager) activity.getSystemService(Activity.CLIPBOARD_SERVICE);
        if (cm != null) {
            cm.setPrimaryClip(android.content.ClipData.newPlainText("copy", safe));
            toast("Copied");
        }
    }

    /** Only http and https are ever handed to a browser. */
    private void openWeb(String url) {
        String scheme = schemeOf(url);
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            toast("That is not a web address.");
            return;
        }
        start(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    private void share(String text, String title) {
        if (text == null || text.isEmpty()) return;
        String safe = text.length() > 4000 ? text.substring(0, 4000) : text;
        Intent i = new Intent(Intent.ACTION_SEND);
        i.setType("text/plain");
        i.putExtra(Intent.EXTRA_TEXT, safe);
        try {
            activity.startActivity(Intent.createChooser(i, title == null || title.isEmpty() ? "Share via" : title));
        } catch (Exception e) {
            toast("Nothing on this device can share.");
        }
    }

    private void dial(String number) {
        String digits = number == null ? "" : number.replaceAll("[^0-9+*#]", "");
        if (digits.isEmpty()) { toast("No phone number was set."); return; }
        // ACTION_DIAL only opens the dialler pre-filled. The user still presses
        // call, so no permission and no surprise charge.
        start(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(digits))));
    }

    private void mail(String to, String subject) {
        if (to == null || to.isEmpty()) { toast("No email address was set."); return; }
        StringBuilder uri = new StringBuilder("mailto:").append(Uri.encode(to));
        if (subject != null && !subject.isEmpty()) uri.append("?subject=").append(Uri.encode(subject));
        Intent i = new Intent(Intent.ACTION_SENDTO, Uri.parse(uri.toString()));
        start(i);
    }

    private void message(String number, String body) {
        String digits = number == null ? "" : number.replaceAll("[^0-9+]", "");
        if (digits.isEmpty()) { toast("No phone number was set."); return; }
        Intent i = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + digits));
        if (body != null && !body.isEmpty()) i.putExtra("sms_body", body);
        start(i);
    }

    /**
     * UPI is handed to whichever payment app the user has. This app never sees
     * a card number, a PIN or a balance.
     */
    private void upi(String vpa, String name, String amount, String note) {
        if (vpa == null || vpa.isEmpty()) { toast("No UPI ID was set."); return; }
        if (!vpa.matches("^[a-zA-Z0-9.\\\\-_]{2,256}@[a-zA-Z]{2,64}$")) {
            toast("That does not look like a UPI ID.");
            return;
        }
        StringBuilder u = new StringBuilder("upi://pay")
                .append("?pa=").append(Uri.encode(vpa));
        if (name != null && !name.isEmpty()) u.append("&pn=").append(Uri.encode(name));
        if (amount != null && !amount.isEmpty()) {
            String a = amount.replaceAll("[^0-9.]", "");
            if (!a.isEmpty()) u.append("&am=").append(Uri.encode(a));
        }
        if (note != null && !note.isEmpty()) u.append("&tn=").append(Uri.encode(note));
        u.append("&cu=INR");
        start(new Intent(Intent.ACTION_VIEW, Uri.parse(u.toString())));
    }

    /**
     * A custom scheme belonging to another app. Only an allowlisted set is
     * forwarded, and only as a plain ACTION_VIEW with a validated Uri — never a
     * parsed Intent, which could carry a target component.
     */
    private void openAppScheme(String url) {
        String scheme = schemeOf(url);
        if (scheme.isEmpty()) { toast("That app link is not valid."); return; }
        java.util.Set<String> allowed = new java.util.HashSet<>(java.util.Arrays.asList(
            ${(caps.includes('deepLinks') ? `"whatsapp", "whatsapp.w4b", "instagram", "fb", "twitter", "telegram", "tg", "spotify", "youtube", "market", "geo"` : `"market", "geo"`)}));
        if (!allowed.contains(scheme)) {
            toast("This app does not open " + scheme + ": links.");
            return;
        }
        start(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    private void scrollTo(View source, String targetId) {
        if (targetId == null || targetId.isEmpty()) return;
        View root = source == null ? null : source.getRootView();
        if (root == null) return;
        View target = root.findViewWithTag("cmp:" + targetId);
        if (target != null && target.getParent() instanceof android.widget.ScrollView) {
            final android.widget.ScrollView sv = (android.widget.ScrollView) target.getParent();
            sv.post(() -> sv.smoothScrollTo(0, target.getTop()));
        }
    }

    /** The one place an outgoing Intent is started, so failure is handled once. */
    private void start(Intent intent) {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            // Only launch when something can genuinely handle it; otherwise the
            // user gets a clear message instead of a dead tap.
            if (intent.resolveActivity(activity.getPackageManager()) == null) {
                toast("No app on this device can open that.");
                return;
            }
            activity.startActivity(intent);
        } catch (Exception e) {
            toast("No app on this device can open that.");
        }
    }

    private static String schemeOf(String url) {
        if (url == null) return "";
        int i = url.indexOf(':');
        if (i <= 0) return "";
        String s = url.substring(0, i).toLowerCase(java.util.Locale.ROOT);
        return s.replaceAll("[^a-z0-9+.\\\\-]", "");
    }
}
`;
}

/* ==================================================================== *
 * ScreenRenderer.java — the component set, built as real Android views
 * ==================================================================== */
function rendererJava(pkg) {
  return `package ${pkg};

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Generated by Project1 Studio.
 *
 * Builds real Android views from the screen data. One renderer for the whole
 * component set, so a change to how a Button looks is made in exactly one place.
 *
 * Accessibility: every interactive or meaningful view gets a content
 * description, and pure layout containers are marked as not important for
 * accessibility so a screen reader does not announce empty groups.
 */
public class ScreenRenderer {

    /* Scale tables, generated from the same definitions the Studio draws with. */
    ${javaScaleMap('HEIGHTS', heights, 'Integer')}
    ${javaScaleMap('SPACINGS', spacings, 'Integer')}
    ${javaScaleMap('RADII', radii, 'Integer')}
    ${javaScaleMap('TEXT_SIZES', textSizes, 'Float')}

    private final Context ctx;
    private final Actions actions;
    private final Tokens t;
    private final Map<String, View> byId = new HashMap<>();

    /** Resolved theme values, passed in once so every view agrees. */
    public static class Tokens {
        public int primary, onPrimary, background, surface, onSurface, accent, outline;
        public boolean dark;
    }

    public ScreenRenderer(Context ctx, Actions actions, Tokens t) {
        this.ctx = ctx;
        this.actions = actions;
        this.t = t;
    }

    public View find(String componentId) { return byId.get(componentId); }

    /* ---------------------------------------------------------------- */

    public View build(Screens.Screen screen) {
        ScrollView scroll = new ScrollView(ctx);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(t.background);
        scroll.setVerticalScrollBarEnabled(false);

        LinearLayout column = new LinearLayout(ctx);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(16), dp(16), dp(16), dp(28));
        scroll.addView(column, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        for (Screens.Node n : screen.roots) {
            View v = render(n);
            if (v != null) column.addView(v);
        }
        return scroll;
    }

    /* ---------------------------------------------------------------- */

    private View render(Screens.Node n) {
        if (n == null || n.type == null) return null;
        if (!n.flag("visible", true)) return null;

        View v;
        switch (n.type) {
            case "Container":        v = container(n); break;
            case "Card":             v = card(n); break;
            case "Divider":          v = divider(n); break;
            case "Spacer":           v = spacer(n); break;
            case "Text":             v = text(n, false); break;
            case "Heading":          v = text(n, true); break;
            case "Badge":            v = badge(n); break;
            case "Chip":             v = chip(n); break;
            case "Image":            v = image(n); break;
            case "Avatar":           v = avatar(n); break;
            case "Progress":         v = progress(n); break;
            case "Loading":          v = loading(n); break;
            case "Button":           v = button(n); break;
            case "IconButton":       v = iconButton(n); break;
            case "Input":            v = input(n, false); break;
            case "PasswordInput":    v = input(n, true); break;
            case "Search":           v = search(n); break;
            case "Dropdown":         v = dropdown(n); break;
            case "Checkbox":         v = checkbox(n); break;
            case "Switch":           v = switchView(n); break;
            case "Slider":           v = slider(n); break;
            case "Form":             v = form(n); break;
            case "List":             v = list(n); break;
            case "Grid":             v = grid(n); break;
            case "Tabs":             v = tabs(n); break;
            case "AppBar":           v = null; break;   // handled by the host activity
            case "BottomNavigation": v = null; break;   // handled by the host activity
            case "Drawer":           v = null; break;   // handled by the host activity
            case "FloatingButton":   v = null; break;   // handled by the host activity
            case "Dialog":
            case "BottomSheet":      v = section(n); break;
            default:
                v = unknown(n);
        }

        if (v != null) {
            if (n.id != null && !n.id.isEmpty()) {
                v.setTag("cmp:" + n.id);
                byId.put(n.id, v);
            }
            applyCommon(v, n);
        }
        return v;
    }

    /* ── layout ─────────────────────────────────────────────────────── */

    private View container(Screens.Node n) {
        LinearLayout box = new LinearLayout(ctx);
        boolean row = "row".equals(n.prop("direction", "column"));
        box.setOrientation(row ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        int gap = spacing(n.prop("gap", "md"));
        String bg = n.prop("backgroundColor", null);
        if (bg != null) box.setBackgroundColor(parse(bg, Color.TRANSPARENT));
        box.setPadding(spacing(n.prop("padding", "none")), spacing(n.prop("padding", "none")),
                       spacing(n.prop("padding", "none")), spacing(n.prop("padding", "none")));

        boolean first = true;
        for (Screens.Node kid : n.children) {
            View kv = render(kid);
            if (kv == null) continue;
            if (!first) {
                if (row) { LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(gap, 0); box.addView(new View(ctx), lp); }
                else { View sp = new View(ctx); box.addView(sp, new LinearLayout.LayoutParams(0, gap)); }
            }
            first = false;
            if (row) {
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                box.addView(kv, lp);
            } else {
                box.addView(kv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            }
        }
        return box;
    }

    private View card(Screens.Node n) {
        boolean elevated = n.flag("elevated", true);
        LinearLayout box = new LinearLayout(ctx);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = spacing(n.prop("padding", "md"));
        box.setPadding(pad, pad, pad, pad);

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(t.surface);
        bg.setCornerRadius(dp(radius(n.prop("radius", "md"))));
        if (!elevated) bg.setStroke(dp(1), t.outline);
        box.setBackground(bg);
        if (elevated) box.setElevation(dp(2));

        for (Screens.Node kid : n.children) {
            View kv = render(kid);
            if (kv != null) box.addView(kv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }
        return box;
    }

    private View divider(Screens.Node n) {
        View line = new View(ctx);
        int thick = "md".equals(n.prop("thickness", "hairline")) ? 2
                  : "sm".equals(n.prop("thickness", "hairline")) ? 1 : 1;
        line.setBackgroundColor(t.outline);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(thick));
        int m = spacing(n.prop("margin", "sm"));
        lp.setMargins(0, m, 0, m);
        line.setLayoutParams(lp);
        return line;
    }

    private View spacer(Screens.Node n) {
        View v = new View(ctx);
        Map<String, Integer> h = new HashMap<>();
        h.put("xs", 4); h.put("sm", 10); h.put("md", 18); h.put("lg", 30); h.put("xl", 48);
        int px = h.getOrDefault(n.prop("height", "md"), 18);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, dp(px)));
        return v;
    }

    /** Dialog and bottom sheet contents are rendered inline as a plain section. */
    private View section(Screens.Node n) {
        return container(n);
    }

    private View unknown(Screens.Node n) {
        TextView tv = baseText(n.prop("text", n.type), false);
        tv.setText("Unknown component: " + n.type);
        tv.setTextColor(t.onSurface);
        return tv;
    }

    /* ── text ───────────────────────────────────────────────────────── */

    private TextView baseText(String s, boolean heading) {
        TextView tv = new TextView(ctx);
        tv.setText(s == null ? "" : s);
        tv.setTextColor(t.onSurface);
        tv.setTextSize(heading ? 22 : 14);
        return tv;
    }

    private View text(Screens.Node n, boolean heading) {
        TextView tv = baseText(n.prop("text", ""), heading);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, textSize(n.prop("size", heading ? "xl" : "md"), heading));
        if (n.flag("weight", false) || heading) tv.setTypeface(null, Typeface.BOLD);
        String c = n.prop("color", null);
        if (c != null) tv.setTextColor(parse(c, t.onSurface));
        tv.setGravity(gravity(n.prop("align", "start")));
        tv.setLineSpacing(0f, 1.15f);
        return wrap(tv, n);
    }

    private View badge(Screens.Node n) {
        TextView tv = baseText(n.prop("text", ""), false);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tv.setTypeface(null, Typeface.BOLD);
        tv.setPadding(dp(10), dp(5), dp(10), dp(5));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(999));
        switch (n.prop("tone", "neutral")) {
            case "info":    bg.setColor(withAlpha(t.accent, 40));    tv.setTextColor(t.accent); break;
            case "success": bg.setColor(withAlpha(Color.parseColor("#22C55E"), 40)); tv.setTextColor(Color.parseColor("#22C55E")); break;
            case "warning": bg.setColor(withAlpha(Color.parseColor("#F59E0B"), 40)); tv.setTextColor(Color.parseColor("#F59E0B")); break;
            case "danger":  bg.setColor(withAlpha(Color.parseColor("#EF4444"), 40)); tv.setTextColor(Color.parseColor("#EF4444")); break;
            default:        bg.setColor(t.surface); tv.setTextColor(t.onSurface);
        }
        tv.setBackground(bg);
        LinearLayout row = new LinearLayout(ctx);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.addView(tv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return wrap(row, n);
    }

    private View chip(Screens.Node n) {
        TextView tv = baseText(n.prop("text", ""), false);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        tv.setPadding(dp(14), dp(8), dp(14), dp(8));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(999));
        boolean sel = n.flag("selected", false);
        bg.setColor(sel ? t.primary : t.surface);
        bg.setStroke(dp(1), sel ? t.primary : t.outline);
        tv.setTextColor(sel ? t.onPrimary : t.onSurface);
        tv.setBackground(bg);
        attachEvents(tv, n);
        return wrap(tv, n);
    }

    /* ── media ──────────────────────────────────────────────────────── */

    private View image(Screens.Node n) {
        // A generated app must render something even when a picture cannot be
        // fetched, so a placeholder stands in rather than an empty gap.
        FrameLayout frame = new FrameLayout(ctx);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(HEIGHTS.getOrDefault(n.prop("height", "md"), 180)));
        frame.setLayoutParams(lp);

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(t.surface);
        bg.setCornerRadius(dp(radius(n.prop("radius", "sm"))));
        frame.setBackground(bg);

        TextView placeholder = baseText("Image", false);
        placeholder.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        placeholder.setTextColor(t.outline);
        placeholder.setGravity(Gravity.CENTER);
        frame.addView(placeholder, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // The address is recorded on the view; a project that bundles images
        // supplies them locally, and remote loading is opt-in elsewhere.
        frame.setContentDescription(n.a11yLabel != null ? n.a11yLabel : "Image");
        return wrap(frame, n);
    }

    private View avatar(Screens.Node n) {
        int size = "sm".equals(n.prop("size", "md")) ? 32
                 : "lg".equals(n.prop("size", "md")) ? 72 : 48;
        TextView tv = baseText(n.prop("fallback", "?"), false);
        tv.setGravity(Gravity.CENTER);
        tv.setTypeface(null, Typeface.BOLD);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(withAlpha(t.primary, 60));
        tv.setBackground(bg);
        tv.setTextColor(t.primary);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(size), dp(size));
        tv.setLayoutParams(lp);
        tv.setContentDescription(n.a11yLabel != null ? n.a11yLabel : n.prop("fallback", "Account"));
        return wrap(tv, n);
    }

    private View progress(Screens.Node n) {
        LinearLayout box = new LinearLayout(ctx);
        box.setOrientation(LinearLayout.VERTICAL);
        ProgressBar bar = new ProgressBar(ctx, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgress(Math.max(0, Math.min(100, n.intProp("value", 40))));
        box.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        if (n.flag("showLabel", false)) {
            TextView tv = baseText(n.intProp("value", 40) + "%", false);
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            tv.setTextColor(t.outline);
            box.addView(tv);
        }
        return wrap(box, n);
    }

    private View loading(Screens.Node n) {
        LinearLayout row = new LinearLayout(ctx);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        ProgressBar spin = new ProgressBar(ctx);
        int s = "sm".equals(n.prop("size", "md")) ? 26 : "lg".equals(n.prop("size", "md")) ? 48 : 34;
        row.addView(spin, new LinearLayout.LayoutParams(dp(s), dp(s)));
        String label = n.prop("label", "Loading…");
        if (!label.isEmpty()) {
            TextView tv = baseText(label, false);
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            tv.setTextColor(t.outline);
            tv.setPadding(dp(10), 0, 0, 0);
            row.addView(tv);
        }
        return wrap(row, n);
    }

    /* ── inputs ─────────────────────────────────────────────────────── */

    private View button(Screens.Node n) {
        TextView b = baseText(n.prop("text", "Button"), false);
        b.setGravity(Gravity.CENTER);
        b.setTypeface(null, Typeface.BOLD);
        int pad = "lg".equals(n.prop("size", "md")) ? 18 : "sm".equals(n.prop("size", "md")) ? 10 : 14;
        b.setPadding(dp(16), dp(pad), dp(16), dp(pad));

        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(12));
        switch (n.prop("style", "primary")) {
            case "ghost":  bg.setColor(Color.TRANSPARENT); bg.setStroke(dp(1), t.outline); b.setTextColor(t.onSurface); break;
            case "text":   bg.setColor(Color.TRANSPARENT); b.setTextColor(t.primary); break;
            case "danger": bg.setColor(Color.parseColor("#EF4444")); b.setTextColor(Color.WHITE); break;
            default:       bg.setColor(t.primary); b.setTextColor(t.onPrimary);
        }
        b.setBackground(bg);
        boolean disabled = n.flag("disabled", false);
        b.setEnabled(!disabled);
        if (disabled) b.setAlpha(0.45f);
        attachEvents(b, n);
        // Copy is stateful, so the background has to change on tap.
        b.setClickable(true);
        b.setFocusable(true);
        if (n.flag("fullWidth", true)) return wrap(b, n);

        LinearLayout row = new LinearLayout(ctx);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.addView(b, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return wrap(row, n);
    }

    private View iconButton(Screens.Node n) {
        TextView b = baseText(iconGlyph(n.prop("icon", "menu")), false);
        b.setGravity(Gravity.CENTER);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        b.setTextColor(t.onSurface);
        int s = "sm".equals(n.prop("size", "md")) ? 36 : "lg".equals(n.prop("size", "md")) ? 52 : 44;
        b.setLayoutParams(new LinearLayout.LayoutParams(dp(s), dp(s)));
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(t.surface);
        b.setBackground(bg);
        b.setClickable(true);
        b.setFocusable(true);
        attachEvents(b, n);
        return wrap(b, n);
    }

    private View input(Screens.Node n, boolean password) {
        LinearLayout box = new LinearLayout(ctx);
        box.setOrientation(LinearLayout.VERTICAL);
        String label = n.prop("label", "");
        if (!label.isEmpty()) {
            TextView lv = baseText(label, false);
            lv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            lv.setTextColor(t.outline);
            lv.setPadding(0, 0, 0, dp(6));
            box.addView(lv);
        }
        EditText et = new EditText(ctx);
        et.setHint(n.prop("placeholder", password ? "Password" : ""));
        et.setTextColor(t.onSurface);
        et.setHintTextColor(t.outline);
        et.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(t.background);
        bg.setCornerRadius(dp(10));
        bg.setStroke(dp(1), t.outline);
        et.setBackground(bg);
        et.setPadding(dp(13), dp(12), dp(13), dp(12));

        if (password) {
            et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            et.setSingleLine(true);
        } else {
            switch (n.prop("inputType", "text")) {
                case "number":    et.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL); break;
                case "phone":     et.setInputType(InputType.TYPE_CLASS_PHONE); break;
                case "email":     et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS); break;
                case "multiline": et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE); et.setMinLines(3); et.setGravity(Gravity.TOP); break;
                default:          et.setInputType(InputType.TYPE_CLASS_TEXT);
            }
        }
        int max = n.intProp("maxLength", 0);
        if (max > 0) {
            et.setFilters(new android.text.InputFilter[]{ new android.text.InputFilter.LengthFilter(max) });
        }
        box.addView(et, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        String helper = n.prop("helper", null);
        TextView hv = null;
        if (helper != null) {
            hv = baseText(helper, false);
            hv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
            hv.setTextColor(t.outline);
            hv.setPadding(0, dp(5), 0, 0);
            box.addView(hv);
        }

        // Live validation, so a required field says so as soon as it is left
        // empty rather than at submit time with no explanation.
        if (n.flag("required", false)) {
            final TextView helperView = hv;
            final EditText field = et;
            final int minLen = password ? n.intProp("minLength", 8) : 1;
            field.setOnFocusChangeListener((v, hasFocus) -> {
                if (hasFocus) return;
                String value = field.getText().toString().trim();
                boolean bad = value.length() < minLen;
                field.setBackground(strokeBox(bad ? Color.parseColor("#EF4444") : t.outline));
                if (helperView != null) {
                    helperView.setText(bad
                        ? (password ? "Use at least " + minLen + " characters." : "This is needed.")
                        : helper);
                    helperView.setTextColor(bad ? Color.parseColor("#EF4444") : t.outline);
                }
            });
        }

        attachEvents(et, n);
        return wrap(box, n);
    }

    private View search(Screens.Node n) {
        LinearLayout row = new LinearLayout(ctx);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(t.surface);
        bg.setCornerRadius(dp(999));
        bg.setStroke(dp(1), t.outline);
        row.setBackground(bg);

        TextView glyph = baseText(iconGlyph("search"), false);
        glyph.setPadding(dp(13), dp(11), dp(6), dp(11));
        glyph.setTextColor(t.outline);
        row.addView(glyph);

        EditText et = new EditText(ctx);
        et.setHint(n.prop("placeholder", "Search"));
        et.setTextColor(t.onSurface);
        et.setHintTextColor(t.outline);
        et.setBackgroundColor(Color.TRANSPARENT);
        et.setSingleLine(true);
        et.setPadding(0, dp(11), dp(13), dp(11));
        et.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);
        row.addView(et, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        // Enter on the keyboard runs the configured action.
        et.setOnEditorActionListener((v, actionId, ev) -> {
            Screens.Node search = n;
            fire(search, "onSubmit", v);
            return true;
        });
        attachEvents(et, n);
        return wrap(row, n);
    }

    private View dropdown(Screens.Node n) {
        LinearLayout box = new LinearLayout(ctx);
        box.setOrientation(LinearLayout.VERTICAL);
        String label = n.prop("label", "");
        if (!label.isEmpty()) {
            TextView lv = baseText(label, false);
            lv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            lv.setTextColor(t.outline);
            lv.setPadding(0, 0, 0, dp(6));
            box.addView(lv);
        }
        Spinner sp = new Spinner(ctx);
        List<String> items = listProp(n.prop("options", ""));
        if (items.isEmpty()) items.add("(no options yet)");
        ArrayAdapter<String> adapter = new ArrayAdapter<>(ctx, android.R.layout.simple_spinner_dropdown_item, items);
        sp.setAdapter(adapter);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(t.background);
        bg.setCornerRadius(dp(10));
        bg.setStroke(dp(1), t.outline);
        sp.setBackground(bg);
        sp.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> parent, View view, int position, long id) {
                fire(n, "onChange", view);
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) { }
        });
        box.addView(sp, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return wrap(box, n);
    }

    private View checkbox(Screens.Node n) {
        CheckBox cb = new CheckBox(ctx);
        cb.setText(n.prop("text", ""));
        cb.setTextColor(t.onSurface);
        cb.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        cb.setChecked(n.flag("checked", false));
        cb.setOnCheckedChangeListener((v, checked) -> fire(n, "onChange", v));
        return wrap(cb, n);
    }

    private View switchView(Screens.Node n) {
        LinearLayout box = new LinearLayout(ctx);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout texts = new LinearLayout(ctx);
        texts.setOrientation(LinearLayout.VERTICAL);
        TextView tv = baseText(n.prop("text", ""), false);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        texts.addView(tv);
        String sub = n.prop("subtitle", null);
        if (sub != null) {
            TextView sv = baseText(sub, false);
            sv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            sv.setTextColor(t.outline);
            texts.addView(sv);
        }
        box.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Switch sw = new Switch(ctx);
        sw.setChecked(n.flag("checked", false));
        sw.setOnCheckedChangeListener((v, checked) -> fire(n, "onChange", v));
        box.addView(sw);
        return wrap(box, n);
    }

    private View slider(Screens.Node n) {
        LinearLayout box = new LinearLayout(ctx);
        box.setOrientation(LinearLayout.VERTICAL);
        String label = n.prop("label", "");
        if (!label.isEmpty()) {
            TextView lv = baseText(label, false);
            lv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            lv.setTextColor(t.outline);
            box.addView(lv);
        }
        SeekBar sb = new SeekBar(ctx);
        int min = n.intProp("min", 0), max = n.intProp("max", 100);
        int span = Math.max(1, max - min);
        sb.setMax(span);
        sb.setProgress(Math.max(0, Math.min(span, n.intProp("value", 50) - min)));
        box.addView(sb, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        sb.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int progress, boolean fromUser) { if (fromUser) fire(n, "onChange", s); }
            @Override public void onStartTrackingTouch(SeekBar s) { }
            @Override public void onStopTrackingTouch(SeekBar s) { }
        });
        return wrap(box, n);
    }

    private View form(Screens.Node n) {
        LinearLayout box = new LinearLayout(ctx);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = spacing(n.prop("padding", "sm"));
        box.setPadding(pad, pad, pad, pad);

        final List<EditText> fields = new ArrayList<>();
        for (Screens.Node kid : n.children) {
            View kv = render(kid);
            if (kv == null) continue;
            collectEditTexts(kv, fields);
            box.addView(kv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }

        TextView submit = baseText(n.prop("submitLabel", "Submit"), false);
        submit.setGravity(Gravity.CENTER);
        submit.setTypeface(null, Typeface.BOLD);
        submit.setPadding(dp(16), dp(14), dp(16), dp(14));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(12));
        bg.setColor(t.primary);
        submit.setTextColor(t.onPrimary);
        submit.setBackground(bg);
        submit.setClickable(true);
        submit.setFocusable(true);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        sp.setMargins(0, dp(12), 0, 0);
        box.addView(submit, sp);

        // Validation happens here, before anything is submitted, and it names
        // the field rather than saying "please check the form".
        submit.setOnClickListener(v -> {
            if (n.flag("validate", true)) {
                for (EditText f : fields) {
                    if (f.getText().toString().trim().isEmpty()) {
                        f.setBackground(strokeBox(Color.parseColor("#EF4444")));
                        f.requestFocus();
                        android.widget.Toast.makeText(ctx,
                            "Please fill in " + (f.getHint() == null ? "all the fields" : f.getHint().toString()) + ".",
                            android.widget.Toast.LENGTH_SHORT).show();
                        return;
                    }
                }
            }
            fire(n, "onSubmit", v);
        });
        return wrap(box, n);
    }

    private void collectEditTexts(View v, List<EditText> into) {
        if (v instanceof EditText) { into.add((EditText) v); return; }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) collectEditTexts(g.getChildAt(i), into);
        }
    }

    /* ── collections ────────────────────────────────────────────────── */

    private View list(Screens.Node n) {
        LinearLayout box = new LinearLayout(ctx);
        box.setOrientation(LinearLayout.VERTICAL);
        boolean remote = "remote".equals(n.prop("source", "static"));
        List<String> items = listProp(n.prop("items", ""));
        if (remote && items.isEmpty()) {
            items = new ArrayList<>();
        }
        if (items.isEmpty()) {
            TextView empty = baseText(remote ? "Nothing loaded yet." : "No items yet.", false);
            empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            empty.setTextColor(t.outline);
            empty.setPadding(dp(4), dp(10), dp(4), dp(10));
            box.addView(empty);
            return wrap(box, n);
        }

        int shown = Math.min(items.size(), 60);
        for (int i = 0; i < shown; i++) {
            String raw = items.get(i);
            String[] parts = raw.split("\\\\|");
            if (i > 0 && n.flag("dividers", true)) {
                View line = new View(ctx);
                line.setBackgroundColor(t.outline);
                box.addView(line, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
            }
            LinearLayout row = new LinearLayout(ctx);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(0, dp(13), 0, dp(13));
            TextView title = baseText(parts[0].trim(), false);
            title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            row.addView(title);
            if (parts.length > 1 && !parts[1].trim().isEmpty()
                    && !"title".equals(n.prop("itemTemplate", "titleSubtitle"))) {
                TextView sub = baseText(parts[1].trim(), false);
                sub.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
                sub.setTextColor(t.outline);
                sub.setPadding(0, dp(3), 0, 0);
                row.addView(sub);
            }
            row.setClickable(true);
            row.setFocusable(true);
            final int index = i;
            row.setOnClickListener(v -> {
                v.setTag(android.R.id.text1, index);
                fire(n, "onClick", v);
            });
            box.addView(row, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }
        if (items.size() > shown) {
            TextView more = baseText((items.size() - shown) + " more", false);
            more.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            more.setTextColor(t.outline);
            more.setPadding(0, dp(10), 0, 0);
            box.addView(more);
        }
        return wrap(box, n);
    }

    private View grid(Screens.Node n) {
        int cols = Math.max(2, Math.min(4, n.intProp("columns", 2)));
        LinearLayout outer = new LinearLayout(ctx);
        outer.setOrientation(LinearLayout.VERTICAL);
        List<String> items = listProp(n.prop("items", ""));
        if (items.isEmpty()) {
            TextView empty = baseText("No items yet.", false);
            empty.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            empty.setTextColor(t.outline);
            outer.addView(empty);
            return wrap(outer, n);
        }
        LinearLayout row = null;
        for (int i = 0; i < items.size(); i++) {
            if (i % cols == 0) {
                row = new LinearLayout(ctx);
                row.setOrientation(LinearLayout.HORIZONTAL);
                LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                rp.setMargins(0, 0, 0, dp(8));
                outer.addView(row, rp);
            }
            TextView cell = baseText(items.get(i).trim(), false);
            cell.setGravity(Gravity.CENTER);
            cell.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            cell.setPadding(0, dp(22), 0, dp(22));
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(t.surface);
            bg.setCornerRadius(dp(12));
            bg.setStroke(dp(1), t.outline);
            cell.setBackground(bg);
            cell.setClickable(true);
            cell.setFocusable(true);
            attachEvents(cell, n);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            lp.setMargins(dp(4), 0, dp(4), 0);
            row.addView(cell, lp);
        }
        return wrap(outer, n);
    }

    private View tabs(Screens.Node n) {
        List<String> items = listProp(n.prop("tabs", ""));
        if (items.isEmpty()) items.add("Tab");
        HorizontalScrollView hsv = new HorizontalScrollView(ctx);
        hsv.setHorizontalScrollBarEnabled(false);
        LinearLayout row = new LinearLayout(ctx);
        row.setOrientation(LinearLayout.HORIZONTAL);
        for (int i = 0; i < items.size(); i++) {
            TextView t2 = baseText(items.get(i).trim(), false);
            t2.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            t2.setPadding(dp(16), dp(11), dp(16), dp(11));
            final int index = i;
            t2.setTextColor(i == 0 ? t.primary : t.outline);
            if (i == 0) t2.setTypeface(null, Typeface.BOLD);
            t2.setClickable(true);
            t2.setFocusable(true);
            t2.setOnClickListener(v -> {
                for (int c = 0; c < row.getChildCount(); c++) {
                    TextView child = (TextView) row.getChildAt(c);
                    boolean on = c == index;
                    child.setTextColor(on ? t.primary : t.outline);
                    child.setTypeface(null, on ? Typeface.BOLD : Typeface.NORMAL);
                }
                v.setTag(android.R.id.text1, index);
                fire(n, "onClick", v);
            });
            row.addView(t2);
        }
        hsv.addView(row);
        return wrap(hsv, n);
    }

    /* ── plumbing ───────────────────────────────────────────────────── */

    /** Wire every event the component declares to the action runner. */
    private void attachEvents(View v, Screens.Node n) {
        v.setClickable(true);
        v.setFocusable(true);
        if (has(n, "onClick")) v.setOnClickListener(x -> fire(n, "onClick", x));
        if (has(n, "onLongClick")) {
            v.setOnLongClickListener(x -> { fire(n, "onLongClick", x); return true; });
        }
    }

    private boolean has(Screens.Node n, String event) {
        return n.eventNames != null && n.eventNames.contains(event);
    }

    private void fire(Screens.Node n, String event, View source) {
        if (n.eventNames == null) return;
        int i = n.eventNames.indexOf(event);
        if (i < 0) return;
        actions.run(n.eventActions.get(i), source);
    }

    /** Outer margin and the responsive width cap, applied to every component. */
    private View wrap(View v, Screens.Node n) {
        int m = spacing(n.prop("margin", "none"));
        LinearLayout.LayoutParams lp = v.getLayoutParams() instanceof LinearLayout.LayoutParams
                ? (LinearLayout.LayoutParams) v.getLayoutParams()
                : new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(m, m, m, m);
        v.setLayoutParams(lp);

        if (n.flag("responsive", false)) {
            LinearLayout holder = new LinearLayout(ctx);
            holder.setOrientation(LinearLayout.HORIZONTAL);
            holder.setGravity(Gravity.CENTER_HORIZONTAL);
            LinearLayout.LayoutParams hl = new LinearLayout.LayoutParams(dp(560), LinearLayout.LayoutParams.WRAP_CONTENT);
            holder.addView(v, hl);
            return holder;
        }
        return v;
    }

    /** A layout container carries no information, so it must not be announced. */
    private void applyCommon(View v, Screens.Node n) {
        String label = n.a11yLabel;
        if (label != null && !label.isEmpty()) {
            v.setContentDescription(label);
        } else {
            v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
        }
        if (isContainer(n.type) && (label == null || label.isEmpty())) {
            v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        }
        int min = dp(44);
        if (v.getLayoutParams() != null && v.getLayoutParams().height == ViewGroup.LayoutParams.WRAP_CONTENT) {
            v.setMinimumHeight(Math.min(min, Math.max(v.getMinimumHeight(), 0)));
        }
    }

    private boolean isContainer(String type) {
        return "Container".equals(type) || "Screen".equals(type) || "Spacer".equals(type);
    }

    /* ── helpers ────────────────────────────────────────────────────── */

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.getResources().getDisplayMetrics()));
    }

    private int spacing(String key) {
        return dp(SPACINGS.getOrDefault(key == null ? "md" : key, 12));
    }

    private int radius(String key) {
        return RADII.getOrDefault(key == null ? "md" : key, 12);
    }

    private float textSize(String key, boolean heading) {
        if ("2xl".equals(key)) return 26f;
        if ("xl".equals(key)) return heading ? 23f : 20f;
        return TEXT_SIZES.getOrDefault(key == null ? "md" : key, 14f);
    }

    private int gravity(String align) {
        switch (align == null ? "start" : align) {
            case "center": return Gravity.CENTER_HORIZONTAL;
            case "end":    return Gravity.END;
            default:       return Gravity.START;
        }
    }

    private int parse(String hex, int fallback) {
        if (hex == null || hex.isEmpty()) return fallback;
        try { return Color.parseColor(hex); } catch (Exception e) { return fallback; }
    }

    private int withAlpha(int colour, int alpha) {
        return Color.argb(alpha, Color.red(colour), Color.green(colour), Color.blue(colour));
    }

    private GradientDrawable strokeBox(int strokeColour) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(t.background);
        bg.setCornerRadius(dp(10));
        bg.setStroke(dp(1), strokeColour);
        return bg;
    }

    /** Items are one per line; a pipe separates title from subtitle. */
    private List<String> listProp(String raw) {
        List<String> out = new ArrayList<>();
        if (raw == null) return out;
        for (String line : raw.split("\\n")) {
            String s = line.trim();
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }

    /**
     * A tiny built-in glyph set. Using text glyphs rather than a font file or a
     * drawable per icon keeps the APK small and avoids a build that fails
     * because an icon resource went missing.
     */
    private String iconGlyph(String name) {
        // Generated from the shared glyph table, so the preview in the Studio
        // and this method always show the same character.
        switch (name == null ? "menu" : name) {
${Object.entries(ICON_GLYPHS).map(([k, v]) => `            case "${k}": return "${javaEscape(v)}";`).join('\n')}
            default: return "${javaEscape(ICON_FALLBACK)}";
        }
    }
}
`;
}

/* ==================================================================== *
 * NativeActivity.java — host: top bar, bottom navigation, drawer, FAB
 * ==================================================================== */
function nativeActivityJava(pkg, spec, data) {
  const theme = spec.theme || {};
  const nav = spec.navigation || {};
  const screensWithAppBar = data.screens.filter((s) => (s.components || []).some((c) => c.type === 'AppBar'));
  const hasAppBar = screensWithAppBar.length > 0;
  const hasBottomNav = data.screens.some((s) => (s.components || []).some((c) => c.type === 'BottomNavigation'))
    || nav.type === 'bottom-tabs';
  const hasDrawer = data.screens.some((s) => (s.components || []).some((c) => c.type === 'Drawer'));
  const hasFab = data.screens.some((s) => (s.components || []).some((c) => c.type === 'FloatingButton'));
  const screensJson = JSON.stringify(data.screens.map((s) => ({ id: s.id, name: s.name, showInTabs: s.showInTabs })));

  return `package ${pkg};

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.GravityCompat;
import androidx.drawerlayout.widget.DrawerLayout;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

/**
 * Generated by Project1 Studio.
 *
 * Hosts the generated screens. The top bar, bottom navigation, side menu and
 * floating button live here rather than in the renderer, because only one of
 * each can exist per screen and they belong to the window, not to the content.
 */
public class NativeActivity extends AppCompatActivity implements Actions.Navigator {

    private static final String THEME_PREF = "appmint_theme";

    private final List<String> history = new ArrayList<>();
    private String currentId;

    private DrawerLayout drawer;
    private LinearLayout root;
    private FrameLayout contentHost;
    private TextView topTitle;
    private Actions actions;
    private ScreenRenderer.Tokens tokens;

${hasDrawer ? '    private LinearLayout drawerContent;\n' : ''}
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        tokens = buildTokens();
        actions = new Actions(this, this);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(tokens.background);

${hasAppBar ? `        root.addView(buildTopBar());\n` : ''}
        contentHost = new FrameLayout(this);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        root.addView(contentHost, cp);

${hasBottomNav ? `        root.addView(buildBottomNav());\n` : ''}
${hasFab ? `        contentHost.addView(buildFab());\n` : ''}
${hasDrawer ? `
        drawer = new DrawerLayout(this);
        drawer.setBackgroundColor(tokens.background);
        drawer.addView(root, new DrawerLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        drawerContent = new LinearLayout(this);
        drawerContent.setOrientation(LinearLayout.VERTICAL);
        drawerContent.setBackgroundColor(tokens.surface);
        DrawerLayout.LayoutParams dl = new DrawerLayout.LayoutParams(
                Math.min(320, getResources().getDisplayMetrics().widthPixels - 56),
                ViewGroup.LayoutParams.MATCH_PARENT);
        dl.gravity = Gravity.START;
        drawerContent.setPadding(dp(20), dp(28), dp(20), dp(20));
        drawer.addView(drawerContent, dl);
        setContentView(drawer);
` : `        setContentView(root);\n`}
        List<Screens.Screen> all = Screens.all(this);
        if (all.isEmpty()) {
            showEmptyState();
            return;
        }
        String start = ${JSON.stringify(data.screens[0]?.id || '')};
        if (savedInstanceState != null && savedInstanceState.getString("screen") != null) {
            start = savedInstanceState.getString("screen");
        }
        showScreen(start);
    }

    /* ── theme ─────────────────────────────────────────────────────── */

    private ScreenRenderer.Tokens buildTokens() {
        ScreenRenderer.Tokens t = new ScreenRenderer.Tokens();
        t.primary   = Color.parseColor("${theme.primary || '#2563EB'}");
        t.onPrimary = Color.parseColor("${theme.onPrimary || '#FFFFFF'}");
        t.background= Color.parseColor("${theme.background || '#0B1020'}");
        t.surface   = Color.parseColor("${theme.surface || '#151B2E'}");
        t.onSurface = Color.parseColor("${theme.onSurface || '#E8ECF8'}");
        t.accent    = Color.parseColor("${theme.accent || '#22D3EE'}");
        t.outline   = withAlpha(t.onSurface, 60);
        t.dark      = ${(((theme.background || '#0B1020').toLowerCase() !== '#ffffff') ? 'true' : 'false')};
        return t;
    }

    private int withAlpha(int c, int a) {
        return Color.argb(a, Color.red(c), Color.green(c), Color.blue(c));
    }

    /* ── chrome ────────────────────────────────────────────────────── */

${hasAppBar ? `    private View buildTopBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(tokens.surface);
        bar.setPadding(dp(8), dp(12), dp(8), dp(12));
        bar.setElevation(dp(2));

${hasDrawer ? `        TextView menu = glyph("\\u2261");
        menu.setContentDescription("Open the menu");
        menu.setOnClickListener(v -> openDrawer());
        bar.addView(menu);\n` : ''}
        topTitle = new TextView(this);
        topTitle.setTextColor(tokens.onSurface);
        topTitle.setTextSize(18f);
        topTitle.setTypeface(null, android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        tp.setMargins(dp(8), 0, dp(8), 0);
        bar.addView(topTitle, tp);
        return bar;
    }

    private TextView glyph(String s) {
        TextView tv = new TextView(this);
        tv.setText(s);
        tv.setTextSize(20f);
        tv.setTextColor(tokens.onSurface);
        tv.setGravity(Gravity.CENTER);
        int size = dp(44);
        tv.setLayoutParams(new LinearLayout.LayoutParams(size, size));
        tv.setClickable(true);
        tv.setFocusable(true);
        return tv;
    }\n` : ''}

${hasBottomNav ? `    private View buildBottomNav() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(tokens.surface);
        bar.setPadding(0, dp(8), 0, dp(8));
        bar.setElevation(dp(4));

        // Read from the screens that were already parsed. Re-declaring the same
        // list compiled into a string would be a second copy of the data, and a
        // second copy is something that can disagree with the first.
        final List<Screens.Screen> shown = new ArrayList<>();
        for (Screens.Screen s : Screens.all(this)) if (s.showInTabs) shown.add(s);
        // At most five items fit legibly on a phone.
        while (shown.size() > 5) shown.remove(shown.size() - 1);

        for (final Screens.Screen s : shown) {
            final String id = s.id;
            String name = s.name;
            TextView item = new TextView(this);
            item.setText(name);
            item.setTextSize(11.5f);
            item.setGravity(Gravity.CENTER);
            item.setPadding(0, dp(10), 0, dp(10));
            item.setContentDescription(name);
            item.setClickable(true);
            item.setFocusable(true);
            item.setOnClickListener(v -> goTo(id));
            bar.addView(item, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        }
        return bar;
    }\n` : ''}

${hasFab ? `    private View buildFab() {
        TextView fab = new TextView(this);
        fab.setText("+");
        fab.setTextSize(26f);
        fab.setGravity(Gravity.CENTER);
        fab.setTextColor(tokens.onPrimary);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        bg.setColor(tokens.primary);
        fab.setBackground(bg);
        fab.setElevation(dp(6));
        fab.setContentDescription("Add");
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dp(56), dp(56));
        lp.gravity = Gravity.END | Gravity.BOTTOM;
        lp.setMargins(0, 0, dp(18), dp(18));
        fab.setLayoutParams(lp);
        fab.setClickable(true);
        fab.setFocusable(true);
        // The action comes from the screen data, so it stays in one place.
        for (Screens.Screen s : Screens.all(this)) {
            for (Screens.Node n : s.roots) {
                if ("FloatingButton".equals(n.type) && n.eventNames.contains("onClick")) {
                    final Screens.Node node = n;
                    fab.setOnClickListener(v -> actions.run(node.eventActions.get(node.eventNames.indexOf("onClick")), v));
                    return fab;
                }
            }
        }
        return fab;
    }\n` : ''}

    /* ── navigation ────────────────────────────────────────────────── */

    /** The Navigator contract: a button asked to go somewhere new. */
    @Override public void goTo(String screenId) {
        history.clear();
        showScreen(screenId);
    }

    private void showScreen(String id) {
        if (id == null || id.isEmpty()) return;
        Screens.Screen screen = Screens.byId(this, id);
        if (screen == null) return;
        if (currentId != null && !currentId.equals(id)) history.add(currentId);
        currentId = id;

        ScreenRenderer renderer = new ScreenRenderer(this, actions, tokens);
        View view = renderer.build(screen);
        contentHost.removeAllViews();
        contentHost.addView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        if (topTitle != null) {
            String title = screen.title;
            for (Screens.Node n : screen.roots) {
                if ("AppBar".equals(n.type)) title = n.prop("title", screen.title);
            }
            topTitle.setText(title);
        }
${hasBottomNav ? `        updateBottomNav();\n` : ''}${hasDrawer ? `        buildDrawerItems();\n` : ''}    }

    private void showEmptyState() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(tokens.background);
        TextView tv = new TextView(this);
        tv.setText("No screens yet");
        tv.setTextColor(tokens.onSurface);
        tv.setTextSize(17f);
        tv.setGravity(Gravity.CENTER);
        box.addView(tv);
        setContentView(box);
    }

${hasBottomNav ? `    private void updateBottomNav() {
        View bar = root.getChildAt(root.getChildCount() - 1);
        if (!(bar instanceof LinearLayout)) return;
        LinearLayout nav = (LinearLayout) bar;
        List<Screens.Screen> all = Screens.all(this);
        int index = 0;
        for (Screens.Screen s : all) {
            if (!s.showInTabs) continue;
            if (index >= nav.getChildCount()) break;
            TextView item = (TextView) nav.getChildAt(index++);
            boolean on = s.id.equals(currentId);
            item.setTextColor(on ? tokens.primary : tokens.outline);
            item.setTypeface(null, on ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL);
        }
    }\n` : ''}

${hasDrawer ? `    private void buildDrawerItems() {
        if (drawerContent == null) return;
        drawerContent.removeAllViews();
        for (final Screens.Screen s : Screens.all(this)) {
            TextView item = new TextView(this);
            item.setText(s.name);
            item.setTextSize(15f);
            item.setPadding(dp(6), dp(14), dp(6), dp(14));
            item.setTextColor(s.id.equals(currentId) ? tokens.primary : tokens.onSurface);
            item.setContentDescription(s.name);
            item.setClickable(true);
            item.setFocusable(true);
            item.setOnClickListener(v -> { goTo(s.id); if (drawer != null) drawer.closeDrawers(); });
            drawerContent.addView(item);
        }
    }\n` : ''}

    @Override public void openDrawer() {
${hasDrawer ? '        if (drawer != null) drawer.openDrawer(GravityCompat.START);' : '        // No side menu is configured for this project.'}
    }

    @Override public boolean goBack() {
        if (history.isEmpty()) return false;
        String previous = history.remove(history.size() - 1);
        // currentId is left alone here; showScreen compares against it and would
        // otherwise push the screen we are returning to back onto the stack.
        String here = currentId;
        currentId = null;
        showScreen(previous);
        if (here != null && !here.equals(previous)) { /* history already popped */ }
        return true;
    }

    @Override public void setThemeMode(String mode) {
        getSharedPreferences(THEME_PREF, MODE_PRIVATE).edit().putString("mode", mode).apply();
        recreate();
    }

    /** The screen the app opens on, which the first tab leads back to. */
    private String firstTabId() {
        for (Screens.Screen s : Screens.all(this)) if (s.showInTabs) return s.id;
        return null;
    }

    @Override
    public void onBackPressed() {
${hasDrawer ? `        if (drawer != null && drawer.isDrawerOpen(GravityCompat.START)) { drawer.closeDrawers(); return; }\n` : ''}${hasBottomNav ? `        // Back from any tab returns to the first one, which is what every
        // Android app with a tab bar does. Only from the first tab does back
        // leave the app. Without this, one tap on a tab and back closes the
        // app, which reads as a crash even though it is not one.
        String first = firstTabId();
        if (first != null && !first.equals(currentId)) { goTo(first); return; }
` : ''}        if (goBack()) return;
        super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putString("screen", currentId);
    }

    private int dp(int v) {
        return Math.round(android.util.TypedValue.applyDimension(
                android.util.TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
`;
}
