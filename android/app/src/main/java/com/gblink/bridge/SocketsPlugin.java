package com.gblink.bridge;

import android.net.wifi.WifiManager;
import android.os.Process;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** TCP connections and servers for netplay, UDP for LAN discovery. Errors carry Node's errno names. */
@CapacitorPlugin(name = "Sockets")
public class SocketsPlugin extends Plugin {

    private static final Pattern ERRNO = Pattern.compile("\\b(E[A-Z]{3,})\\b");
    private static final int READ_SIZE = 65536;
    private static final int DATAGRAM_SIZE = 2048;

    private final Map<Integer, Connection> connections = new ConcurrentHashMap<>();
    private final Map<Integer, ServerSocket> servers = new ConcurrentHashMap<>();
    private final Map<Integer, DatagramSocket> datagrams = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private final ExecutorService udpSender = Executors.newSingleThreadExecutor();
    private WifiManager.MulticastLock multicastLock;

    @Override
    public void load() {
        WifiManager wifi = getContext().getApplicationContext().getSystemService(WifiManager.class);
        if (wifi != null) {
            // Some Wi-Fi drivers drop broadcasts unless an app asks for them.
            multicastLock = wifi.createMulticastLock("gblink-lan-discovery");
            multicastLock.setReferenceCounted(true);
        }
    }

    @Override
    protected void handleOnDestroy() {
        for (Connection c : connections.values()) c.destroy();
        for (ServerSocket s : servers.values()) closeQuietly(s);
        for (DatagramSocket d : datagrams.values()) d.close();
        connections.clear();
        servers.clear();
        datagrams.clear();
        workers.shutdownNow();
        udpSender.shutdownNow();
    }

    // ---- TCP ----

    @PluginMethod
    public void connect(PluginCall call) {
        String host = call.getString("host", "");
        int port = call.getInt("port", 0);
        workers.execute(() -> {
            Socket socket = new Socket();
            try {
                socket.setTcpNoDelay(true);
                socket.connect(new InetSocketAddress(host, port));
            } catch (IOException | IllegalArgumentException e) {
                closeQuietly(socket);
                reject(call, e);
                return;
            }
            Connection c;
            try {
                c = new Connection(nextId.getAndIncrement(), socket);
            } catch (IOException e) {
                closeQuietly(socket);
                reject(call, e);
                return;
            }
            connections.put(c.id, c);
            JSObject ret = new JSObject();
            ret.put("id", c.id);
            ret.put("remoteAddress", socket.getInetAddress().getHostAddress());
            ret.put("remotePort", socket.getPort());
            call.resolve(ret);
            // Reading starts after the id is known, so no data arrives for an id the page has not seen.
            c.start();
        });
    }

    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void write(PluginCall call) {
        Connection c = connections.get(call.getInt("id", 0));
        if (c != null) c.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
    }

    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void end(PluginCall call) {
        Connection c = connections.get(call.getInt("id", 0));
        if (c != null) c.end();
    }

    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void destroy(PluginCall call) {
        Connection c = connections.remove(call.getInt("id", 0));
        if (c != null) c.destroy();
    }

    @PluginMethod
    public void listen(PluginCall call) {
        int port = call.getInt("port", 0);
        workers.execute(() -> {
            ServerSocket server;
            try {
                server = new ServerSocket();
                server.setReuseAddress(true);
                server.bind(new InetSocketAddress(port));
            } catch (IOException e) {
                reject(call, e);
                return;
            }
            int id = nextId.getAndIncrement();
            servers.put(id, server);
            JSObject ret = new JSObject();
            ret.put("id", id);
            ret.put("port", server.getLocalPort());
            call.resolve(ret);
            Thread accepter = new Thread(() -> accept(id, server), "netplay-accept");
            accepter.start();
        });
    }

    private void accept(int serverId, ServerSocket server) {
        while (!server.isClosed()) {
            Socket socket;
            try {
                socket = server.accept();
            } catch (IOException e) {
                break;
            }
            try {
                socket.setTcpNoDelay(true);
                Connection c = new Connection(nextId.getAndIncrement(), socket);
                connections.put(c.id, c);
                JSObject e = new JSObject();
                e.put("server", serverId);
                e.put("id", c.id);
                e.put("remoteAddress", socket.getInetAddress().getHostAddress());
                e.put("remotePort", socket.getPort());
                notifyListeners("accept", e);
                c.start();
            } catch (IOException e) {
                closeQuietly(socket);
            }
        }
        servers.remove(serverId);
    }

    @PluginMethod
    public void closeServer(PluginCall call) {
        ServerSocket server = servers.remove(call.getInt("id", 0));
        if (server != null) closeQuietly(server);
        call.resolve();
    }

    // ---- UDP ----

    @PluginMethod
    public void udpBind(PluginCall call) {
        int port = call.getInt("port", 0);
        workers.execute(() -> {
            DatagramSocket socket = null;
            try {
                socket = new DatagramSocket(null);
                socket.setReuseAddress(true);
                socket.setBroadcast(true);
                socket.bind(new InetSocketAddress(port));
            } catch (IOException e) {
                if (socket != null) socket.close();
                reject(call, e);
                return;
            }
            int id = nextId.getAndIncrement();
            datagrams.put(id, socket);
            if (multicastLock != null) multicastLock.acquire();
            JSObject ret = new JSObject();
            ret.put("id", id);
            ret.put("port", socket.getLocalPort());
            call.resolve(ret);
            DatagramSocket bound = socket;
            new Thread(() -> receive(id, bound), "lan-discovery").start();
        });
    }

    private void receive(int id, DatagramSocket socket) {
        byte[] buffer = new byte[DATAGRAM_SIZE];
        while (!socket.isClosed()) {
            DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
            try {
                socket.receive(packet);
            } catch (IOException e) {
                break;
            }
            JSObject e = new JSObject();
            e.put("id", id);
            e.put("address", packet.getAddress().getHostAddress());
            e.put("port", packet.getPort());
            e.put("data", Base64.encodeToString(packet.getData(), packet.getOffset(), packet.getLength(), Base64.NO_WRAP));
            notifyListeners("udpMessage", e);
        }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void udpSend(PluginCall call) {
        DatagramSocket socket = datagrams.get(call.getInt("id", 0));
        if (socket == null) return;
        String address = call.getString("address", "");
        int port = call.getInt("port", 0);
        byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
        try {
            udpSender.execute(() -> {
                try {
                    socket.send(new DatagramPacket(data, data.length, InetAddress.getByName(address), port));
                } catch (IOException ignored) {
                    // a lost discovery packet is a missed room, as on the desktop
                }
            });
        } catch (RejectedExecutionException ignored) {
            // shutting down
        }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void udpClose(PluginCall call) {
        DatagramSocket socket = datagrams.remove(call.getInt("id", 0));
        if (socket == null) return;
        socket.close();
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
    }

    // ---- helpers ----

    private static void reject(PluginCall call, Exception e) {
        call.reject(e.getMessage() == null ? e.toString() : e.getMessage(), errno(e));
    }

    /** The errno name Node would report for this failure. */
    private static String errno(Exception e) {
        if (e instanceof UnknownHostException) return "ENOTFOUND";
        if (e instanceof SocketTimeoutException) return "ETIMEDOUT";
        Matcher m = ERRNO.matcher(String.valueOf(e.getMessage()));
        return m.find() ? m.group(1) : null;
    }

    private static void closeQuietly(java.io.Closeable c) {
        try {
            c.close();
        } catch (IOException ignored) {
            // nothing left to do
        }
    }

    /** One TCP connection: a reader thread, and a writer that sends in call order. */
    private final class Connection {

        final int id;
        final Socket socket;
        final InputStream in;
        final OutputStream out;
        final ExecutorService writer = Executors.newSingleThreadExecutor();
        private boolean finished;

        Connection(int id, Socket socket) throws IOException {
            this.id = id;
            this.socket = socket;
            this.in = socket.getInputStream();
            this.out = socket.getOutputStream();
        }

        void start() {
            new Thread(this::read, "netplay-" + id).start();
        }

        private void read() {
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
            byte[] buffer = new byte[READ_SIZE];
            try {
                while (true) {
                    int n = in.read(buffer);
                    if (n < 0) break;
                    JSObject e = new JSObject();
                    e.put("id", id);
                    e.put("data", Base64.encodeToString(buffer, 0, n, Base64.NO_WRAP));
                    notifyListeners("data", e);
                }
                finish(null);
            } catch (IOException e) {
                finish(e);
            }
        }

        void write(byte[] data) {
            submit(() -> {
                try {
                    out.write(data);
                } catch (IOException e) {
                    finish(e);
                }
            });
        }

        void end() {
            submit(() -> {
                try {
                    socket.shutdownOutput();
                } catch (IOException ignored) {
                    // already closing
                }
            });
        }

        /** Closed by the page: nothing more is reported. */
        void destroy() {
            synchronized (this) {
                finished = true;
            }
            writer.shutdownNow();
            closeQuietly(socket);
        }

        private void submit(Runnable task) {
            try {
                writer.execute(task);
            } catch (RejectedExecutionException ignored) {
                // closed
            }
        }

        private void finish(IOException error) {
            synchronized (this) {
                if (finished) return;
                finished = true;
            }
            connections.remove(id);
            writer.shutdownNow();
            closeQuietly(socket);
            JSObject e = new JSObject();
            e.put("id", id);
            if (error != null) {
                String code = errno(error);
                e.put("code", code == null ? "ECONNRESET" : code);
                e.put("message", error.getMessage());
            }
            notifyListeners("closed", e);
        }
    }
}
