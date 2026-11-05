// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The notifications GNOME keeps in its message tray: newest first, up to three in view and
// the rest with scroll. A click activates one and closes the page.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatTimeSpan} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {allNotifications} from '../notificaciones/notificationStore.js';
import {sourceIcon, sourceName} from '../notificaciones/sourceLook.js';

const ROW = 56;           // keep in step with stylesheet.css (.escenas-full-notification)
const ROW_GAP = 6;
const VISIBLE = 3;

export function plainBody(notification) {
    const body = notification.body ?? '';
    if (!notification.useBodyMarkup)
        return body;
    try {
        return Pango.parse_markup(body, -1, '')[2];
    } catch {
        return body;
    }
}

export const NotificationsBlock = GObject.registerClass(
class JoaoNotificationsBlock extends St.BoxLayout {
    _init({tooltip, close}) {
        super._init({style_class: 'escenas-full-block', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._close = close;
        this._room = VISIBLE;
        const head = new St.BoxLayout({x_expand: true});
        head.add_child(new St.Label({style_class: 'escenas-full-block-title', text: 'Notificaciones', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this.clear = new St.Button({style_class: 'escenas-saved-link', label: 'Limpiar', can_focus: true, accessible_name: 'Limpiar las notificaciones'});
        this.clear.connect('clicked', () => this._clearAll());
        tooltip.attach(this.clear, 'Limpiar las notificaciones');
        head.add_child(this.clear);
        this.add_child(head);

        this._empty = new St.Label({style_class: 'escenas-full-empty', text: 'No hay notificaciones'});
        this.add_child(this._empty);
        this._list = new St.BoxLayout({style_class: 'escenas-full-notifications', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._list,
        });
        this.add_child(this._scroll);

        Main.messageTray.connectObject(
            'source-added', (tray, source) => this._watchSource(source),
            'source-removed', () => this._queueRebuild(),
            this);
        Main.messageTray.getSources().forEach(source => this._watchSource(source));
        this.rebuild();
        this.connect('destroy', () => this._onDestroy());
    }

    _watchSource(source) {
        source.connectObject('notification-added', (s, notification) => {
            this._watchNotification(notification);
            this._queueRebuild();
        }, this);
        source.notifications.forEach(n => this._watchNotification(n));
        this._queueRebuild();
    }

    _watchNotification(notification) {
        notification.connectObject(
            'destroy', () => this._queueRebuild(),
            'notify::title', () => this._queueRebuild(),
            'notify::body', () => this._queueRebuild(),
            this);
    }

    // After the signal: the source takes a closing notification off its list in the same emission.
    _queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._rebuildId = 0;
            this.rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    get all() {
        return allNotifications();
    }

    rebuild() {
        const all = this.all;
        this._list.destroy_all_children();
        for (const entry of all)
            this._list.add_child(this._row(entry));
        this._empty.visible = all.length === 0;
        this.clear.visible = all.length > 0;
        this._scroll.visible = all.length > 0;
        this._fit();
    }

    _fit() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const count = Math.min(this.all.length, this._room);
        this._scroll.height = Math.max(count, 1) * (ROW + ROW_GAP) * scale - ROW_GAP * scale;
    }

    // How many rows fit in the panel on this screen.
    setRoom(rows) {
        this._room = Math.max(1, Math.min(rows, VISIBLE));
        this._fit();
    }

    _row({source, notification}) {
        const row = new St.Button({
            style_class: 'escenas-full-notification',
            can_focus: true,
            x_expand: true,
            accessible_name: `${sourceName(source)}: ${notification.title ?? ''}`,
        });
        const box = new St.BoxLayout({style_class: 'escenas-full-notification-box', x_expand: true});
        const gicon = notification.gicon ?? sourceIcon(notification);
        box.add_child(new St.Icon({gicon, icon_size: 30, y_align: Clutter.ActorAlign.CENTER}));
        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const when = notification.datetime ? ` · ${formatTimeSpan(notification.datetime)}` : '';
        const label = (style, text) => {
            const l = new St.Label({style_class: style, text});
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            return l;
        };
        words.add_child(label('escenas-full-notification-meta', `${sourceName(source)}${when}`));
        const body = plainBody(notification);
        words.add_child(label('escenas-full-notification-text', [notification.title, body].filter(t => t).join(' — ')));
        box.add_child(words);
        row.set_child(box);
        row.connect('clicked', () => {
            this._close();
            notification.activate();
        });
        return row;
    }

    _clearAll() {
        for (const source of Main.messageTray.getSources())
            source.destroyNonResidentNotifications();
    }

    _onDestroy() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = 0;
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources()) {
            source.disconnectObject(this);
            source.notifications.forEach(n => n.disconnectObject(this));
        }
    }
});
