# GBLink Netplay Bridge

Play Generation 3 Pokémon link cable on a **real GBA** against emulator players, over **RetroArch netplay**.

This is a desktop app. It talks to a real GBA through a GB-Link adapter on one side and speaks the RetroArch netplay protocol on the other, appearing to the network as a regular RetroArch + gpsp player. The RetroArch players need no extra software.

Currently supports the following games:
Pokémon Fire Red
Pokémon Leaf Green
Pokémon Ruby
Pokémon Sapphire 
Pokémon Emerald

## Features

- **Join** a session: direct IP, from the public lobby browser, or through a RetroArch relay (MITM) server
- **Host** a session: direct, with optional public-lobby announcement and LAN discovery, or through a relay

## Requirements

- GB-Link USB adapter with firmware **2.2.2 or newer**. Either a GBA or a GBC link cable works (the firmware auto-detects which pin carries SD); with a GBA cable, plug its **small (master) connector** into the adapter
- A real GBA with a gen 3 Pokémon cartridge
- RetroArch peers must run the **gpsp** core with the core option
  **`Link Cable Connectivity` = `Link Cable - Pokemon Gen3 mode`** .
  On Emerald / FireRed / LeafGreen, gpsp's *Automatic* setting selects the Wireless Adapter (RFU) instead, which is incompatible with cable play, so the option must be set explicitly. Ruby/Sapphire auto-select cable mode.

## Playing

1. Plug in the adapter — the Device panel shows its firmware once detected.
2. Join a session (direct address or lobby browser) or start hosting.
3. Both players go to the Cable Club upstairs in any Pokémon Center and talk to the attendant — in either order. If one game stops waiting before the other player arrives, just talk to the attendant again.
4. Trade and battle as usual. Between activities the link renegotiates automatically; brief "Linking…" states are normal.

## Linux USB permissions

Install the udev rule (the app offers to do this for you) or run the permission script included with the firmware.

Windows and macOS need no drivers (the firmware carries MS OS 2.0 descriptors; WinUSB binds automatically).

## Development

```
npm install                # engine + electron toolchain
npm run typecheck          # engine
npm run typecheck:main     # electron main/preload
npm run cli -- probe       # hardware smoke test: init sequence + firmware/cable report
npm run cli -- join <host[:port]> --nick Ash
npm run cli -- host --port 55435 --nick Brock

cd src/renderer && npm install && npm start   # GUI dev server (mock bridge in plain browser)
npm run dev                # electron shell against the dev server (GBLINK_DEV=1)
npm run build:main && npx electron-builder    # package installers
```

Layout: `src/engine/` is an Electron-free Node library (netplay protocol client/host, USB layer, and the LinkBridge state machine that translates firmware link statuses into gpsp's MPK1 protocol), `src/main/` + `src/preload/` are the Electron shell, and `src/renderer/` is the Angular GUI.

## References

- [GBLink-Firmware](https://github.com/GB-Link/GBLink-Firmware) — the adapter firmware this app drives
- [gpsp](https://github.com/libretro/gpsp) — the GBA core whose link protocol the bridge speaks
- [RetroArch](https://github.com/libretro/RetroArch) — the netplay transport
