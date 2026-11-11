import { EventEmitter } from 'node:events';
import { UsbLink, type UsbEntry } from '../native';

/** The part of a node-usb device the engine reads: its ids. */
export interface Device {
  name: string;
  deviceDescriptor: { idVendor: number; idProduct: number };
}

interface HotplugEvents {
  attach: [Device];
  detach: [Device];
}

/** Stands in for node-usb's hotplug emitter. */
class Hotplug extends EventEmitter<HotplugEvents> {
  unrefHotplugEvents(): void {}
}

export const usb = new Hotplug();

const devices = new Map<string, Device>();

const toDevice = (e: UsbEntry): Device => ({
  name: e.name,
  deviceDescriptor: { idVendor: e.vendorId, idProduct: e.productId },
});

/** Plugged-in devices; kept current by Android's attach and detach broadcasts. */
export function getDeviceList(): Device[] {
  return [...devices.values()];
}

let started: Promise<void> | null = null;

/** Loads the device list before the engine starts: its watcher reads the list synchronously. */
export function initUsb(): Promise<void> {
  started ??= (async () => {
    await UsbLink.addListener('attach', (e) => {
      const device = toDevice(e);
      devices.set(device.name, device);
      usb.emit('attach', device);
    });
    await UsbLink.addListener('detach', (e) => {
      const device = devices.get(e.name) ?? toDevice(e);
      devices.delete(e.name);
      usb.emit('detach', device);
    });
    const { devices: list } = await UsbLink.list();
    for (const e of list) devices.set(e.name, toDevice(e));
  })();
  return started;
}
