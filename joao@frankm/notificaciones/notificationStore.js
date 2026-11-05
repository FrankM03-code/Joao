// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What the bubble says about notifications: which ones are unread and which are the latest. GNOME
// goes on keeping them; this only watches. Counts every notification, also those GNOME gives no
// banner to (Do Not Disturb): the count is all that rises then.
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

let current = null;
export const notificationStore = () => current;

// Everything in GNOME's list, newest first.
export function allNotifications() {
    const list = [];
    for (const source of Main.messageTray.getSources())
        list.push(...source.notifications.map(notification => ({source, notification})));
    return list.sort((a, b) => b.notification.datetime.difference(a.notification.datetime));
}

export const NotificationStore = GObject.registerClass({
    Signals: {
        changed: {},                                        // the count or the list
        added: {param_types: [GObject.TYPE_OBJECT]},        // a new one, before GNOME decides on a banner
    },
}, class JoaoNotificationStore extends GObject.Object {
    _init() {
        super._init();
        this._unread = new Set();
        this._changedId = 0;
        current = this;
        Main.messageTray.connectObject('source-added', (tray, source) => this._watchSource(source), this);
        Main.messageTray.getSources().forEach(source => this._watchSource(source));
    }

    get unread() {
        return this._unread.size;
    }

    recent(limit) {
        return allNotifications().slice(0, limit).map(entry => entry.notification);
    }

    markRead(notification) {
        if (this._unread.delete(notification))
            this._queueChanged();
    }

    markAllRead() {
        if (!this._unread.size)
            return;
        this._unread.clear();
        this._queueChanged();
    }

    // An update of one already read has something new to say.
    markUnread(notification) {
        if (this._unread.has(notification))
            return;
        this._unread.add(notification);
        this._queueChanged();
    }

    // Discards all of them, except what GNOME must keep (residents go on being there, but read).
    clearAll() {
        for (const source of Main.messageTray.getSources())
            source.destroyNonResidentNotifications();
        this.markAllRead();
    }

    _watchSource(source) {
        source.connectObject('notification-added', (s, notification) => this._onAdded(notification), this);
        source.notifications.forEach(notification => this._watch(notification));
    }

    _watch(notification) {
        notification.connectObject('destroy', () => {
            this._unread.delete(notification);
            this._queueChanged();
        }, this);
    }

    _onAdded(notification) {
        this._watch(notification);
        this._unread.add(notification);
        this._queueChanged();
        this.emit('added', notification);
    }

    // After the signal: the source takes a closing notification off its list in the same emission.
    _queueChanged() {
        if (this._changedId)
            return;
        this._changedId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._changedId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        current = null;
        if (this._changedId)
            GLib.source_remove(this._changedId);
        this._changedId = 0;
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources()) {
            source.disconnectObject(this);
            source.notifications.forEach(notification => notification.disconnectObject(this));
        }
        this._unread.clear();
    }
});

// Done with it: stays in the list, unless it was only meant to be seen once.
export function retire(notification) {
    if (notification.isTransient)
        notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
}
