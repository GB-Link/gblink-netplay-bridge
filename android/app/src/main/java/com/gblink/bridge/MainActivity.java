package com.gblink.bridge;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UsbLinkPlugin.class);
        registerPlugin(SerialLinkPlugin.class);
        registerPlugin(SocketsPlugin.class);
        registerPlugin(AppShellPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
