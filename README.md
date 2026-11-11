# GBLink Netplay Bridge

Play Generation 3 Pokémon — by link cable or Wireless Adapter — and Advance Wars 1/2 VS link on a **real GBA**, or Pokémon FireRed and LeafGreen on a **Nintendo Switch**, against emulator players over **RetroArch netplay**.

It runs on Windows, macOS and Linux, and on Android phones. On one side it talks to a GB-Link adapter (a GBA) or an ESP32 bridge board (a Switch); on the other it speaks the RetroArch netplay protocol, appearing to the network as a regular RetroArch + gpsp player. Hardware and emulator players are interchangeable: any mix of real GBAs, Switches and RetroArch players can share a session. The RetroArch players need no extra software.

| Console | Game | Link |
| --- | --- | --- |
| Game Boy Advance (GB-Link) | Pokémon Ruby, Sapphire, Emerald, FireRed, LeafGreen | Link cable, Wireless Adapter |
| Game Boy Advance (GB-Link) | Advance Wars, Advance Wars 2: Black Hole Rising | Link cable |
| Nintendo Switch (ESP32 bridge) | Pokémon FireRed, LeafGreen | Wireless Adapter, link cable |

## Features

- **Join** a session: direct IP, from the public lobby browser, or through a RetroArch relay (MITM) server
- **Host** a session: direct, with optional public-lobby announcement and LAN discovery, or through a relay
- **Wireless Adapter** sessions take up to five players on the same network or over a direct connection: a GBA or Switch can lead a room that RetroArch players join, or join a room one of them leads, exactly as between two wireless adapters
- **Switch over the link cable**: the Switch's wireless link is turned into the cable protocol, so a Switch trades and battles with Ruby and Sapphire players too

## Requirements

- For a GBA: a GB-Link USB adapter with firmware **3.0.0 or newer** for the link cable games (Pokémon by cable and Advance Wars) and **2.2.7 or newer** for the Wireless Adapter (update from the GBLink launcher). For the cable games either a GBA or a GBC link cable works, and the adapter finds out by itself which one is plugged in; with a GBA cable, plug its **small (master) connector** into the adapter. The Wireless Adapter mode needs a **Game Boy Color link cable**.
- For a Switch: an ESP32 board (ESP32-S3 recommended) running the bridge firmware from [GB-Link-Switch-LDN](https://github.com/GB-Link/GB-Link-Switch-LDN), **2.1.5 or newer**, with your Switch's keys stored on it. Set it up once at <https://switch.gblink.io> (install the firmware, drop your `prod.keys` on the page); this app then only needs the board on USB. Close that page before playing: a browser tab holding the board's port keeps this app from opening it. Boards with native USB (ESP32-S3, C3, C6) are found as soon as they are plugged in; a classic ESP32 behind a USB-serial chip is found when a Switch session starts, so plug it in first (each USB-serial port is tried once per session).
- RetroArch peers must run the **gpsp** core with `Link Cable Connectivity` set to match the session (the play card names the option):
  `Link Cable - Pokemon Gen3 mode` for a cable session, `GBA Wireless Adapter` for a wireless one, `Link Cable - Advance Wars 1/2 mode` for Advance Wars. gpsp's *Automatic* setting picks the Wireless Adapter on Emerald / FireRed / LeafGreen and the cable on Ruby / Sapphire, and for Advance Wars works for US/EU carts (game codes AWRE/AWRP/AW2E/AW2P); Japanese carts need the mode set explicitly. gpsp reads the option only when a game is loaded: after changing it, close the content and load the game again (Restart is not enough). To check it in Advance Wars, open the Link screen with netplay off: a 1P icon appears only when the Advance Wars mode is on.

## Playing

1. Plug in the adapter or the ESP32 board — the status bar shows each one it finds.
2. Pick the console and the game on the play card, then join a session (direct address or lobby browser) or start hosting. Lobby rooms with a recognised game name pre-select the game; a Pokémon room keeps your cable/wireless choice, so pick the one the host is using.
3. **Pokémon by link cable (GBA):** both players go to the Cable Club upstairs in any Pokémon Center and talk to the attendant — in either order. If one game stops waiting before the other player arrives, just talk to the attendant again. Trade and battle as usual; between activities the link renegotiates automatically and brief "Linking…" states are normal.
4. **Pokémon by Wireless Adapter (GBA or Switch):** go to the Direct Corner (the Wireless Communication menu on a GBA; upstairs in a Pokémon Center on the Switch) at any time during the session. Lead a Trade Center or Colosseum group, or join one another player leads — the room list shows the others' groups as it does between wireless adapters. Up to five players share a session; a Switch leads or joins one room at a time. When a player leaves a group the Switch leads, the Switch still counts them: the next player to join takes their place, and if they cannot link, leave the group on the Switch and lead it again. Wireless sessions don't go through a relay, which adds more delay than the games can take: play on the same network, or connect straight to the host's address, with their port forwarded or over a virtual LAN such as Tailscale or ZeroTier. A RetroArch player hosting a wireless session turns off `Use Relay Server` too.
5. **Pokémon by link cable (Switch):** the bridge plays the cable protocol for the Switch. When **hosting**, lead a Trade Center or Colosseum group on the Switch; the other player talks to the Cable Club attendant and the bridge joins the Switch's group. When **joining**, pick on the play card which room the Switch will use (Trade Center, single or double battle), then on the Switch join the group the bridge opens; the other player talks to the attendant for the same room. After each visit, leave the group on the Switch: a group the Switch leads cannot be joined again until it is led anew, and the bridge opens a fresh group once the Switch has left its last one. The National Dex bypass lets the Switch link with Emerald (and Ruby or Sapphire by cable) before the Sevii Islands story and the National Dex, as the Switch page does; leave it off when the other players run FireRed or LeafGreen, who would then see the Switch as an Emerald.
6. **Advance Wars:** start the bridge session before opening the link menu on the GBA, as on Celio (if the GBA is already on the VS Link screen, back out and open it again once the session is up). The RetroArch player joins the session before opening their Link screen too. Host from the bridge when you can, so your GBA is player 1 and presses Start: when a RetroArch player presses Start in the Link screen, RetroArch now and then closes. From then on play as many VS Link matches as you like and send maps freely without leaving the netplay session, exactly like a RetroArch player: the adapter stays armed for the whole session. Strictly 2 players; when joining, the bridge must be the only (first) joiner; when hosting, your GBA is player 1. A "partner quiet" state is informational — the link stays up.

## Linux USB permissions

Install the udev rule (the app offers to do this for you) or run the permission script included with the firmware. The ESP32 board's serial port needs your user in the `dialout` group (`uucp` on Arch). If the board's port is reported lost right after another serial program used it, unplug the board and plug it back in.

Windows and macOS need no drivers (the firmware carries MS OS 2.0 descriptors; WinUSB binds automatically; the ESP32's USB serial port is standard).

## macOS first launch

Builds are not notarized. On first launch macOS will block the app: open **System Settings → Privacy & Security**, scroll to the blocked-app notice and choose **Open Anyway**. Use the arm64 dmg on Apple Silicon and the x64 dmg on Intel Macs (x64 also runs on Apple Silicon via Rosetta).

## Android

The app runs on Android 8 or newer. Plug the GB-Link or the ESP32 board into the phone with a USB OTG adapter or cable.

- Install the Android APK. Android asks once to allow installs from your browser or file manager.
- The first time you plug in the adapter or the board, Android asks whether the app may use it: choose OK. If you choose Cancel, unplug it, plug it back in and allow it.
- Keep the app on screen while you play. It keeps the screen on and Wi-Fi at full speed during a session, and Android slows down apps it can't see. The back button leaves the app running.
- On mobile data, other players can't reach your phone directly: join their session, or host through a relay for the cable and Advance Wars games.
- Set up the ESP32 board from a computer first, at <https://switch.gblink.io>.

## Development

```
npm install                # engine + electron toolchain
npm run typecheck          # engine + tests
npm run typecheck:main     # electron main/preload
npm test                   # vitest: framing, bridge FSMs, netplay interop
npm run cli -- probe --game rfu            # hardware smoke test: mode entry + firmware report
npm run cli -- probe-esp                   # ESP32 bridge: firmware, keys, bridge status
npm run cli -- join <host[:port]> --nick Ash --game gen3
npm run cli -- host --port 55435 --nick Brock --game rfu --console switch --national-bypass
npm run cli -- join <host> --game gen3 --console switch --room single

cd src/renderer && npm install && npm start   # GUI dev server (mock bridge in plain browser)
npm run dev                # electron shell against the dev server (GBLINK_DEV=1)
npm run build:main && npx electron-builder    # package installers
npm run typecheck:android                     # Android bridge
npm run build:android                         # Android APK: needs the Android SDK (ANDROID_HOME) and a JDK 21 (JAVA_HOME)
```

Release signing reads `android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`); without it the APK is signed with the debug key. `npm run build:android -- --debug` builds a debug APK instead.

Layout: `src/engine/` is an Electron-free Node library — the netplay protocol client/host, the USB layer, the gen3 `LinkBridge` that speaks gpsp's MPK1 cable protocol, `src/engine/aw/` (the MAW1 framing plus the Advance Wars `AwLinkBridge` that relays the firmware's protocol proxy as gpsp netpackets), `src/engine/rfu/` (the RFU1 framing of gpsp's Wireless Adapter netpackets, the `RfuLinkBridge` that addresses one adapter's frames to the right netplay clients, and the two devices that speak it: the GB-Link's wireless mode and the ESP32 bridge's host port), `src/engine/esp32/` (the ESP32 console protocol over a serial port) and `src/engine/switch/` (the Switch page's wireless-to-cable translators, vendored from GB-Link-Switch-LDN, behind a virtual adapter so the gen3 `LinkBridge` drives a Switch like a GBA). `src/main/` + `src/preload/` are the Electron shell, `src/renderer/` is the Angular GUI, `src/android/` runs the same host code in an Android web view (stand-ins for the Node and Electron modules, backed by the native plugins in `android/`), and `test/` is the vitest suite (unit + loopback netplay interop against ports of gpsp's serial state machines and the Switch page's game fakes).

## References

- [GBLink-Firmware](https://github.com/GB-Link/GBLink-Firmware) — the adapter firmware this app drives
- [GB-Link-Switch-LDN](https://github.com/GB-Link/GB-Link-Switch-LDN) — the ESP32 bridge firmware, the Switch page and the cable translators
- [gpsp](https://github.com/libretro/gpsp) — the GBA core whose link protocols the bridge speaks
- [RetroArch](https://github.com/libretro/RetroArch) — the netplay transport

## Third-party code

`src/engine/switch/vendor/` holds the Switch page's translators unchanged (GB-Link-Switch-LDN, AGPL-3.0); `translator.js` there is MPL-2.0, ported from [mgba_LDN](https://github.com/Gr3nSkyDragon/mgba_LDN).
