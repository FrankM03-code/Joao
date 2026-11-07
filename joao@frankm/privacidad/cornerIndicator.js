// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What is in use, when the strip's bubble cannot say it (its border lights up, appsBubble.js): a
// dot per device, at the top of the screen and over everything, fullscreen too, for when the strip is out of
// sight or off. Hovering either one opens the card of what is in use (tray.js).
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {connectKeyPress} from '../escritorio/keyEvents.js';
import {escenasStrip} from '../franja/escenasMode.js';
import {Signals} from '../sistema/gnome.js';
import {DEVICES, DEVICE_INFO, privacyMonitor} from './privacyMonitor.js';
import {RING_ORDER} from './segmentRing.js';
import {canCut, canGoTo, cut, goToApp, isMuted} from './stopActions.js';
import {CompactTray} from './tray.js';

const MARGIN = 16;
const DOT_ROOM = 8;       // padding around the dots (stylesheet), so they are easier to hit
const TRAY_GAP = 6;
const LEAVE_MARGIN = 150;
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

        Main.layoutManager.addTopChrome(this);
        this._tray = new CompactTray();

        this.connect('notify::hover', () => this._syncHover());
        this._tray.connect('notify::hover', () => this._syncHover());
        connectKeyPress(this, event => this._onKey(event));
        connectKeyPress(this._tray, event => this._onKey(event));
        // These arrive in the middle of a layout pass, which a move would disturb.
        this.connect('notify::width', () => this._placeLater());
        this._tray.connect('notify::width', () => this._placeLater());

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
        if (on === this._bubbleHover)
            return;
        this._bubbleHover = on;
        this._syncHover();
    }

    get trayHover() {
        return this._tray.visible && this._tray.hover;
    }

    // Where the chips start, for the list of notifications that goes above them.
    get chipsTop() {
        return this._bubble && this._tray.visible && this._tray.chips.length > 0 ? this._tray.y : null;
    }

    // The bubble moved.
    placeLater() {
        if (this._tray.visible)
            this._placeLater();
    }

    // The notifications changed, or whether the bubble tells them.
    refreshTray() {
        this._syncTray();
    }

    openFromKeyboard() {
        this._openFromKeyboard();
    }

    // The page has its own pill, and takes every click.
    get _free() {
        return !this._view.visible && !Main.sessionMode.isLocked;
    }

    get _canTray() {
        return this._free && this._monitor.active.length > 0;
    }

    get _wantsTray() {
        return this.hover || this._tray.hover || this._bubbleHover;
    }

    get _shouldShow() {
        return this._free && this._monitor.active.length > 0 && !this._bubble && this._settings.get_boolean('privacy-dots') &&
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
        this._syncTray();
    }

    _syncTray() {
        if (!this._canTray)
            this._closeTray(this._tray.visible);
        else if (this._tray.visible)
            this._fillTray();
        else if (this._wantsTray)
            this._openTray();
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
        this._placeTray();
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

    _placeTray() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._tray.visible)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, width] = this._tray.get_preferred_width(-1);
        const [, height] = this._tray.get_preferred_height(width);
        const margin = MARGIN * scale;
        const gap = TRAY_GAP * scale;
        if (this._bubble) {
            this._tray.set_position(...this._besideBubble(monitor, width, height, gap, margin));
        } else {
            const corner = this._settings.get_string('privacy-indicator-corner');
            this._tray.set_position(
                Math.round(alongEdge(corner, monitor, width, margin)),
                Math.round(corner.startsWith('bottom') ? this.y - height - gap : this.y + this.height + gap));
        }
        this._chipsMoved();
    }

    // Towards the middle of the screen, its bottom level with the bubble's, whatever its hover scale.
    _besideBubble(monitor, width, height, gap, margin) {
        const [x, y] = this._bubble.get_transformed_position();
        const [w, h] = this._bubble.get_transformed_size();
        const centerX = x + w / 2;
        const centerY = y + h / 2;
        const half = this._bubble.width / 2;
        const top = Math.min(centerY + half - height, monitor.y + monitor.height - height - margin);
        return [
            Math.round(this._towardsRight ? centerX + half + gap : centerX - half - gap - width),
            Math.round(Math.max(monitor.y + margin, top)),
        ];
    }

    get _towardsRight() {
        if (!this._bubble)
            return true;
        const monitor = Main.layoutManager.primaryMonitor;
        const [x] = this._bubble.get_transformed_position();
        const [w] = this._bubble.get_transformed_size();
        return !monitor || x + w / 2 < monitor.x + monitor.width / 2;
    }

    _chipsMoved() {
        const top = this.chipsTop;
        if (top === this._lastChipsTop)
            return;
        this._lastChipsTop = top;
        escenasStrip()?.appsBubble?.notifyList?.chipsMoved();
    }

    // ---------- the tray ----------

    _syncHover() {
        escenasStrip()?.appsBubble?.otherListHover();
        if (this._leaveId)
            GLib.source_remove(this._leaveId);
        this._leaveId = 0;
        if (this._wantsTray) {
            this._openTray();
            return;
        }
        if (this._tray.visible && !this._byKeyboard) {
            this._leaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVE_MARGIN, () => {
                this._leaveId = 0;
                this._closeTray(true);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _openFromKeyboard() {
        if (!this._canTray)
            return;
        this._byKeyboard = true;
        this._openTray();
        this._returnFocus = global.stage.get_key_focus();
        if (!this._tray.navigate_focus(null, St.DirectionType.TAB_FORWARD, false))
            this._tray.grab_key_focus();
    }

    _onKey(event) {
        if (event.get_key_symbol() !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        this._closeTray(true);
        return Clutter.EVENT_STOP;
    }

    _openTray() {
        if (!this._canTray) {
            this._closeTray(false);
            return;
        }
        this._fillTray();
        if (this._tray.isShowing)
            return;
        this._tray.reveal(this._towardsRight ? 1 : -1);
        Main.layoutManager.uiGroup.set_child_above_sibling(this._tray, null);
        this._placeTray();
    }

    _closeTray(animate) {
        this._byKeyboard = false;
        if (this._returnFocus !== undefined) {
            if (this._tray.contains(global.stage.get_key_focus()))
                global.stage.set_key_focus(this._returnFocus);
            this._returnFocus = undefined;
        }
        this._tray.conceal(animate);
        if (!animate)
            this._chipsMoved();
    }

    _fillTray() {
        this._tray.update(this._uses());
        this._placeLater();
    }

    _uses() {
        return RING_ORDER.flatMap(device =>
            this._monitor.state[device].map(entry => this._use(device, entry)));
    }

    // The stop button does what can be done (a camera cannot be cut: no button there); the row
    // goes to the app.
    _use(device, entry) {
        const info = DEVICE_INFO[device];
        const go = canGoTo(entry) ? () => {
            this._closeTray(false);
            goToApp(entry);
        } : null;
        const muted = device === 'microphone' && isMuted(entry);
        const stopLabel = !canCut(device, entry) ? null
            : device === 'screen' ? 'Detener pantalla'
            : muted ? 'Reactivar micrófono' : 'Silenciar micrófono';
        const appIcon = entry.app?.get_icon() ?? null;
        return {
            key: `${device}:${entry.appId ?? entry.name}`,
            device,
            title: info.short,
            app: entry.name,
            gicon: appIcon ?? new Gio.ThemedIcon({name: info.icon}),
            appIcon: !!appIcon,
            since: entry.since,
            muted,
            stopLabel,
            description: [`${info.short}: ${entry.name}`, stopLabel, go && `Ir a ${entry.name}`].filter(Boolean).join('. '),
            onStop: stopLabel ? () => cut(device, entry) : null,
            onGo: go,
        };
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
        this._tray.destroy();
        Main.layoutManager.removeChrome(this);
        super.destroy();
    }
});
