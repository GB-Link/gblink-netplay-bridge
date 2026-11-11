package com.gblink.bridge;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.view.WindowManager;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Links, the clipboard, and what a running session needs from the phone. */
@CapacitorPlugin(name = "AppShell")
public class AppShellPlugin extends Plugin {

    private WifiManager.WifiLock wifiLock;

    /** Back goes to the page, which closes an open panel or calls moveToBack. */
    @Override
    public void load() {
        getActivity()
            .runOnUiThread(() ->
                getActivity()
                    .getOnBackPressedDispatcher()
                    .addCallback(
                        getActivity(),
                        new OnBackPressedCallback(true) {
                            @Override
                            public void handleOnBackPressed() {
                                notifyListeners("backButton", new JSObject());
                            }
                        }
                    )
            );
    }

    /** Leaves the app running behind the home screen; finishing it would end a session. */
    @PluginMethod
    public void moveToBack(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().moveTaskToBack(true);
            call.resolve();
        });
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("url", "")));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no app can open this link");
        }
    }

    @PluginMethod
    public void copyText(PluginCall call) {
        String text = call.getString("text", "");
        getActivity()
            .runOnUiThread(() -> {
                ClipboardManager clipboard = getContext().getSystemService(ClipboardManager.class);
                clipboard.setPrimaryClip(ClipData.newPlainText("GBLink Netplay Bridge", text));
                call.resolve();
            });
    }

    /**
     * The engine runs in the page, which Android slows down once the screen goes off; Wi-Fi power
     * saving delays packets too. Both are held off while a session runs.
     */
    @PluginMethod
    public void setSessionActive(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        getActivity()
            .runOnUiThread(() -> {
                if (active) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                holdWifi(active);
                call.resolve();
            });
    }

    @Override
    protected void handleOnDestroy() {
        holdWifi(false);
    }

    @SuppressWarnings("deprecation")
    private void holdWifi(boolean hold) {
        if (hold && wifiLock == null) {
            WifiManager wifi = getContext().getApplicationContext().getSystemService(WifiManager.class);
            if (wifi == null) return;
            int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wifi.createWifiLock(mode, "gblink-session");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        } else if (!hold && wifiLock != null) {
            if (wifiLock.isHeld()) wifiLock.release();
            wifiLock = null;
        }
    }
}
