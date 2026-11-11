package com.gblink.bridge;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Asks Android for access to a USB device, once per plug-in: a refusal holds until it is replugged. */
final class UsbAccess {

    interface Result {
        void granted();

        void refused();
    }

    private static UsbAccess instance;

    private final Context context;
    private final UsbManager manager;
    private final String action;
    private final Map<String, List<Result>> waiting = new HashMap<>();
    private final Set<String> refused = new HashSet<>();

    static synchronized UsbAccess get(Context context) {
        if (instance == null) instance = new UsbAccess(context.getApplicationContext());
        return instance;
    }

    private UsbAccess(Context context) {
        this.context = context;
        this.manager = context.getSystemService(UsbManager.class);
        this.action = context.getPackageName() + ".USB_PERMISSION";
        IntentFilter filter = new IntentFilter(action);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        ContextCompat.registerReceiver(
            context,
            new BroadcastReceiver() {
                @Override
                public void onReceive(Context c, Intent intent) {
                    UsbDevice device = deviceOf(intent);
                    if (device == null) return;
                    if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction())) {
                        forget(device.getDeviceName());
                    } else {
                        answered(device.getDeviceName(), intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false));
                    }
                }
            },
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    UsbManager manager() {
        return manager;
    }

    void request(UsbDevice device, Result result) {
        String name = device.getDeviceName();
        if (manager.hasPermission(device)) {
            result.granted();
            return;
        }
        synchronized (this) {
            if (refused.contains(name)) {
                result.refused();
                return;
            }
            List<Result> pending = waiting.get(name);
            if (pending != null) {
                pending.add(result);
                return;
            }
            pending = new ArrayList<>();
            pending.add(result);
            waiting.put(name, pending);
        }
        Intent intent = new Intent(action).setPackage(context.getPackageName());
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        manager.requestPermission(device, PendingIntent.getBroadcast(context, 0, intent, flags));
    }

    private void answered(String name, boolean granted) {
        List<Result> pending;
        synchronized (this) {
            pending = waiting.remove(name);
            if (!granted) refused.add(name);
        }
        if (pending == null) return;
        for (Result result : pending) {
            if (granted) result.granted();
            else result.refused();
        }
    }

    private void forget(String name) {
        List<Result> pending;
        synchronized (this) {
            refused.remove(name);
            pending = waiting.remove(name);
        }
        if (pending == null) return;
        for (Result result : pending) result.refused();
    }

    @SuppressWarnings("deprecation")
    static UsbDevice deviceOf(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class);
        }
        return intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
    }
}
