// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Access to the pieces of GNOME's own quick settings that João shows with its own look.
// They keep running while the top bar is hidden (only the bar's actor is hidden), so João
// reads and changes exactly what GNOME would, with the same services behind it.
// Every getter returns null when GNOME (or this machine) does not have that piece.
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const qs = () => Main.panel?.statusArea?.quickSettings ?? null;
const first = ind => ind?.quickSettingsItems?.[0] ?? null;

export const gnome = {
    networkIcon: () => qs()?._network?._primaryIndicator ?? null,
    volumeIcon: () => qs()?._volumeOutput?._indicator ?? null,
    batteryIcon: () => qs()?._system?._indicator ?? null,
    batteryLabel: () => qs()?._system?._percentageLabel ?? null,
    powerToggle: () => qs()?._system?._systemItem?.powerToggle ?? null,
    volumeSlider: () => qs()?._volumeOutput?._output ?? null,
    brightnessSlider: () => first(qs()?._brightness),
    wifiToggle: () => qs()?._network?._wirelessToggle ?? null,
    bluetoothToggle: () => first(qs()?._bluetooth),
    darkModeToggle: () => first(qs()?._darkMode),
    powerProfiles: () => first(qs()?._powerProfiles)?._proxy ?? null,
};

// GNOME builds its indicators asynchronously at start-up: calls fn once they exist.
// Returns a cancel function.
export function whenReady(fn) {
    if (qs()?._system) {
        fn();
        return () => {};
    }
    let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
        if (!qs()?._system)
            return GLib.SOURCE_CONTINUE;
        id = 0;
        fn();
        return GLib.SOURCE_REMOVE;
    });
    return () => {
        if (id)
            GLib.source_remove(id);
        id = 0;
    };
}

// Connects handlers to a GObject and remembers them for disconnectAll().
export class Signals {
    constructor() {
        this._list = [];
        this._bindings = [];
    }

    connect(obj, signal, fn) {
        if (!obj)
            return;
        this._list.push([obj, obj.connect(signal, fn)]);
    }

    bind(source, prop, target, targetProp, flags) {
        if (!source)
            return;
        this._bindings.push(source.bind_property(prop, target, targetProp, flags));
    }

    disconnectAll() {
        for (const [obj, id] of this._list) {
            try {
                obj.disconnect(id);
            } catch {}
        }
        this._list = [];
        this._bindings.forEach(b => b.unbind());
        this._bindings = [];
    }
}
