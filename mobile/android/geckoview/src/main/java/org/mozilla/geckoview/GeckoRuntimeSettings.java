/* -*- Mode: Java; c-basic-offset: 4; tab-width: 20; indent-tabs-mode: nil; -*-
 * vim: ts=4 sw=4 expandtab:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.geckoview;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

import android.graphics.Rect;
import android.os.Bundle;
import android.os.Parcel;
import android.os.Parcelable;
import android.support.annotation.IntDef;
import android.support.annotation.NonNull;
import android.support.annotation.Nullable;

import org.mozilla.geckoview.GeckoSession.TrackingProtectionDelegate;

public final class GeckoRuntimeSettings implements Parcelable {
    /**
     * {@link #mExtras} key for the crash reporting job id.
     */
    public static final String EXTRA_CRASH_REPORTING_JOB_ID = "crashReporterJobId";

    /**
     * Settings builder used to construct the settings object.
     */
    public static final class Builder {
        private final GeckoRuntimeSettings mSettings;

        public Builder() {
            mSettings = new GeckoRuntimeSettings();
        }

        public Builder(final GeckoRuntimeSettings settings) {
            mSettings = new GeckoRuntimeSettings(settings);
        }

        /**
         * Finalize and return the settings.
         *
         * @return The constructed settings.
         */
        public @NonNull GeckoRuntimeSettings build() {
            return new GeckoRuntimeSettings(mSettings);
        }

        /**
         * Set the content process hint flag.
         *
         * @param use If true, this will reload the content process for future use.
         *            Default is false.
         * @return This Builder instance.

         */
        public @NonNull Builder useContentProcessHint(final boolean use) {
            mSettings.mUseContentProcess = use;
            return this;
        }

        /**
         * Set the custom Gecko process arguments.
         *
         * @param args The Gecko process arguments.
         * @return This Builder instance.
         */
        public @NonNull Builder arguments(final @NonNull String[] args) {
            if (args == null) {
                throw new IllegalArgumentException("Arguments must not  be null");
            }
            mSettings.mArgs = args;
            return this;
        }

        /**
         * Set the custom Gecko intent extras.
         *
         * @param extras The Gecko intent extras.
         * @return This Builder instance.
         */
        public @NonNull Builder extras(final @NonNull Bundle extras) {
            if (extras == null) {
                throw new IllegalArgumentException("Extras must not  be null");
            }
            mSettings.mExtras = extras;
            return this;
        }

        /**
         * Set whether JavaScript support should be enabled.
         *
         * @param flag A flag determining whether JavaScript should be enabled.
         *             Default is true.
         * @return This Builder instance.
         */
        public @NonNull Builder javaScriptEnabled(final boolean flag) {
            mSettings.mJavaScript.set(flag);
            return this;
        }

        /**
         * Set whether remote debugging support should be enabled.
         *
         * @param enabled True if remote debugging should be enabled.
         * @return This Builder instance.
         */
        public @NonNull Builder remoteDebuggingEnabled(final boolean enabled) {
            mSettings.mRemoteDebugging.set(enabled);
            return this;
        }

        /**
         * Set whether support for web fonts should be enabled.
         *
         * @param flag A flag determining whether web fonts should be enabled.
         *             Default is true.
         * @return This Builder instance.
         */
        public @NonNull Builder webFontsEnabled(final boolean flag) {
            mSettings.mWebFonts.set(flag);
            return this;
        }

        /**
         * Set whether crash reporting for native code should be enabled. This will cause
         * a SIGSEGV handler to be installed, and any crash encountered there will be
         * reported to Mozilla.
         *
         * <br>If crash reporting is enabled {@link #crashReportingJobId(int)} must also be used.
         *
         * @param enabled A flag determining whether native crash reporting should be enabled.
         *                Defaults to false.
         * @return This Builder.
         */
        public @NonNull Builder nativeCrashReportingEnabled(final boolean enabled) {
            mSettings.mNativeCrashReporting = enabled;
            return this;
        }

        /**
         * Set whether crash reporting for Java code should be enabled. This will cause
         * a default unhandled exception handler to be installed, and any exceptions encountered
         * will automatically reported to Mozilla.
         *
         * <br>If crash reporting is enabled {@link #crashReportingJobId(int)} must also be used.
         *
         * @param enabled A flag determining whether Java crash reporting should be enabled.
         *                Defaults to false.
         * @return This Builder.
         */
        public @NonNull Builder javaCrashReportingEnabled(final boolean enabled) {
            mSettings.mJavaCrashReporting = enabled;
            return this;
        }

        /**
         * On Oreo and later devices we use the JobScheduler for crash reporting in the background.<br>
         * This allows for setting the unique Job Id to be used.
         * <a href="https://developer.android.com/reference/android/app/job/JobInfo.Builder#JobInfo.Builder(int,%20android.content.ComponentName)">
         *           See why it must be unique</a>
         *
         * @param id A unique integer.
         *
         * @return This Builder.
         */
        public @NonNull Builder crashReportingJobId(final int id) {
            mSettings.mCrashReportingJobId = id;
            return this;
        }

        /**
         * Set whether there should be a pause during startup. This is useful if you need to
         * wait for a debugger to attach.
         *
         * @param enabled A flag determining whether there will be a pause early in startup.
         *                Defaults to false.
         * @return This Builder.
         */
        public @NonNull Builder pauseForDebugger(boolean enabled) {
            mSettings.mDebugPause = enabled;
            return this;
        }

        /**
         * Set cookie storage behavior.
         *
         * @param behavior The storage behavior that should be applied.
         *                 Use one of the {@link #COOKIE_ACCEPT_ALL COOKIE_ACCEPT_*} flags.
         * @return The Builder instance.
         */
        public @NonNull Builder cookieBehavior(@CookieBehavior int behavior) {
            mSettings.mCookieBehavior.set(behavior);
            return this;
        }

        /**
         * Set the cookie lifetime.
         *
         * @param lifetime The enforced cookie lifetime.
         *                 Use one of the {@link #COOKIE_LIFETIME_NORMAL COOKIE_LIFETIME_*} flags.
         * @return The Builder instance.
         */
        public @NonNull Builder cookieLifetime(@CookieLifetime int lifetime) {
            mSettings.mCookieLifetime.set(lifetime);
            return this;
        }

        /**
         * Set tracking protection blocking categories.
         *
         * @param categories The categories of trackers that should be blocked.
         *                   Use one or more of the
         *                   {@link TrackingProtectionDelegate#CATEGORY_AD TrackingProtectionDelegate.CATEGORY_*} flags.
         * @return This Builder instance.
         **/
        public @NonNull Builder trackingProtectionCategories(
                @TrackingProtectionDelegate.Category int categories) {
            mSettings.mTrackingProtection
                     .set(TrackingProtection.buildPrefValue(categories));
            return this;
        }

        /**
         * Set whether or not web console messages should go to logcat.
         *
         * Note: If enabled, Gecko performance may be negatively impacted if
         * content makes heavy use of the console API.
         *
         * @param enabled A flag determining whether or not web console messages should be
         *                printed to logcat.
         * @return The builder instance.
         */
        public @NonNull Builder consoleOutput(boolean enabled) {
            mSettings.mConsoleOutput.set(enabled);
            return this;
        }

        /**
         * Set the display density override.
         *
         * @param density The display density value to use for overriding the system default.
         * @return The builder instance.
         */
        public @NonNull Builder displayDensityOverride(float density) {
            mSettings.mDisplayDensityOverride = density;
            return this;
        }

        /** Set whether or not known malware sites should be blocked.
         *
         * Note: For each blocked site, {@link NavigationDelegate#onLoadError}
         * with error category {@link NavigationDelegate#ERROR_CATEGORY_SAFEBROWSING}
         * is called.
         *
         * @param enabled A flag determining whether or not to block malware
         *                sites.
         * @return The builder instance.
         */
        public @NonNull Builder blockMalware(boolean enabled) {
            mSettings.mSafebrowsingMalware.set(enabled);
            return this;
        }

        /**
         * Set whether or not known phishing sites should be blocked.
         *
         * Note: For each blocked site, {@link NavigationDelegate#onLoadError}
         * with error category {@link NavigationDelegate#ERROR_CATEGORY_SAFEBROWSING}
         * is called.
         *
         * @param enabled A flag determining whether or not to block phishing
         *                sites.
         * @return The builder instance.
         */
        public @NonNull Builder blockPhishing(boolean enabled) {
            mSettings.mSafebrowsingPhishing.set(enabled);
            return this;
        }

        /**
         * Set the display DPI override.
         *
         * @param dpi The display DPI value to use for overriding the system default.
         * @return The builder instance.
         */
        public @NonNull Builder displayDpiOverride(int dpi) {
            mSettings.mDisplayDpiOverride = dpi;
            return this;
        }

        /**
         * Set the screen size override.
         *
         * @param width The screen width value to use for overriding the system default.
         * @param height The screen height value to use for overriding the system default.
         * @return The builder instance.
         */
        public @NonNull Builder screenSizeOverride(int width, int height) {
            mSettings.mScreenWidthOverride = width;
            mSettings.mScreenHeightOverride = height;
            return this;
        }
    }

    /* package */ GeckoRuntime runtime;
    /* package */ boolean mUseContentProcess;
    /* package */ String[] mArgs;
    /* package */ Bundle mExtras;
    /* package */ int prefCount;

    private class Pref<T> {
        public final String name;
        public final T defaultValue;
        private T mValue;
        private boolean mIsSet;

        public Pref(final String name, final T defaultValue) {
            GeckoRuntimeSettings.this.prefCount++;

            this.name = name;
            this.defaultValue = defaultValue;
            mValue = defaultValue;
        }

        public void set(T newValue) {
            mValue = newValue;
            mIsSet = true;
            flush();
        }

        public T get() {
            return mValue;
        }

        public void flush() {
            if (GeckoRuntimeSettings.this.runtime != null) {
                GeckoRuntimeSettings.this.runtime.setPref(name, mValue, mIsSet);
            }
        }
    }

    /* package */ Pref<Boolean> mJavaScript = new Pref<Boolean>(
        "javascript.enabled", true);
    /* package */ Pref<Boolean> mRemoteDebugging = new Pref<Boolean>(
        "devtools.debugger.remote-enabled", false);
    /* package */ Pref<Boolean> mWebFonts = new Pref<Boolean>(
        "browser.display.use_document_fonts", true);
    /* package */ Pref<Integer> mCookieBehavior = new Pref<Integer>(
        "network.cookie.cookieBehavior", COOKIE_ACCEPT_ALL);
    /* package */ Pref<Integer> mCookieLifetime = new Pref<Integer>(
        "network.cookie.lifetimePolicy", COOKIE_LIFETIME_NORMAL);
    /* package */ Pref<String> mTrackingProtection = new Pref<String>(
        "urlclassifier.trackingTable",
        TrackingProtection.buildPrefValue(
            TrackingProtectionDelegate.CATEGORY_TEST |
            TrackingProtectionDelegate.CATEGORY_ANALYTIC |
            TrackingProtectionDelegate.CATEGORY_SOCIAL |
            TrackingProtectionDelegate.CATEGORY_AD));
    /* package */ Pref<Boolean> mConsoleOutput = new Pref<Boolean>(
        "geckoview.console.enabled", false);
    /* package */ Pref<Boolean> mSafebrowsingMalware = new Pref<Boolean>(
        "browser.safebrowsing.malware.enabled", true);
    /* package */ Pref<Boolean> mSafebrowsingPhishing = new Pref<Boolean>(
        "browser.safebrowsing.phishing.enabled", true);

    /* package */ boolean mNativeCrashReporting;
    /* package */ boolean mJavaCrashReporting;
    /* package */ int mCrashReportingJobId;
    /* package */ boolean mDebugPause;
    /* package */ float mDisplayDensityOverride = -1.0f;
    /* package */ int mDisplayDpiOverride;
    /* package */ int mScreenWidthOverride;
    /* package */ int mScreenHeightOverride;

    private final Pref<?>[] mPrefs = new Pref<?>[] {
        mCookieBehavior, mCookieLifetime, mConsoleOutput,
        mJavaScript, mRemoteDebugging, mSafebrowsingMalware,
        mSafebrowsingPhishing, mTrackingProtection, mWebFonts,
    };

    /* package */ GeckoRuntimeSettings() {
        this(null);
    }

    /* package */ GeckoRuntimeSettings(final @Nullable GeckoRuntimeSettings settings) {
        if (BuildConfig.DEBUG && prefCount != mPrefs.length) {
            throw new AssertionError("Add new pref to prefs list");
        }

        if (settings == null) {
            mArgs = new String[0];
            mExtras = new Bundle();
            return;
        }

        mUseContentProcess = settings.getUseContentProcessHint();
        mArgs = settings.getArguments().clone();
        mExtras = new Bundle(settings.getExtras());

        for (int i = 0; i < mPrefs.length; i++) {
            if (!settings.mPrefs[i].mIsSet) {
                continue;
            }
            // We know this is safe.
            @SuppressWarnings("unchecked")
            final Pref<Object> uncheckedPref = (Pref<Object>) mPrefs[i];
            uncheckedPref.set(settings.mPrefs[i].get());
        }

        mNativeCrashReporting = settings.mNativeCrashReporting;
        mJavaCrashReporting = settings.mJavaCrashReporting;
        mCrashReportingJobId = settings.mCrashReportingJobId;
        mDebugPause = settings.mDebugPause;
        mDisplayDensityOverride = settings.mDisplayDensityOverride;
        mDisplayDpiOverride = settings.mDisplayDpiOverride;
        mScreenWidthOverride = settings.mScreenWidthOverride;
        mScreenHeightOverride = settings.mScreenHeightOverride;
    }

    /* package */ void flush() {
        for (final Pref<?> pref: mPrefs) {
            pref.flush();
        }
    }

    /**
     * Get the content process hint flag.
     *
     * @return The content process hint flag.
     */
    public boolean getUseContentProcessHint() {
        return mUseContentProcess;
    }

    /**
     * Get the custom Gecko process arguments.
     *
     * @return The Gecko process arguments.
     */
    public String[] getArguments() {
        return mArgs;
    }

    /**
     * Get the custom Gecko intent extras.
     *
     * @return The Gecko intent extras.
     */
    public Bundle getExtras() {
        return mExtras;
    }

    /**
     * Get whether JavaScript support is enabled.
     *
     * @return Whether JavaScript support is enabled.
     */
    public boolean getJavaScriptEnabled() {
        return mJavaScript.get();
    }

    /**
     * Set whether JavaScript support should be enabled.
     *
     * @param flag A flag determining whether JavaScript should be enabled.
     * @return This GeckoRuntimeSettings instance.
     */
    public @NonNull GeckoRuntimeSettings setJavaScriptEnabled(final boolean flag) {
        mJavaScript.set(flag);
        return this;
    }

    /**
     * Get whether remote debugging support is enabled.
     *
     * @return True if remote debugging support is enabled.
     */
    public boolean getRemoteDebuggingEnabled() {
        return mRemoteDebugging.get();
    }

    /**
     * Set whether remote debugging support should be enabled.
     *
     * @param enabled True if remote debugging should be enabled.
     * @return This GeckoRuntimeSettings instance.
     */
    public @NonNull GeckoRuntimeSettings setRemoteDebuggingEnabled(final boolean enabled) {
        mRemoteDebugging.set(enabled);
        return this;
    }

    /**
     * Get whether web fonts support is enabled.
     *
     * @return Whether web fonts support is enabled.
     */
    public boolean getWebFontsEnabled() {
        return mWebFonts.get();
    }

    /**
     * Set whether support for web fonts should be enabled.
     *
     * @param flag A flag determining whether web fonts should be enabled.
     * @return This GeckoRuntimeSettings instance.
     */
    public @NonNull GeckoRuntimeSettings setWebFontsEnabled(final boolean flag) {
        mWebFonts.set(flag);
        return this;
    }

    /**
     * Get whether native crash reporting is enabled or not.
     *
     * @return True if native crash reporting is enabled.
     */
    public boolean getNativeCrashReportingEnabled() {
        return mNativeCrashReporting;
    }

    /**
     * Get whether Java crash reporting is enabled or not.
     *
     * @return True if Java crash reporting is enabled.
     */
    public boolean getJavaCrashReportingEnabled() {
        return mJavaCrashReporting;
    }

    /**
     * Get the Job Id used on Oreo and later devices to manage crash reporting in background.
     */
    public int getCrashReportingServiceJobId() {
        return mCrashReportingJobId;
    }

    /**
     * Gets whether the pause-for-debugger is enabled or not.
     *
     * @return True if the pause is enabled.
     */
    public boolean getPauseForDebuggerEnabled() { return mDebugPause; }

    /**
     * Gets the display density override value.
     *
     * @return Returns a positive number. Will return null if not set.
     */
    public Float getDisplayDensityOverride() {
        if (mDisplayDensityOverride > 0.0f) {
            return mDisplayDensityOverride;
        }
        return null;
    }

    /**
     * Gets the display DPI override value.
     *
     * @return Returns a positive number. Will return null if not set.
     */
    public Integer getDisplayDpiOverride() {
        if (mDisplayDpiOverride > 0) {
            return mDisplayDpiOverride;
        }
        return null;
    }

    /**
     * Gets the screen size  override value.
     *
     * @return Returns a Rect containing the dimensions to use for the window size.
     * Will return null if not set.
     */
    public Rect getScreenSizeOverride() {
        if ((mScreenWidthOverride > 0) && (mScreenHeightOverride > 0)) {
            return new Rect(0, 0, mScreenWidthOverride, mScreenHeightOverride);
        }
        return null;
    }

    // Sync values with nsICookieService.idl.
    @Retention(RetentionPolicy.SOURCE)
    @IntDef({ COOKIE_ACCEPT_ALL, COOKIE_ACCEPT_FIRST_PARTY,
              COOKIE_ACCEPT_NONE, COOKIE_ACCEPT_VISITED })
    /* package */ @interface CookieBehavior {}

    /**
     * Accept first-party and third-party cookies and site data.
     */
    public static final int COOKIE_ACCEPT_ALL = 0;
    /**
     * Accept only first-party cookies and site data to block cookies which are
     * not associated with the domain of the visited site.
     */
    public static final int COOKIE_ACCEPT_FIRST_PARTY = 1;
    /**
     * Do not store any cookies and site data.
     */
    public static final int COOKIE_ACCEPT_NONE = 2;
    /**
     * Accept first-party and third-party cookies and site data only from
     * sites previously visited in a first-party context.
     */
    public static final int COOKIE_ACCEPT_VISITED = 3;

    /**
     * Get the assigned cookie storage behavior.
     *
     * @return The assigned behavior, as one of {@link #COOKIE_ACCEPT_ALL COOKIE_ACCEPT_*} flags.
     */
    public @CookieBehavior int getCookieBehavior() {
        return mCookieBehavior.get();
    }

    /**
     * Set cookie storage behavior.
     *
     * @param behavior The storage behavior that should be applied.
     *                 Use one of the {@link #COOKIE_ACCEPT_ALL COOKIE_ACCEPT_*} flags.
     * @return This GeckoRuntimeSettings instance.
     */
    public @NonNull GeckoRuntimeSettings setCookieBehavior(
            @CookieBehavior int behavior) {
        mCookieBehavior.set(behavior);
        return this;
    }

    // Sync values with nsICookieService.idl.
    @Retention(RetentionPolicy.SOURCE)
    @IntDef({ COOKIE_LIFETIME_NORMAL, COOKIE_LIFETIME_RUNTIME,
              COOKIE_LIFETIME_DAYS })
    /* package */ @interface CookieLifetime {}

    /**
     * Accept default cookie lifetime.
     */
    public static final int COOKIE_LIFETIME_NORMAL = 0;
    /**
     * Downgrade cookie lifetime to this runtime's lifetime.
     */
    public static final int COOKIE_LIFETIME_RUNTIME = 2;
    /**
     * Limit cookie lifetime to N days.
     * Defaults to 90 days.
     */
    public static final int COOKIE_LIFETIME_DAYS = 3;

    /**
     * Get the assigned cookie lifetime.
     *
     * @return The assigned lifetime, as one of {@link #COOKIE_LIFETIME_NORMAL COOKIE_LIFETIME_*} flags.
     */
    public @CookieBehavior int getCookieLifetime() {
        return mCookieLifetime.get();
    }

    /**
     * Set the cookie lifetime.
     *
     * @param lifetime The enforced cookie lifetime.
     *                 Use one of the {@link #COOKIE_LIFETIME_NORMAL COOKIE_LIFETIME_*} flags.
     * @return This GeckoRuntimeSettings instance.
     */
    public @NonNull GeckoRuntimeSettings setCookieLifetime(
            @CookieLifetime int lifetime) {
        mCookieLifetime.set(lifetime);
        return this;
    }

    /**
     * Get the set tracking protection blocking categories.
     *
     * @return categories The categories of trackers that are set to be blocked.
     *                    Use one or more of the
     *                    {@link TrackingProtectionDelegate#CATEGORY_AD TrackingProtectionDelegate.CATEGORY_*} flags.
     **/
    public @TrackingProtectionDelegate.Category int getTrackingProtectionCategories() {
        return TrackingProtection.listToCategory(mTrackingProtection.get());
    }

    /**
     * Set tracking protection blocking categories.
     *
     * @param categories The categories of trackers that should be blocked.
     *                   Use one or more of the
     *                   {@link TrackingProtectionDelegate#CATEGORY_AD TrackingProtectionDelegate.CATEGORY_*} flags.
     * @return This GeckoRuntimeSettings instance.
     **/
    public @NonNull GeckoRuntimeSettings setTrackingProtectionCategories(
            @TrackingProtectionDelegate.Category int categories) {
        mTrackingProtection.set(TrackingProtection.buildPrefValue(categories));
        return this;
    }

    /**
     * Set whether or not web console messages should go to logcat.
     *
     * Note: If enabled, Gecko performance may be negatively impacted if
     * content makes heavy use of the console API.
     *
     * @param enabled A flag determining whether or not web console messages should be
     *                printed to logcat.
     * @return This GeckoRuntimeSettings instance.
     */

    public @NonNull GeckoRuntimeSettings setConsoleOutputEnabled(boolean enabled) {
        mConsoleOutput.set(enabled);
        return this;
    }

    /**
     * Get whether or not web console messages are sent to logcat.
     *
     * @return True if console output is enabled.
     */
    public boolean getConsoleOutputEnabled() {
        return mConsoleOutput.get();
    }

    /**
     * Set whether or not known malware sites should be blocked.
     *
     * Note: For each blocked site, {@link NavigationDelegate#onLoadError}
     * with error category {@link NavigationDelegate#ERROR_CATEGORY_SAFEBROWSING}
     * is called.
     *
     * @param enabled A flag determining whether or not to block malware sites.
     * @return The GeckoRuntimeSettings instance.
     */
    public @NonNull GeckoRuntimeSettings setBlockMalware(boolean enabled) {
        mSafebrowsingMalware.set(enabled);
        return this;
    }

    /**
     * Get whether or not known malware sites are blocked.
     *
     * @return True if malware site blocking is enabled.
     */
    public boolean getBlockMalware() {
        return mSafebrowsingMalware.get();
    }

    /**
     * Set whether or not known phishing sites should be blocked.
     *
     * Note: For each blocked site, {@link NavigationDelegate#onLoadError}
     * with error category {@link NavigationDelegate#ERROR_CATEGORY_SAFEBROWSING}
     * is called.
     *
     * @param enabled A flag determining whether or not to block phishing sites.
     * @return The GeckoRuntimeSettings instance.
     */
    public @NonNull GeckoRuntimeSettings setBlockPhishing(boolean enabled) {
        mSafebrowsingPhishing.set(enabled);
        return this;
    }

    /**
     * Get whether or not known phishing sites are blocked.
     *
     * @return True if phishing site blocking is enabled.
     */
    public boolean getBlockPhishing() {
        return mSafebrowsingPhishing.get();
    }

    @Override // Parcelable
    public int describeContents() {
        return 0;
    }

    @Override // Parcelable
    public void writeToParcel(Parcel out, int flags) {
        ParcelableUtils.writeBoolean(out, mUseContentProcess);
        out.writeStringArray(mArgs);
        mExtras.writeToParcel(out, flags);

        for (final Pref<?> pref : mPrefs) {
            out.writeValue(pref.get());
        }

        ParcelableUtils.writeBoolean(out, mNativeCrashReporting);
        ParcelableUtils.writeBoolean(out, mJavaCrashReporting);
        out.writeInt(mCrashReportingJobId);
        ParcelableUtils.writeBoolean(out, mDebugPause);
        out.writeFloat(mDisplayDensityOverride);
        out.writeInt(mDisplayDpiOverride);
        out.writeInt(mScreenWidthOverride);
        out.writeInt(mScreenHeightOverride);
    }

    // AIDL code may call readFromParcel even though it's not part of Parcelable.
    public void readFromParcel(final Parcel source) {
        mUseContentProcess = ParcelableUtils.readBoolean(source);
        mArgs = source.createStringArray();
        mExtras.readFromParcel(source);

        for (final Pref<?> pref : mPrefs) {
            // We know this is safe.
            @SuppressWarnings("unchecked")
            final Pref<Object> uncheckedPref = (Pref<Object>) pref;
            uncheckedPref.set(source.readValue(getClass().getClassLoader()));
        }

        mNativeCrashReporting = ParcelableUtils.readBoolean(source);
        mJavaCrashReporting = ParcelableUtils.readBoolean(source);
        mCrashReportingJobId = source.readInt();
        mDebugPause = ParcelableUtils.readBoolean(source);
        mDisplayDensityOverride = source.readFloat();
        mDisplayDpiOverride = source.readInt();
        mScreenWidthOverride = source.readInt();
        mScreenHeightOverride = source.readInt();
    }

    public static final Parcelable.Creator<GeckoRuntimeSettings> CREATOR
        = new Parcelable.Creator<GeckoRuntimeSettings>() {
        @Override
        public GeckoRuntimeSettings createFromParcel(final Parcel in) {
            final GeckoRuntimeSettings settings = new GeckoRuntimeSettings();
            settings.readFromParcel(in);
            return settings;
        }

        @Override
        public GeckoRuntimeSettings[] newArray(final int size) {
            return new GeckoRuntimeSettings[size];
        }
    };
}
