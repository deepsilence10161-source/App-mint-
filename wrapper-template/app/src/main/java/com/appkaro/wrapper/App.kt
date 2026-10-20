package com.appkaro.wrapper

import android.app.Application
import android.content.Context
import android.util.Log

/**
 * ⚡ AppKaro Application — conditional SDK bootstrap
 *
 *  🔔 OneSignal push: सिर्फ़ तब जब builder में app id दिया हो।
 *  SDK इसलिए reflection से चलती है — id खाली हो तो SDK compile में ही
 *  नहीं आती (build.gradle conditional) → direct reference से build टूट जाती,
 *  इसलिए runtime class lookup + सब कुछ runCatching में।
 */
class App : Application() {

    override fun onCreate() {
        super.onCreate()
        initPushIfEnabled()
    }

    private fun initPushIfEnabled() {
        val appId = BuildConfig.PUSH_APP_ID
        if (appId.isEmpty()) return
        runCatching {
            val oneSignal = Class.forName("com.onesignal.OneSignal")
            /* v5 API: OneSignal.initWithContext(context, "APP_ID") */
            oneSignal
                .getMethod("initWithContext", Context::class.java, String::class.java)
                .invoke(null, this, appId)
            Log.i("AppKaro", "🔔 OneSignal push चालू (id: ${appId.take(8)}…)")
        }.onFailure {
            Log.w("AppKaro", "🔔 push SDK init skip: ${it.message}")
        }
    }
}
