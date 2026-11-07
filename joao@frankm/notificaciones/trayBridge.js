// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Where the island meets GNOME. GNOME goes on deciding what deserves a banner (urgency, Do Not
// Disturb, per-app settings, fullscreen, the lock screen) and keeps every notification in its
// list; only the last step, building the banner, is replaced, in this one instance.
// Not bannerBlocked: GNOME's date menu resets it, and it stops all of those decisions as well.
// What it shows goes to the launcher button, which comes out by itself if the strip is away, so
// nothing appears at the top. The island only with notify-style=island, never as a fallback.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {appsBubble} from '../escenas/escenasLink.js';
import {Island} from './island.js';
import {IslandQueue} from './islandQueue.js';
import {notificationStore, retire} from './notificationStore.js';
import {useSettings} from './sourceLook.js';

const SHORTCUT = 'island-focus-shortcut';
const AFTER_FULLSCREEN = 300;   // ms for the strip to come back before asking if it is there

const inFullscreen = () => !!Main.layoutManager.primaryMonitor?.inFullscreen;

export class TrayBridge {
    constructor(settings, view) {
        this._settings = settings;
        this._view = view;
        this._heldCount = 0;    // came during fullscreen, and GNOME keeps them back
        this._heldTaken = [];
        this._heldId = 0;
        useSettings(settings);
        this._island = new Island(settings);
        this._queue = new IslandQueue(settings, this._island, view);

        const tray = Main.messageTray;
        this._tray = tray;
        if (typeof tray._showNotification === 'function') {
            tray._showNotification = () => this._takeFromTray();
            this._replaced = true;
        } else {
            logError(new Error('messageTray._showNotification no existe'), 'João: siguen los globos de GNOME');
        }
        Main.wm.addKeybinding(SHORTCUT, settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._openFromKeyboard());
        this._store = notificationStore();
        this._addedId = this._store.connect('added', (store, notification) => {
            if (inFullscreen() && notification.urgency !== MessageTray.Urgency.CRITICAL)
                this._heldCount++;
        });
        this._fullscreenId = global.display.connect('in-fullscreen-changed', () => this._onFullscreenChanged());
        // Anything GNOME was already holding back.
        tray._updateState();
    }

    // GNOME has decided the first one may show. Those behind it were not looked at yet.
    _takeFromTray() {
        const tray = this._tray;
        const taken = [];
        do {
            const notification = tray._notificationQueue.shift();
            tray.emit('queue-changed');
            notification.acknowledged = true;
            notification.playSound();
            this._store.markUnread(notification);
            taken.push(notification);
        } while (tray._notificationQueue.length && this._mayShow(tray._notificationQueue[0]));
        // What GNOME held back during fullscreen waits for the strip to come back.
        if (this._heldCount && !inFullscreen()) {
            this._heldTaken.push(...taken);
            this._flushHeldLater();
            return;
        }
        this._deliver(taken, 1);
    }

    // The bubble, if notifications are told there.
    get _bubble() {
        const bubble = appsBubble();
        return bubble?.showsNotifications ? bubble : null;
    }

    _deliver(notifications, total) {
        // The island only if it was chosen in the preferences.
        if (this._settings.get_string('notify-style') === 'island') {
            notifications.forEach(notification => this._queue.push(notification));
            return;
        }
        const bubble = this._bubble;
        // Nowhere to tell it now (page open, no launcher button, lock screen): it stays in the
        // panel's list and in the count, without anything coming out at the top.
        if (!bubble?.canTell || this._view.visible) {
            notifications.forEach(retire);
            return;
        }
        if (total > 1) {
            // One wave for all of them.
            notifications.slice(0, -1).forEach(retire);
            bubble.arrive(notifications.at(-1), total);
        } else {
            notifications.forEach(notification => bubble.arrive(notification, 1));
        }
    }

    _onFullscreenChanged() {
        if (!inFullscreen() && this._heldCount)
            this._flushHeldLater();
    }

    _flushHeldLater() {
        if (this._heldId)
            GLib.source_remove(this._heldId);
        this._heldId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AFTER_FULLSCREEN, () => {
            this._heldId = 0;
            const taken = this._heldTaken;
            const total = this._heldCount;
            this._heldTaken = [];
            this._heldCount = 0;
            if (taken.length)
                this._deliver(taken, total);
            return GLib.SOURCE_REMOVE;
        });
    }

    _openFromKeyboard() {
        if (this._island.visible || !this._bubble?.openListFromKeyboard())
            this._island.openFromKeyboard();
    }

    _mayShow(notification) {
        const limited = this._tray._busy || Main.layoutManager.primaryMonitor?.inFullscreen;
        return !limited || notification.forFeedback || notification.urgency === MessageTray.Urgency.CRITICAL;
    }

    destroy() {
        Main.wm.removeKeybinding(SHORTCUT);
        if (this._heldId)
            GLib.source_remove(this._heldId);
        this._heldId = 0;
        this._store.disconnect(this._addedId);
        global.display.disconnect(this._fullscreenId);
        // The instance's own function goes away and the class's is seen again.
        if (this._replaced)
            delete this._tray._showNotification;
        this._queue.destroy();
        this._island.destroy();
        this._tray._updateState();
        useSettings(null);
    }

    get island() {
        return this._island;
    }
}
