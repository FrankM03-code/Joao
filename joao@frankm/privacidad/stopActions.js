// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Going to the app that uses a device, and cutting it where that can be done: an app's
// microphone can be muted and screen sharing stopped; a camera cannot be taken from an app.
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {escenasManager} from '../franja/escenasMode.js';
import {notify} from '../sistema/notice.js';
import {privacyMonitor} from './privacyMonitor.js';

function windowOf(entry) {
    const windows = entry.app?.get_windows() ?? [];
    return windows.find(w => w.get_pid() === entry.pid) ?? windows[0] ?? null;
}

export const canGoTo = entry => !!windowOf(entry);

export function goToApp(entry) {
    const win = windowOf(entry);
    if (!win)
        return;
    const manager = escenasManager();
    const scene = manager?.sceneOf(win);
    if (scene)
        manager.open(scene, win);
    else
        Main.activateWindow(win);
}

export const canCut = (device, entry) => device === 'screen'
    ? entry.recording || privacyMonitor().sharingHandles.length > 0
    : device === 'microphone' && (entry.streams.length > 0 || !!privacyMonitor().defaultInput);

export const isMuted = entry => entry.streams.length > 0 && entry.streams.every(s => s.is_muted);

// The words on the button or menu item.
export function cutLabel(device, entry) {
    if (device === 'screen')
        return entry.recording ? 'Detener la grabación' : 'Dejar de compartir';
    return isMuted(entry) ? 'Reactivar el micrófono' : 'Silenciar el micrófono';
}

export function cut(device, entry) {
    const monitor = privacyMonitor();
    if (device === 'screen') {
        if (entry.recording)
            Main.screenshotUI?.stopScreencast();
        else
            monitor.sharingHandles.forEach(handle => handle.stop());
        return;
    }
    const mute = !isMuted(entry);
    const done = entry.streams.length > 0 && entry.streams.every(stream => stream.change_is_muted(mute));
    if (done)
        return;
    const input = monitor.defaultInput;
    if (input?.change_is_muted(true))
        notify('Se silenció el micrófono para todas las apps', 'No se pudo silenciar solo esta app.');
}
