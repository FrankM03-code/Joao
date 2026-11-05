// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Which notification the island shows, and for how long. A new one replaces what is showing,
// which is still in the list of Hoy, unless the card is open or an urgent one is on screen: then
// it waits. A burst shows only the last, with "+N". Held while the page is open: the page takes
// every click, and its panel already lists them.
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {Signals} from '../sistema/gnome.js';

const BURST_COUNT = 3;
const BURST_WINDOW = 2000;  // ms
const AFTER_HOVER = 3000;   // ms left after the pointer goes away

const isUrgent = n => n.urgency === MessageTray.Urgency.CRITICAL;

export class IslandQueue {
    constructor(settings, island, view) {
        this._settings = settings;
        this._island = island;
        this._view = view;
        this._waiting = [];
        this._arrivals = [];
        this._current = null;
        this._timerId = 0;
        this._left = 0;

        this._signals = new Signals();
        this._signals.connect(island, 'settled', () => this._next());
        this._signals.connect(island, 'gone', () => this._onGone());
        this._signals.connect(island, 'hold', () => this._pause());
        this._signals.connect(island, 'release', () => this._resume(AFTER_HOVER));
        this._signals.connect(island, 'dismiss', () => this._current?.notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED));
        this._signals.connect(view, 'notify::visible', () => this._syncHeld());
        this._signals.connect(Main.sessionMode, 'updated', () => this._syncHeld());
    }

    get _held() {
        return this._view.visible || !Main.sessionMode.hasNotifications;
    }

    push(notification) {
        // An update of what is on screen, or of what is waiting.
        if (this._current?.notification === notification) {
            this._island.refresh();
            if (!this._island.holding)
                this._resume(this._settings.get_int('island-timeout') * 1000);
            return;
        }
        if (this._waiting.includes(notification))
            return;
        notification.connectObject('destroy', () => this._onDestroyed(notification), this);
        const now = GLib.get_monotonic_time() / 1000;
        this._arrivals = [...this._arrivals.filter(t => now - t < BURST_WINDOW), now];
        this._waiting.push(notification);
        this._next();
    }

    _onDestroyed(notification) {
        const at = this._waiting.indexOf(notification);
        if (at >= 0)
            this._waiting.splice(at, 1);
        if (this._current?.notification !== notification)
            return;
        // No longer there to read from: the island leaves with what it already drew.
        this._current.destroyed = true;
        this._stopTimer();
        this._island.leave();
    }

    // Shows the next one if nothing prevents it. Called on every change that could allow it.
    _next() {
        if (!this._waiting.length || this._held || this._island.busy)
            return;
        const current = this._current;
        if (current && !current.destroyed &&
            (this._island.expanded || this._island.holding || isUrgent(current.notification)))
            return;
        const {notification, more} = this._take();
        this._retire(current);
        this._current = {notification, destroyed: false};
        this._island.show(notification, more);
        this._start();
    }

    // The urgent ones first and each on its own; of the others, the last of a burst.
    _take() {
        const urgent = this._waiting.find(isUrgent);
        if (urgent) {
            this._waiting.splice(this._waiting.indexOf(urgent), 1);
            return {notification: urgent, more: 0};
        }
        if (this._arrivals.length > BURST_COUNT) {
            const skipped = this._waiting.splice(0, this._waiting.length - 1);
            const notification = this._waiting.shift();
            skipped.forEach(n => this._retire({notification: n, destroyed: false}));
            return {notification, more: skipped.length};
        }
        return {notification: this._waiting.shift(), more: 0};
    }

    // Done showing: it stays in the list, unless it was only meant to be seen once.
    _retire(entry) {
        if (!entry || entry.destroyed)
            return;
        const {notification} = entry;
        notification.disconnectObject(this);
        if (notification.isTransient)
            notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
    }

    _start() {
        this._stopTimer();
        const urgent = isUrgent(this._current.notification);
        const ms = this._settings.get_int('island-timeout') * 1000;
        this._island.startLine(urgent ? 0 : ms, ms);
        if (!urgent)
            this._runTimer(ms);
    }

    _runTimer(ms) {
        this._stopTimer();
        this._timerStart = GLib.get_monotonic_time() / 1000;
        this._left = ms;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timerId = 0;
            this._island.leave({canReturn: true});
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    _pause() {
        this._stopTimer();
        this._island.stopLine();
    }

    _resume(ms) {
        if (!this._current || isUrgent(this._current.notification)) {
            this._next();
            return;
        }
        this._island.startLine(ms, ms);
        this._runTimer(ms);
        this._next();
    }

    _onGone() {
        const entry = this._current;
        this._current = null;
        this._retire(entry);
        this._next();
    }

    _syncHeld() {
        if (this._held && this._current) {
            this._stopTimer();
            this._island.leave();
        } else {
            this._next();
        }
    }

    destroy() {
        this._stopTimer();
        this._signals.disconnectAll();
        const entry = this._current;
        this._current = null;
        this._retire(entry);
        // GNOME takes back what was waiting: not seen yet, so it asks for a banner again.
        const waiting = this._waiting;
        this._waiting = [];
        for (const notification of waiting) {
            notification.disconnectObject(this);
            notification.acknowledged = false;
        }
    }
}
