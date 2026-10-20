-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-dontwarn android.webkit.**

# 💰/🔔 conditional SDKs — reflection से चलते हैं; present हो तो safe रखो, absent हो तो warn न करो
-keep class com.google.android.gms.ads.** { *; }
-keep class com.onesignal.** { *; }
-dontwarn com.google.android.gms.ads.**
-dontwarn com.onesignal.**
