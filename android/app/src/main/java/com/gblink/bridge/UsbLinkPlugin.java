package com.gblink.bridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.hardware.usb.UsbRequest;
import android.os.Process;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

/** The GB-Link's vendor interface 0: commands and data go out on 0x01 and 0x02, status and data come in on 0x81 and 0x82. */
@CapacitorPlugin(name = "UsbLink")
public class UsbLinkPlugin extends Plugin {

    private static final int[] IN_ENDPOINTS = { 0x81, 0x82 };
    private static final int[] OUT_ENDPOINTS = { 0x01, 0x02 };
    /** Transfers kept queued per IN endpoint, as on the desktop. */
    private static final int QUEUED_READS = 2;
    private static final int PACKET_SIZE = 64;
    /** How often an idle reader looks up to see whether its link was closed. */
    private static final long READ_WAIT_MS = 100;

    private UsbAccess access;
    private BroadcastReceiver hotplug;
    private final Map<Integer, Link> links = new ConcurrentHashMap<>();
    private final AtomicInteger nextHandle = new AtomicInteger(1);
    /** Opens and closes run one at a time, so a reopen never races the close before it. */
    private final ExecutorService opener = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        access = UsbAccess.get(getContext());
        hotplug = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                UsbDevice device = UsbAccess.deviceOf(intent);
                if (device == null) return;
                boolean attached = UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(intent.getAction());
                notifyListeners(attached ? "attach" : "detach", entry(device));
            }
        };
        IntentFilter filter = new IntentFilter(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        ContextCompat.registerReceiver(getContext(), hotplug, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        getContext().unregisterReceiver(hotplug);
        for (Link link : links.values()) link.close();
        links.clear();
        opener.shutdown();
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray devices = new JSArray();
        for (UsbDevice device : access.manager().getDeviceList().values()) devices.put(entry(device));
        JSObject ret = new JSObject();
        ret.put("devices", devices);
        call.resolve(ret);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String name = call.getString("name", "");
        UsbDevice device = access.manager().getDeviceList().get(name);
        if (device == null) {
            call.reject("the GB-Link is no longer plugged in");
            return;
        }
        access.request(
            device,
            new UsbAccess.Result() {
                @Override
                public void granted() {
                    opener.execute(() -> openGranted(call, device));
                }

                @Override
                public void refused() {
                    call.reject("Android did not allow access to the GB-Link. Unplug it, plug it back in and allow access.");
                }
            }
        );
    }

    private void openGranted(PluginCall call, UsbDevice device) {
        UsbManager manager = access.manager();
        UsbDeviceConnection connection = manager.openDevice(device);
        if (connection == null) {
            call.reject("Android could not open the GB-Link");
            return;
        }
        if (device.getInterfaceCount() == 0) {
            connection.close();
            call.reject("the GB-Link shows no USB interface");
            return;
        }
        UsbInterface iface = device.getInterface(0);
        if (!connection.claimInterface(iface, true)) {
            connection.close();
            call.reject("cannot claim the GB-Link's interface: another app may be using it");
            return;
        }
        UsbEndpoint[] endpoints = new UsbEndpoint[256];
        for (int i = 0; i < iface.getEndpointCount(); i++) {
            UsbEndpoint ep = iface.getEndpoint(i);
            if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK) endpoints[ep.getAddress()] = ep;
        }
        for (int address : concat(IN_ENDPOINTS, OUT_ENDPOINTS)) {
            if (endpoints[address] == null) {
                connection.releaseInterface(iface);
                connection.close();
                call.reject(String.format("bulk endpoint 0x%02x missing on interface 0", address));
                return;
            }
        }
        int handle = nextHandle.getAndIncrement();
        Link link = new Link(handle, connection, iface, endpoints);
        links.put(handle, link);
        JSObject ret = new JSObject();
        ret.put("handle", handle);
        call.resolve(ret);
        // Reads start after the handle is known, so none arrives for a handle the page has not seen.
        link.start();
    }

    @PluginMethod
    public void write(PluginCall call) {
        Link link = links.get(call.getInt("handle", 0));
        if (link == null) {
            call.reject("UsbTransport is not open");
            return;
        }
        link.write(call.getInt("endpoint", 0), Base64.decode(call.getString("data", ""), Base64.DEFAULT), call);
    }

    @PluginMethod
    public void close(PluginCall call) {
        Link link = links.remove(call.getInt("handle", 0));
        if (link == null) {
            call.resolve();
            return;
        }
        opener.execute(() -> {
            link.close();
            call.resolve();
        });
    }

    private static JSObject entry(UsbDevice device) {
        JSObject e = new JSObject();
        e.put("name", device.getDeviceName());
        e.put("vendorId", device.getVendorId());
        e.put("productId", device.getProductId());
        return e;
    }

    private static int[] concat(int[] a, int[] b) {
        int[] out = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    /** One open GB-Link: a reader for both IN endpoints, and one writer per OUT endpoint so its transfers never overlap. */
    private final class Link {

        final int handle;
        final UsbDeviceConnection connection;
        final UsbInterface iface;
        final UsbEndpoint[] endpoints;
        final Map<Integer, ExecutorService> writers = new ConcurrentHashMap<>();
        final Thread reader;
        volatile boolean closed;
        private boolean released;

        Link(int handle, UsbDeviceConnection connection, UsbInterface iface, UsbEndpoint[] endpoints) {
            this.handle = handle;
            this.connection = connection;
            this.iface = iface;
            this.endpoints = endpoints;
            for (int address : OUT_ENDPOINTS) writers.put(address, Executors.newSingleThreadExecutor());
            reader = new Thread(this::read, "gblink-usb-in");
        }

        void start() {
            reader.start();
        }

        void write(int address, byte[] data, PluginCall call) {
            ExecutorService writer = writers.get(address);
            if (writer == null) {
                call.reject(String.format("no OUT endpoint 0x%02x", address));
                return;
            }
            try {
                writer.execute(() -> {
                    if (closed) {
                        call.reject("UsbTransport is not open");
                        return;
                    }
                    int sent = connection.bulkTransfer(endpoints[address], data, data.length, 0);
                    if (sent < 0) call.reject(String.format("transfer to endpoint 0x%02x failed", address));
                    else call.resolve();
                });
            } catch (java.util.concurrent.RejectedExecutionException e) {
                call.reject("UsbTransport is not open");
            }
        }

        private void read() {
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
            List<UsbRequest> requests = new ArrayList<>();
            String failure = null;
            try {
                for (int address : IN_ENDPOINTS) {
                    for (int i = 0; i < QUEUED_READS; i++) {
                        UsbRequest request = new UsbRequest();
                        if (!request.initialize(connection, endpoints[address])) throw new IllegalStateException("cannot read the GB-Link");
                        requests.add(request);
                        ByteBuffer buffer = ByteBuffer.allocate(PACKET_SIZE);
                        request.setClientData(buffer);
                        if (!request.queue(buffer)) throw new IllegalStateException("cannot read the GB-Link");
                    }
                }
                while (!closed) {
                    UsbRequest done;
                    try {
                        done = connection.requestWait(READ_WAIT_MS);
                    } catch (TimeoutException e) {
                        continue;
                    }
                    if (done == null) throw new IllegalStateException("reading from the GB-Link stopped");
                    ByteBuffer buffer = (ByteBuffer) done.getClientData();
                    int length = buffer.position();
                    if (length > 0 && !closed) {
                        JSObject e = new JSObject();
                        e.put("handle", handle);
                        e.put("endpoint", done.getEndpoint().getAddress());
                        e.put("data", Base64.encodeToString(buffer.array(), 0, length, Base64.NO_WRAP));
                        notifyListeners("data", e);
                    }
                    buffer.clear();
                    if (!closed && !done.queue(buffer)) throw new IllegalStateException("reading from the GB-Link stopped");
                }
            } catch (RuntimeException e) {
                failure = e.getMessage();
            } finally {
                for (UsbRequest request : requests) {
                    try {
                        request.cancel();
                        request.close();
                    } catch (RuntimeException ignored) {
                        // the connection is already gone
                    }
                }
            }
            if (!closed && links.remove(handle) != null) {
                release();
                JSObject e = new JSObject();
                e.put("handle", handle);
                e.put("reason", failure == null ? "reading stopped" : failure);
                notifyListeners("lost", e);
            }
        }

        void close() {
            closed = true;
            if (Thread.currentThread() != reader && reader.isAlive()) {
                try {
                    reader.join(READ_WAIT_MS * 3);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            release();
        }

        private synchronized void release() {
            closed = true;
            if (released) return;
            released = true;
            for (ExecutorService writer : writers.values()) {
                for (Runnable pending : writer.shutdownNow()) pending.run();
            }
            connection.releaseInterface(iface);
            connection.close();
        }
    }
}
