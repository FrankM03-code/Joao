// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What is in use, when the strip's bubble cannot say it (its border lights up, appsBubble.js): a
// dot per device, at the top of the screen and over everything, fullscreen too, for when the strip is out of
// sight or off. Hovering either one opens the list of apps.
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {escenasStrip} from '../franja/escenasMode.js';
import {Signals} from '../sistema/gnome.js';
import {DEVICES, DEVICE_INFO, privacyMonitor} from './privacyMonitor.js';
import {canCut, canGoTo, cut, cutIcon, cutLabel, goToApp} from './stopActions.js';

const MARGIN = 16;
const DOT_ROOM = 8;       // padding around the dots (stylesheet), so they are easier to hit
const LIST_GAP = 4;
const LEAVE_MARGIN = 300;
const LIST_TIME = 180;
const LIST_SHIFT = 8;
const DOT_TIME = 200;
const SHORTCUT = 'privacy-list-shortcut';

let current = null;
export const privacyCorner = () => current;

// x for something this wide, in this place of the screen.
function alongEdge(corner, monitor, width, margin) {
    if (corner.endsWith('center'))
        return monitor.x + (monitor.width - width) / 2;
    return corner.endsWith('left') ? monitor.x + margin : monitor.x + monitor.width - width - margin;
}

function who(monitor) {
    return monitor.active.map(device =>
        `${DEVICE_INFO[device].name} en uso por ${monitor.state[device].map(e => e.name).join(', ')}`).join('; ');
}

export const CornerIndicator = GObject.registerClass(
class JoaoCornerIndicator extends St.BoxLayout {
    _init(settings, topBar, view) {
        super._init({
            style_class: 'joao-privacy-dots',
            reactive: true,
            track_hover: true,
            can_focus: true,
            visible: false,
            accessible_role: Atk.Role.NOTIFICATION,
        });
        this._settings = settings;
        this._topBar = topBar;
        this._view = view;
        this._monitor = privacyMonitor();
        this._showing = false;
        this._bubble = null;
        this._bubbleHover = false;
        this._announced = new Set();
        current = this;

        this._dots = new Map();
        for (const device of DEVICES) {
            const dot = new St.Widget({style_class: `joao-privacy-dot ${device}`, y_align: Clutter.ActorAlign.CENTER, visible: false});
            dot.set_pivot_point(0.5, 0.5);
            this._dots.set(device, dot);
            this.add_child(dot);
        }

        this._list = new St.BoxLayout({
            style_class: 'joao-privacy-list',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
            visible: false,
        });
        Main.layoutManager.addTopChrome(this);
        Main.layoutManager.addTopChrome(this._list);

        this.connect('notify::hover', () => this._syncHover());
        this._list.connect('notify::hover', () => this._syncHover());
        this.connect('key-press-event', (a, event) => this._onKey(event));
        this._list.connect('key-press-event', (a, event) => this._onKey(event));
        // These arrive in the middle of a layout pass, which a move would disturb.
        this.connect('notify::width', () => this._placeLater());
        this._list.connect('notify::height', () => this._placeLater());

        this._signals = new Signals();
        this._signals.connect(this._monitor, 'changed', () => this._sync());
        this._signals.connect(Main.layoutManager, 'monitors-changed', () => this._place());
        this._signals.connect(Main.sessionMode, 'updated', () => this._sync());
        this._signals.connect(settings, 'changed::hide-top-bar', () => this._sync());
        this._signals.connect(settings, 'changed::privacy-dots', () => this._sync());
        this._signals.connect(settings, 'changed::privacy-show-when-panel', () => this._sync());
        this._signals.connect(settings, 'changed::privacy-indicator-corner', () => this._place());
        // The page has its own pill.
        this._signals.connect(view, 'notify::visible', () => this._sync());

        Main.wm.addKeybinding(SHORTCUT, settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this._openFromKeyboard());
        escenasStrip()?.appsBubble?.sync();
        this._sync();
    }

    keepBelow(actor) {
        this._over = actor;
    }

    // The bubble says it is on screen (its actor) or not (null).
    setBubble(actor) {
        if (actor === this._bubble)
            return;
        this._bubble = actor;
        this._sync();
    }

    bubbleHover(on) {
        this._bubbleHover = on;
        this._syncHover();
    }

    get listHover() {
        return this._list.visible && this._list.hover;
    }

    placeLater() {
        this._placeLater();
    }

    // The page has its own pill, and takes every click.
    get _canList() {
        return this._monitor.active.length > 0 && !this._view.visible && !Main.sessionMode.isLocked;
    }

    get _shouldShow() {
        return this._canList && !this._bubble && this._settings.get_boolean('privacy-dots') &&
            (this._topBar.hidden || this._settings.get_boolean('privacy-show-when-panel'));
    }

    _sync() {
        const active = this._monitor.active;
        for (const [device, dot] of this._dots)
            this._setDot(dot, active.includes(device));
        this.accessible_name = who(this._monitor);
        this._announce(active);

        const show = this._shouldShow;
        if (show !== this._showing) {
            this._showing = show;
            // A fullscreen window on X11 would otherwise go straight to the screen, over the shell.
            if (show)
                global.compositor.disable_unredirect();
            else
                global.compositor.enable_unredirect();
        }
        this.remove_transition('opacity');
        if (show) {
            if (!this.visible) {
                this.opacity = 0;
                this.show();
            }
            Main.layoutManager.uiGroup.set_child_above_sibling(this, null);
            // The island arrives in this same spot and goes over the dots while it is there.
            if (this._over?.visible)
                Main.layoutManager.uiGroup.set_child_above_sibling(this._over, null);
            this.ease({opacity: 255, duration: DOT_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._place();
        } else if (this.visible) {
            this.ease({opacity: 0, duration: DOT_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this.hide()});
        }
        if (this._list.visible) {
            if (this._canList)
                this._fillList();
            else
                this._closeList(false);
        }
    }

    _setDot(dot, on) {
        if (on === dot._on)
            return;
        dot._on = on;
        dot.remove_all_transitions();
        if (on) {
            dot.show();
            dot.set({scale_x: 0.6, scale_y: 0.6, opacity: 0});
            dot.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: DOT_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            dot.hide();
        }
    }

    // The first use of each device in the session: said aloud by a screen reader.
    _announce(active) {
        const fresh = active.filter(device => !this._announced.has(device));
        if (!fresh.length)
            return;
        fresh.forEach(device => this._announced.add(device));
        this.get_accessible()?.notify_state_change?.(Atk.StateType.SHOWING, true);
    }

    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const corner = this._settings.get_string('privacy-indicator-corner');
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(-1);
        const margin = (MARGIN - DOT_ROOM) * scale;
        this.set_position(
            Math.round(alongEdge(corner, monitor, width, margin)),
            Math.round(corner.startsWith('bottom') ? monitor.y + monitor.height - height - margin : monitor.y + margin));
        this._placeList();
    }

    _placeLater() {
        if (this._placeLaterId)
            return;
        this._placeLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._placeLaterId = 0;
            this._place();
            return false;
        });
    }

    _placeList() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._list.visible)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const corner = this._settings.get_string('privacy-indicator-corner');
        const [, width] = this._list.get_preferred_width(-1);
        const [, height] = this._list.get_preferred_height(width);
        const margin = MARGIN * scale;
        const gap = LIST_GAP * scale;
        if (this._bubble) {
            // Beside the bubble, towards the middle of the screen, and never below the screen.
            const [x, y] = this._bubble.get_transformed_position();
            const [w, h] = this._bubble.get_transformed_size();
            const onLeft = x + w / 2 < monitor.x + monitor.width / 2;
            // Above the list of notifications, when it is there too.
            const notifications = escenasStrip()?.appsBubble?.notifyList;
            const under = notifications?.visible ? notifications.height + gap : 0;
            this._list.set_position(
                Math.round(onLeft ? x + w + gap : x - width - gap),
                Math.round(Math.min(y + h - height, monitor.y + monitor.height - height - margin) - under));
            return;
        }
        this._list.set_position(
            Math.round(alongEdge(corner, monitor, width, margin)),
            Math.round(corner.startsWith('bottom') ? this.y - height - gap : this.y + this.height + gap));
    }

    // ---------- the list ----------

    _syncHover() {
        escenasStrip()?.appsBubble?.otherListHover();
        if (this._leaveId)
            GLib.source_remove(this._leaveId);
        this._leaveId = 0;
        if (this.hover || this._list.hover || this._bubbleHover) {
            this._openList();
            return;
        }
        if (this._list.visible && !this._byKeyboard) {
            this._leaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVE_MARGIN, () => {
                this._leaveId = 0;
                this._closeList(true);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _openFromKeyboard() {
        if (!this._canList)
            return;
        this._byKeyboard = true;
        this._openList();
        this._returnFocus = global.stage.get_key_focus();
        if (!this._list.navigate_focus(null, St.DirectionType.TAB_FORWARD, false))
            this._list.grab_key_focus();
    }

    _onKey(event) {
        if (event.get_key_symbol() !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        this._closeList(true);
        return Clutter.EVENT_STOP;
    }

    _openList() {
        if (!this._canList)
            return;
        const wasOpen = this._list.visible;
        this._fillList();
        if (wasOpen && !this._closing)
            return;
        this._closing = false;
        this._list.remove_all_transitions();
        const fromBelow = this._settings.get_string('privacy-indicator-corner').startsWith('bottom');
        if (!wasOpen)
            this._list.set({opacity: 0, translation_y: fromBelow ? LIST_SHIFT : -LIST_SHIFT, visible: true});
        Main.layoutManager.uiGroup.set_child_above_sibling(this._list, null);
        this._placeList();
        this._list.ease({opacity: 255, translation_y: 0, duration: LIST_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _closeList(animate) {
        this._byKeyboard = false;
        if (this._returnFocus !== undefined) {
            if (this._list.contains(global.stage.get_key_focus()))
                global.stage.set_key_focus(this._returnFocus);
            this._returnFocus = undefined;
        }
        if (!this._list.visible)
            return;
        this._list.remove_all_transitions();
        if (!animate) {
            this._closing = false;
            this._list.hide();
            return;
        }
        this._closing = true;
        this._list.ease({opacity: 0, translation_y: -LIST_SHIFT, duration: LIST_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._closing = false;
                this._list.hide();
            }});
    }

    _fillList() {
        this._list.destroy_all_children();
        for (const device of this._monitor.active) {
            for (const entry of this._monitor.state[device])
                this._list.add_child(this._row(device, entry));
        }
    }

    _row(device, entry) {
        const info = DEVICE_INFO[device];
        const row = new St.BoxLayout({style_class: `joao-privacy-row ${device}`, x_expand: true});
        row.add_child(new St.Bin({
            style_class: `joao-privacy-row-icon ${device}`,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: info.icon, icon_size: 15}),
        }));

        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        words.add_child(new St.Label({style_class: 'joao-privacy-row-device', text: info.name}));
        const name = new St.Label({style_class: 'joao-privacy-row-app', text: entry.name});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        if (canGoTo(entry)) {
            const go = new St.Button({
                style_class: 'joao-privacy-row-go',
                can_focus: true,
                x_align: Clutter.ActorAlign.START,
                child: name,
                accessible_name: `Ir a ${entry.name}`,
            });
            go.connect('clicked', () => {
                this._closeList(false);
                goToApp(entry);
            });
            words.add_child(go);
        } else {
            words.add_child(name);
        }
        row.add_child(words);

        if (canCut(device, entry)) {
            const stop = new St.Button({
                style_class: 'joao-privacy-row-stop',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                accessible_name: cutLabel(device, entry),
                child: new St.Icon({icon_name: cutIcon(device, entry), icon_size: 15}),
            });
            stop.connect('clicked', () => cut(device, entry));
            row.add_child(stop);
        }
        return row;
    }

    destroy() {
        current = null;
        if (this._leaveId)
            GLib.source_remove(this._leaveId);
        this._leaveId = 0;
        if (this._placeLaterId)
            global.compositor.get_laters().remove(this._placeLaterId);
        this._placeLaterId = 0;
        Main.wm.removeKeybinding(SHORTCUT);
        this._signals.disconnectAll();
        if (this._showing)
            global.compositor.enable_unredirect();
        this._showing = false;
        Main.layoutManager.removeChrome(this._list);
        this._list.destroy();
        Main.layoutManager.removeChrome(this);
        super.destroy();
    }
});
