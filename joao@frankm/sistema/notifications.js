// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The notifications GNOME keeps in its message tray, one card per app (newest app first), and
// above them the pinned note. An app with several shows the newest and a stack under the card;
// a click opens the stack (each one then has "Abrir" and its own buttons) and another closes it.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatTimeSpan} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {allNotifications} from '../notificaciones/notificationStore.js';
import {sourceIcon, sourceName} from '../notificaciones/sourceLook.js';
import {CHECK_DONE, CHECK_OPEN, noteStore, toggleCheck} from './taskStore.js';

const GROW = 350;
const UNPIN = 250;
const MAX_ACTIONS = 3;

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

function label(style, text, wrap = false) {
    const l = new St.Label({style_class: style, text, x_expand: true});
    if (wrap) {
        l.clutter_text.line_wrap = true;
        l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    } else {
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    }
    return l;
}

const text = notification => [notification.title, plainBody(notification)].filter(t => t).join(': ');
const more = n => (n === 1 ? '+1 mensaje más' : `+${n} mensajes más`);

// A note's text, with its checklist lines ("○ ", "● ") as boxes that can be ticked.
// onToggle(index): the box of line index was clicked; null: they only show.
export function noteBody(text, onToggle, style = 'joao-pin-text') {
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
    let plain = [];
    const flush = () => {
        if (plain.length)
            box.add_child(label(style, plain.join('\n'), true));
        plain = [];
    };
    text.split('\n').forEach((line, index) => {
        const open = line.startsWith(CHECK_OPEN);
        const done = line.startsWith(CHECK_DONE);
        if (!open && !done) {
            plain.push(line);
            return;
        }
        flush();
        const row = new St.BoxLayout({style_class: 'joao-check-row', x_expand: true});
        const check = new St.Button({style_class: 'joao-check', can_focus: !!onToggle, reactive: !!onToggle,
            y_align: Clutter.ActorAlign.START, accessible_name: done ? 'Marcar como pendiente' : 'Marcar como hecha'});
        if (done)
            check.add_style_pseudo_class('checked');
        if (onToggle)
            check.connect('clicked', () => onToggle(index));
        row.add_child(check);
        const words = label(style, line.slice(CHECK_OPEN.length), true);
        if (done)
            words.add_style_class_name('done');
        row.add_child(words);
        box.add_child(row);
    });
    flush();
    return box;
}

// The pinned note above the notifications ("Desfijar": off the panel, still in "Mis notas").
const PinnedNote = GObject.registerClass(
class JoaoPinnedNote extends St.BoxLayout {
    _init(store) {
        super._init({style_class: 'joao-pin', x_expand: true, visible: false});
        this._store = store;
        this.add_child(new St.Icon({style_class: 'joao-pin-icon', icon_name: 'view-pin-symbolic', y_align: Clutter.ActorAlign.START}));
        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        words.add_child(new St.Label({style_class: 'joao-pin-label', text: 'Nota fijada'}));
        this._body = new St.Bin({x_expand: true});
        words.add_child(this._body);
        this.add_child(words);
        this.unpin = new St.Button({style_class: 'joao-pin-unpin', label: 'Desfijar', can_focus: true,
            accessible_name: 'Desfijar la nota', y_align: Clutter.ActorAlign.START});
        this.unpin.connect('clicked', () => this._unpin());
        this.add_child(this.unpin);
        store.connectObject('changed', () => this.sync(), this);
        this.connect('destroy', () => store.disconnectObject(this));
    }

    sync() {
        this._note = this._store.latest;
        this.remove_transition('opacity');
        this.opacity = 255;
        this.visible = !!this._note;
        const note = this._note;
        this._body.set_child(note ? noteBody(note.text, i => this._store.update(note.id, toggleCheck(note.text, i))) : null);
    }

    get text() {
        return this._note?.text ?? '';
    }

    _unpin() {
        const id = this._note?.id;
        if (!id)
            return;
        this.ease({
            opacity: 0,
            duration: UNPIN,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._store.unpin(id),
        });
    }
});

// One notification inside a card: its words and, while the card is open, its buttons. In a stack
// "Abrir" opens that one (a click on the card closes the stack).
const Entry = GObject.registerClass(
class JoaoNotificationEntry extends St.BoxLayout {
    _init(notification, open, stacked) {
        super._init({style_class: 'joao-nentry', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.notification = notification;
        this._text = label('joao-nentry-text', text(notification));
        this.add_child(this._text);
        this._actions = new St.BoxLayout({style_class: 'joao-nactions', visible: false, x_align: Clutter.ActorAlign.START});
        const actions = (notification.actions ?? []).slice(0, MAX_ACTIONS).map(action => [action.label, () => action.activate()]);
        if (stacked)
            actions.unshift(['Abrir', () => notification.activate()]);
        for (const [name, run] of actions) {
            const button = new St.Button({style_class: 'joao-naction', label: name, can_focus: true,
                accessible_name: `${name}: ${text(notification)}`});
            button.connect('clicked', () => open(run));
            this._actions.add_child(button);
        }
        this.add_child(this._actions);
    }

    get buttons() {
        return this._actions.get_children();
    }

    // open: the whole text and the buttons.
    setOpen(open) {
        this._actions.visible = open && this._actions.get_n_children() > 0;
        this._text.clutter_text.line_wrap = open;
        this._text.clutter_text.ellipsize = open ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
    }
});

const Group = GObject.registerClass({
    Signals: {'toggled': {param_types: [GObject.TYPE_BOOLEAN]}},
}, class JoaoNotificationGroup extends St.BoxLayout {
    // notifications: the app's, newest first. open(run): closes the page and runs.
    _init(source, notifications, {expanded, open}) {
        super._init({style_class: 'joao-ngroup', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.source = source;
        const [newest] = notifications;
        const count = notifications.length;
        this.stacked = count > 1;
        this._open = open;

        this.card = new St.Button({style_class: 'joao-ncard', can_focus: true, x_expand: true,
            accessible_name: this.stacked
                ? `${sourceName(source)}: ${count} notificaciones. Clic para ver todas`
                : `${sourceName(source)}: ${text(newest)}`});
        const box = new St.BoxLayout({style_class: 'joao-ncard-box', x_expand: true});
        box.add_child(new St.Icon({style_class: 'joao-ncard-icon', gicon: sourceIcon(newest) ?? newest.gicon,
            icon_size: 28, y_align: Clutter.ActorAlign.START}));
        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const head = new St.BoxLayout({x_expand: true});
        head.add_child(label('joao-ncard-app', this.stacked ? `${sourceName(source)} · ${count}` : sourceName(source)));
        head.add_child(new St.Label({style_class: 'joao-ncard-time', text: newest.datetime ? formatTimeSpan(newest.datetime) : ''}));
        words.add_child(head);

        this.entries = notifications.map(n => new Entry(n, open, this.stacked));
        words.add_child(this.entries[0]);
        this._rest = new St.BoxLayout({style_class: 'joao-ncard-rest', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, clip_to_allocation: true});
        this.entries.slice(1).forEach(e => this._rest.add_child(e));
        if (this.stacked) {
            words.add_child(this._rest);
            this._more = new St.Label({style_class: 'joao-ncard-more'});
            words.add_child(this._more);
        }
        box.add_child(words);
        this.card.set_child(box);
        this.add_child(this.card);

        this._stack = [];
        if (this.stacked) {
            for (const n of [1, 2]) {
                const strip = new St.Widget({style_class: `joao-ncard-stack s${n}`, x_expand: true});
                this._stack.push(strip);
                this.add_child(strip);
            }
        }
        this.card.connect('clicked', () => {
            if (this.stacked)
                this.setExpanded(!this.expanded, true);
            else
                open(() => newest.activate());
        });
        this.setExpanded(this.stacked ? expanded : true, false);
    }

    setExpanded(expanded, animate) {
        this.expanded = expanded;
        this.entries.forEach(e => e.setOpen(expanded));
        if (!this.stacked)
            return;
        this._more.text = expanded ? 'Contraer' : more(this.entries.length - 1);
        this.card.accessible_name = this.card.accessible_name.replace(/Clic para (ver todas|contraer)$/,
            expanded ? 'Clic para contraer' : 'Clic para ver todas');
        if (expanded)
            this.card.add_style_class_name('open');
        else
            this.card.remove_style_class_name('open');
        const rest = this._rest;
        rest.remove_transition('height');
        this._stack.forEach(s => s.remove_transition('opacity'));
        if (!animate || !rest.has_allocation()) {
            rest.height = expanded ? -1 : 0;
            this._stack.forEach(s => {
                s.visible = !expanded;
                s.opacity = 255;
            });
        } else {
            const from = rest.get_height();
            rest.height = -1;
            const [, natural] = rest.get_preferred_height(rest.get_width());
            rest.height = from;
            rest.ease({
                height: expanded ? natural : 0,
                duration: GROW,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT,
                onStopped: done => {
                    if (done && this.expanded)
                        rest.height = -1;
                },
            });
            this._stack.forEach(s => {
                s.show();
                s.ease({
                    opacity: expanded ? 0 : 255,
                    duration: GROW / 2,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => {
                        s.visible = !this.expanded;
                    },
                });
            });
        }
        this.emit('toggled', expanded);
    }
});

export const NotificationsBlock = GObject.registerClass(
class JoaoNotificationsBlock extends St.BoxLayout {
    _init({tooltip, close}) {
        super._init({style_class: 'escenas-full-block', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._close = close;
        this._expanded = new Set();
        const head = new St.BoxLayout({x_expand: true});
        head.add_child(new St.Label({style_class: 'escenas-full-block-title', text: 'Notificaciones', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this.clear = new St.Button({style_class: 'joao-cal-link', label: 'Borrar todo', can_focus: true, accessible_name: 'Borrar todas las notificaciones'});
        this.clear.connect('clicked', () => this._clearAll());
        tooltip.attach(this.clear, 'Borrar todas las notificaciones');
        head.add_child(this.clear);
        this.add_child(head);

        this.notes = noteStore();
        this.pin = new PinnedNote(this.notes);
        this.add_child(this.pin);

        this._empty = new St.Label({style_class: 'escenas-full-empty', text: 'No hay notificaciones'});
        this.add_child(this._empty);
        this._list = new St.BoxLayout({style_class: 'joao-ngroups', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.add_child(this._list);

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

    get groups() {
        return this._list.get_children();
    }

    // The page opens: the note file may have been edited by hand.
    refresh() {
        this.notes.reload();
        this.rebuild();
    }

    rebuild() {
        const bySource = new Map();
        for (const {source, notification} of this.all) {
            if (!bySource.has(source))
                bySource.set(source, []);
            bySource.get(source).push(notification);
        }
        for (const source of this._expanded) {
            if (!bySource.has(source))
                this._expanded.delete(source);
        }
        this._list.destroy_all_children();
        for (const [source, notifications] of bySource) {
            const group = new Group(source, notifications, {
                expanded: this._expanded.has(source),
                open: run => {
                    this._close();
                    run();
                },
            });
            group.connect('toggled', (g, expanded) => {
                if (expanded)
                    this._expanded.add(source);
                else
                    this._expanded.delete(source);
            });
            this._list.add_child(group);
        }
        this._empty.visible = bySource.size === 0;
        this.clear.visible = bySource.size > 0;
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
