// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The ring's tools (docs/menu-anillo-spec.md): the menu on the launcher button's right click
// (or a long press), the quick note (pinned in the panel), the clipboard and the timer, with their
// shortcuts (Super+Alt+N, Super+Alt+V, Super+T by default: Super+N and Super+V were taken).
// Everything opens beside the button, or in the bottom-left corner when the button is not in sight.
// When the timer ends: its notification goes through João's usual way (GNOME's tray → the bubble),
// the button shakes with a lilac halo, and a card with its buttons comes out of it.
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {appsBubble} from '../escenas/escenasLink.js';
import {noteStore} from '../sistema/taskStore.js';
import {AlarmCard} from './alarmCard.js';
import {ClipboardHistory} from './clipboardHistory.js';
import {ClipboardWindow} from './clipboardWindow.js';
import {NoteWindow} from './noteWindow.js';
import {Curtain} from './curtain.js';
import {Layer, scaleFactor} from './popup.js';
import {RingMenu} from './ringMenu.js';
import {clock, minutes, Timer} from './timer.js';
import {TimerWindow} from './timerWindow.js';

const GAP = 12;
const CORNER = 16;
const SHORTCUTS = {
    'ring-note-shortcut': 'note',
    'ring-clipboard-shortcut': 'clipboard',
    'ring-timer-shortcut': 'timer',
};
const PLUS = 5 * 60;
// The card's size for the big tools (docs/herramientas-ampliadas-spec.md), logical px.
const NOTE_SIZE = {width: 380, height: 440};
const CLIPBOARD_SIZE = {width: 380, height: 470};

let current = null;
export const ringTools = () => current;

export class RingTools {
    constructor(settings, view) {
        current = this;
        this._settings = settings;
        this._view = view;
        this._layer = null;
        this._popup = null;
        this._bubble = null;
        this._card = null;
        this._alarm = null;     // the notification of a timer that ended, until it is dealt with
        this.timer = new Timer();
        this.clipboard = new ClipboardHistory(settings);
        this.timer.connectObject(
            'changed', () => this._syncRing(),
            'tick', () => this._syncRing(),
            'finished', () => this._ring(),
            this);
        this._bind();
        this._settingIds = Object.keys(SHORTCUTS).map(key => settings.connect(`changed::${key}`, () => this._bind()));
        this._bubble = appsBubble();
    }

    // ---------- the launcher button ----------

    attachBubble(bubble) {
        this._bubble = bubble;
        this._syncRing();
    }

    detachBubble(bubble) {
        bubble.notifyList?.disconnectObject(this);
        if (this._bubble === bubble)
            this._bubble = null;
    }

    // Where the button is now, if it is in sight.
    _place() {
        const bubble = this._bubble;
        if (!bubble?.onScreen || !bubble.actor.visible || bubble.actor.opacity === 0)
            return null;
        const actor = bubble.actor;
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        const cx = x + w / 2;
        const cy = y + h / 2;
        const half = actor.width / 2;
        const monitor = Main.layoutManager.monitors.find(m => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) ??
            Main.layoutManager.primaryMonitor;
        const side = cx < monitor.x + monitor.width / 2 ? 1 : -1;
        return {x: cx + side * half, y: cy, top: cy - half, bottom: cy + half, side, monitor};
    }

    // Beside the button, from the ring's top downwards; or the bottom-left corner.
    _anchor() {
        const place = this._place();
        if (place)
            return {...place, x: place.x + place.side * GAP * scaleFactor()};
        const monitor = Main.layoutManager.primaryMonitor;
        const margin = CORNER * scaleFactor();
        return {x: monitor.x + margin, y: monitor.y + monitor.height - margin, top: null, bottom: monitor.y + monitor.height - margin,
            side: 1, monitor};
    }

    // Nothing follows the button for now (the note's pill beside it went away: Frank 2026-11-07).
    bubbleMoved() {}

    // ---------- the menu and the windows ----------

    get isOpen() {
        return !!this._layer;
    }

    // The timer's card is beside the button: the notifications' list stays away from it.
    get cardShown() {
        return !!this._card;
    }

    _ensureLayer() {
        if (this._layer)
            return true;
        if (this._view?.isOpen)
            this._view.close({animate: false});
        const layer = new Layer();
        if (layer.failed) {
            layer.destroy();
            return false;
        }
        // A click outside the card closes it; so does one on the ring (it is above the layer, but the
        // layer holds the input), which is how the menu goes back to the scenes.
        layer.connect('outside', () => this.closeAll());
        layer.connect('escape', () => {
            if (this._popup)
                this._popup.escape();
            else
                this.closeAll();
        });
        this._layer = layer;
        this._curtain = new Curtain(layer);
        this._bubble?.setMenuOpen(true);
        return true;
    }

    _show(page) {
        const first = !this._popup;
        this._popup = page;
        if (first)
            this._curtain.open(page);
        else
            this._curtain.swap(page);
    }

    // Right click on the ring: the menu, or back to the scenes if it is open.
    toggleMenu() {
        if (this._layer)
            this.closeAll();
        else
            this.openMenu();
    }

    openMenu() {
        if (!this._ensureLayer())
            return;
        const menu = new RingMenu({settings: this._settings, timer: this.timer, pick: id => this.openTool(id)});
        menu.escape = () => this.closeAll();
        this._show(menu);
    }

    // note: a note to edit, for the note's page. label: the timer's, from "Recordarme".
    openTool(id, note = null, label = null) {
        if (this._popup?.toolId === id && !note) {
            this.closeAll();
            return;
        }
        if (!this._ensureLayer())
            return;
        const back = () => this.openMenu();
        let page;
        if (id === 'note') {
            page = new NoteWindow({
                store: noteStore(), note, back, layer: this._layer,
                // Pinned: it shows in the panel, above the notifications.
                pinned: () => this.closeAll(),
                remind: label => this.openTool('timer', null, label),
                copy: text => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text),
            });
            page.cardSize = NOTE_SIZE;
        } else if (id === 'clipboard') {
            page = new ClipboardWindow({history: this.clipboard, back, done: () => this.closeAll(), layer: this._layer});
            page.cardSize = CLIPBOARD_SIZE;
        } else {
            page = new TimerWindow({timer: this.timer, back, started: () => this.closeAll(), label});
        }
        page.toolId = id;
        page.enter ??= () => page.focus();
        this._show(page);
    }

    closeAll() {
        const layer = this._layer;
        const curtain = this._curtain;
        this._layer = null;
        this._popup = null;
        this._curtain = null;
        if (!layer)
            return;
        layer.release();
        this._bubble?.setMenuOpen(false);
        curtain.close(() => {
            curtain.destroy();
            layer.destroy();
        });
    }

    // ---------- shortcuts ----------

    _bind() {
        this._unbind();
        this._bound = Object.keys(SHORTCUTS).filter(key => this._settings.get_strv(key).length);
        for (const key of this._bound) {
            Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => this.openTool(SHORTCUTS[key]));
        }
    }

    _unbind() {
        (this._bound ?? []).forEach(key => Main.wm.removeKeybinding(key));
        this._bound = [];
    }

    // ---------- the timer ----------

    // The time left in the middle of the button and the lilac arc; 00:00 while the alarm waits.
    _syncRing() {
        const t = this.timer;
        if (t.active)
            this._bubble?.setTimer(clock(t.remaining), t.fraction);
        else if (this._alarm)
            this._bubble?.setTimer(clock(0), 0);
        else
            this._bubble?.setTimer(null, null);
    }

    _source() {
        if (!this._notifySource) {
            this._notifySource = new MessageTray.Source({title: 'Temporizador', iconName: 'alarm-symbolic'});
            this._notifySource.connect('destroy', () => {
                this._notifySource = null;
            });
            Main.messageTray.add(this._notifySource);
        }
        return this._notifySource;
    }

    _ring() {
        const label = this.timer.label;
        const duration = this.timer.duration;
        this._endAlarm();
        const body = label ? `${label} · ¡listo!` : '¡Tiempo!';
        const sub = `Pasaron ${minutes(duration)}`;
        const source = this._source();
        // Critical: GNOME lets nothing less through "No molestar", and this alarm was asked for.
        const notification = new MessageTray.Notification({
            source, title: 'Temporizador', body: `${body}\n${sub}`,
            urgency: MessageTray.Urgency.CRITICAL, isTransient: false,
        });
        notification.addAction('+5 min', () => this.timer.start(PLUS, label));
        notification.addAction('Repetir', () => this.timer.start(duration, label));
        notification.connectObject('destroy', () => {
            if (this._alarm === notification)
                this._alarm = null;
            this._card?.close();
            this._syncRing();
        }, this);
        this._alarm = notification;
        source.addNotification(notification);
        global.display.get_sound_player().play_from_theme('alarm-clock-elapsed', 'Temporizador', null);
        this._syncRing();
        this._bubble?.alarm();
        this._showCard(notification, body, sub);
    }

    _showCard(notification, body, sub) {
        // Under the page it could not be clicked: the notification waits in the panel instead.
        if (this._view?.isOpen)
            return;
        const run = name => () => notification.actions.find(a => a.label === name)?.activate();
        const card = new AlarmCard({body, sub, actions: [
            ['+5 min', run('+5 min'), true],
            ['Repetir', run('Repetir'), false],
            ['Cerrar', () => notification.destroy(), false],
        ]});
        card.connect('destroy', () => {
            if (this._card === card)
                this._card = null;
            });
        this._card = card;
        this._bubble?.notifyList?.close(false);
        card.show(this._anchor());
    }

    _endAlarm() {
        const alarm = this._alarm;
        this._alarm = null;
        alarm?.disconnectObject(this);
        alarm?.destroy();
        this._card?.close();
    }

    // ---------- off ----------

    destroy() {
        this._unbind();
        this._settingIds.forEach(id => this._settings.disconnect(id));
        if (this._layer) {
            this._curtain?.destroy();
            this._layer.destroy();
            this._layer = this._curtain = this._popup = null;
            this._bubble?.setMenuOpen(false);
        }
        this._alarm?.disconnectObject(this);
        this._alarm = null;
        if (this._card) {
            Main.layoutManager.removeChrome(this._card);
            this._card.destroy();
        }
        this._card = null;
        this._notifySource?.destroy();
        this._notifySource = null;
        this._bubble?.notifyList?.disconnectObject(this);
        this._bubble?.setTimer(null, null);
        this.timer.disconnectObject(this);
        this.timer.destroy();
        this.clipboard.destroy();
        if (current === this)
            current = null;
    }
}
