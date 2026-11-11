package com.gblink.bridge;

import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;
import com.hoho.android.usbserial.util.SerialInputOutputManager;
import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicInteger;

/** USB serial ports, for the ESP32 bridge board: native USB boards and the usual USB-UART chips. */
@CapacitorPlugin(name = "SerialLink")
public class SerialLinkPlugin extends Plugin {

    private UsbAccess access;
    private final Map<Integer, Port> ports = new ConcurrentHashMap<>();
    private final AtomicInteger nextHandle = new AtomicInteger(1);
    private final ExecutorService opener = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        access = UsbAccess.get(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        for (Port port : ports.values()) port.close(null);
        ports.clear();
        opener.shutdown();
    }

    @PluginMethod
    public void list(PluginCall call) {
        UsbManager manager = access.manager();
        JSArray list = new JSArray();
        for (UsbSerialDriver driver : UsbSerialProber.getDefaultProber().findAllDrivers(manager)) {
            UsbDevice device = driver.getDevice();
            JSObject e = new JSObject();
            e.put("path", device.getDeviceName());
            e.put("vendorId", device.getVendorId());
            e.put("productId", device.getProductId());
            if (manager.hasPermission(device)) {
                try {
                    e.put("manufacturer", device.getManufacturerName());
                } catch (SecurityException ignored) {
                    // the name needs access Android has not given yet
                }
            }
            list.put(e);
        }
        JSObject ret = new JSObject();
        ret.put("ports", list);
        call.resolve(ret);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String path = call.getString("path", "");
        int baudRate = call.getInt("baudRate", 115200);
        UsbDevice device = access.manager().getDeviceList().get(path);
        if (device == null) {
            call.reject("the board is no longer plugged in");
            return;
        }
        access.request(
            device,
            new UsbAccess.Result() {
                @Override
                public void granted() {
                    opener.execute(() -> openGranted(call, device, baudRate));
                }

                @Override
                public void refused() {
                    call.reject("Android did not allow access to the board. Unplug it, plug it back in and allow access.");
                }
            }
        );
    }

    private void openGranted(PluginCall call, UsbDevice device, int baudRate) {
        UsbManager manager = access.manager();
        UsbSerialDriver driver = UsbSerialProber.getDefaultProber().probeDevice(device);
        if (driver == null || driver.getPorts().isEmpty()) {
            call.reject("this USB device is not a serial port");
            return;
        }
        UsbDeviceConnection connection = manager.openDevice(device);
        if (connection == null) {
            call.reject("Android could not open the board's port");
            return;
        }
        UsbSerialPort serial = driver.getPorts().get(0);
        try {
            serial.open(connection);
            try {
                serial.setParameters(baudRate, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE);
            } catch (UnsupportedOperationException ignored) {
                // native USB ports have no baud rate
            }
        } catch (IOException e) {
            try {
                serial.close();
            } catch (IOException ignored) {
                // never fully opened
            }
            call.reject("cannot open the board's port: " + e.getMessage());
            return;
        }
        int handle = nextHandle.getAndIncrement();
        Port port = new Port(handle, serial);
        ports.put(handle, port);
        JSObject ret = new JSObject();
        ret.put("handle", handle);
        call.resolve(ret);
        // Reads start after the handle is known, so none arrives for a handle the page has not seen.
        port.start();
    }

    @PluginMethod
    public void setSignals(PluginCall call) {
        Port port = ports.get(call.getInt("handle", 0));
        if (port == null) {
            call.reject("Port is not open");
            return;
        }
        boolean dtr = Boolean.TRUE.equals(call.getBoolean("dtr", true));
        boolean rts = Boolean.TRUE.equals(call.getBoolean("rts", true));
        port.run(call, () -> {
            // RTS held with DTR released resets an ESP32 through its auto-reset circuit: release RTS
            // first and assert it last, so no step passes through that state unless asked to.
            if (!rts) {
                port.serial.setRTS(false);
                port.serial.setDTR(dtr);
            } else {
                port.serial.setDTR(dtr);
                port.serial.setRTS(true);
            }
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        Port port = ports.get(call.getInt("handle", 0));
        if (port == null) {
            call.reject("Port is not open");
            return;
        }
        byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
        port.run(call, () -> port.serial.write(data, 0));
    }

    @PluginMethod
    public void close(PluginCall call) {
        Port port = ports.remove(call.getInt("handle", 0));
        if (port == null) {
            call.resolve();
            return;
        }
        opener.execute(() -> {
            port.close(null);
            call.resolve();
        });
    }

    private interface Task {
        void run() throws IOException;
    }

    private final class Port implements SerialInputOutputManager.Listener {

        final int handle;
        final UsbSerialPort serial;
        final SerialInputOutputManager reader;
        /** Writes and line changes, in the order they were asked for. */
        final ExecutorService writer = Executors.newSingleThreadExecutor();
        volatile boolean closed;

        Port(int handle, UsbSerialPort serial) {
            this.handle = handle;
            this.serial = serial;
            this.reader = new SerialInputOutputManager(serial, this);
        }

        void start() {
            reader.start();
        }

        void run(PluginCall call, Task task) {
            try {
                writer.execute(() -> {
                    if (closed) {
                        call.reject("Port is not open");
                        return;
                    }
                    try {
                        task.run();
                        call.resolve();
                    } catch (IOException | RuntimeException e) {
                        call.reject(e.getMessage() == null ? "the port failed" : e.getMessage());
                    }
                });
            } catch (RejectedExecutionException e) {
                call.reject("Port is not open");
            }
        }

        @Override
        public void onNewData(byte[] data) {
            if (closed) return;
            JSObject e = new JSObject();
            e.put("handle", handle);
            e.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
            notifyListeners("data", e);
        }

        @Override
        public void onRunError(Exception error) {
            if (closed || ports.remove(handle) == null) return;
            close(error.getMessage() == null ? "the port was lost" : error.getMessage());
        }

        synchronized void close(String error) {
            if (closed) return;
            closed = true;
            reader.stop();
            for (Runnable pending : writer.shutdownNow()) pending.run();
            try {
                serial.close();
            } catch (IOException ignored) {
                // already closed by the unplug
            }
            JSObject e = new JSObject();
            e.put("handle", handle);
            if (error != null) e.put("error", error);
            notifyListeners("closed", e);
        }
    }
}
