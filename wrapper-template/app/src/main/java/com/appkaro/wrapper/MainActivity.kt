package com.appkaro.wrapper

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.graphics.ColorUtils
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.WindowInsetsControllerCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/**
 * ⚡ AppKaro MainActivity — competitor audit से सीखकर बना modern shell:
 *
 *  · edge-to-edge + SplashScreen + predictive back   (AppMint: कुछ नहीं)
 *  · hardened WebView: no file/universal access, mixed content BLOCK
 *  · pull-to-refresh, progress bar, offline error + retry
 *  · file upload + download (DownloadManager)
 *  · tel:/mailto:/intent: सही handle
 *  · theme color से status-bar contrast auto
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var errorView: View
    private var brand: Int = Color.parseColor("#6C5CE7")
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val cb = filePathCallback ?: return@registerForActivityResult
            val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            cb.onReceiveValue(uris)
            filePathCallback = null
        }

    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            if (webView.canGoBack()) webView.goBack()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        brand = runCatching { Color.parseColor(BuildConfig.THEME_COLOR) }
            .getOrDefault(Color.parseColor("#6C5CE7"))

        // status/nav icons: theme की luminance के हिसाब से
        val light = ColorUtils.calculateLuminance(brand) > 0.5
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = light
            isAppearanceLightNavigationBars = light
        }

        buildUi()

        // http:// + cleartext बिना अनुमति → साफ़ कारण के साथ रोक (AppMint ने चुपचाप खुला रखा)
        if (BuildConfig.START_URL.startsWith("http://") && !BuildConfig.ALLOW_CLEARTEXT) {
            showError("यह site असुरक्षित (http) है।\nऐसी sites के लिए builder में 'cleartext allow' विकल्प चुनना होगा।")
            return
        }

        webView.loadUrl(BuildConfig.START_URL)
        onBackPressedDispatcher.addCallback(this, backCallback)
    }

    private fun buildUi() {
        val root = FrameLayout(this)

        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP
            )
            progressDrawable.setTint(brand)
            visibility = View.GONE
        }

        webView = WebView(this)
        configureWebView()

        swipe = SwipeRefreshLayout(this).apply {
            setColorSchemeColors(brand)
            addView(webView)
            setOnRefreshListener { webView.reload() }
        }

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(progress)
            addView(swipe, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }

        errorView = buildErrorView()

        root.addView(column)
        root.addView(errorView)
        setContentView(root)
    }

    private fun buildErrorView(): View {
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
            setBackgroundColor(Color.WHITE)
            visibility = View.GONE
        }
        val emoji = TextView(this).apply {
            text = "📡"; textSize = 46f; gravity = Gravity.CENTER
        }
        val msg = TextView(this).apply {
            id = View.generateViewId(); textSize = 16f; setTextColor(Color.parseColor("#333"))
            gravity = Gravity.CENTER; setPadding(0, dp(16), 0, dp(24))
            tag = "msg"
        }
        val retry = Button(this).apply {
            text = "फिर से कोशिश करें"; setBackgroundColor(brand); setTextColor(Color.WHITE)
            setOnClickListener {
                errorView.visibility = View.GONE
                webView.reload()
            }
        }
        wrap.addView(emoji)
        wrap.addView(msg)
        wrap.addView(retry)
        return wrap
    }

    private fun showError(text: String) {
        (errorView.findViewWithTag<TextView>("msg"))?.text = text
        errorView.visibility = View.VISIBLE
    }

    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true                 // wrapper के लिए आवश्यक
            domStorageEnabled = true
            loadsImagesAutomatically = true
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW   // AppMint: ALLOW था ❌
            allowFileAccess = false                  // AppMint: true था ❌
            allowContentAccess = false
            builtInZoomControls = true
            displayZoomControls = false
            userAgentString = "$userAgentString AppKaro/1.0"
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.addJavascriptInterface(AppBridge(), "AppKaro")

        webView.webViewClient = object : WebViewClient() {

            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean {
                val url = request.url
                return when (url.scheme?.lowercase()) {
                    null, "http", "https" -> false
                    "tel", "mailto", "sms" -> {
                        runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                        true
                    }
                    "intent" -> {
                        runCatching {
                            startActivity(Intent.parseUri(url.toString(), Intent.URI_INTENT_SCHEME))
                        }
                        true
                    }
                    else -> true // अज्ञात scheme: WebView में नहीं
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                errorView.visibility = View.GONE
                progress.visibility = View.VISIBLE
                progress.progress = 0
            }

            override fun onPageFinished(view: WebView, url: String?) {
                progress.visibility = View.GONE
                swipe.isRefreshing = false
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    progress.visibility = View.GONE
                    swipe.isRefreshing = false
                    showError("पेज नहीं खुल पाया 😕\nइंटरनेट कनेक्शन जाँचें और फिर कोशिश करें।")
                }
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                backCallback.isEnabled = webView.canGoBack()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {

            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                if (newProgress >= 100) progress.visibility = View.GONE
            }

            // <input type="file"> — AppMint apps में अक्सर टूटा होता है
            override fun onShowFileChooser(
                wv: WebView,
                cb: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = cb
                return try {
                    fileChooserLauncher.launch(params.createIntent())
                    true
                } catch (e: ActivityNotFoundException) {
                    filePathCallback = null
                    false
                }
            }

            // camera/mic streaming — सिर्फ़ तब grant जब manifest में permission हो
            override fun onPermissionRequest(request: PermissionRequest) {
                val granted = request.resources.filter { res ->
                    val perm = when (res) {
                        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> android.Manifest.permission.CAMERA
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> android.Manifest.permission.RECORD_AUDIO
                        else -> null
                    }
                    perm != null && checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED
                }
                if (granted.isNotEmpty()) request.grant(granted.toTypedArray())
                else request.deny()
            }
        }

        // डाउनलोड — DownloadManager से, notification के साथ
        webView.setDownloadListener(DownloadListener { url, ua, contentDisposition, mime, _ ->
            runCatching {
                val req = DownloadManager.Request(Uri.parse(url)).apply {
                    addRequestHeader("User-Agent", ua)
                    addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url))
                    setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                    )
                    setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        URLUtil.guessFileName(url, contentDisposition, mime)
                    )
                }
                getSystemService(DownloadManager::class.java)?.enqueue(req)
                Toast.makeText(this, "⬇️ डाउनलोड शुरू", Toast.LENGTH_SHORT).show()
            }
        })
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /** Site के लिए छोटा native bridge — AppMint के unsafe bridge की जगह सीमित, सुरक्षित */
    inner class AppBridge {
        @JavascriptInterface
        fun getAppVersion(): String = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0"
        } catch (e: Exception) { "1.0" }

        @JavascriptInterface
        fun getAppName(): String = BuildConfig.APP_NAME

        @JavascriptInterface
        fun showToast(message: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            }
        }
    }
}
