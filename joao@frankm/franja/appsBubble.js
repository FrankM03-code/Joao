// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The round button on the strip's bottom edge that opens the launcher page. While the page is open
// the bubble lives inside it, because the page holds the input (pushModal) and a button outside it
// could not be clicked; there it shows a × in the same spot. The page moves it in and out
// (enterDrawer, leaveDrawer) and animates itself. Its border lights up in the colour of the
// microphone, the camera or the screen while one of them is in use. Notifications arrive here too
// (bubbleNotify.js, notifyList.js). Right click (or a long press) opens the ring's menu
// (anillo/ringTools.js); while its timer runs, the time left takes the place of the grid.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ringTools} from '../anillo/ringTools.js';
import {notificationStore} from '../notificaciones/notificationStore.js';
import {privacyCorner} from '../privacidad/cornerIndicator.js';
import {DEVICE_INFO, privacyMonitor} from '../privacidad/privacyMonitor.js';
import {SegmentRing} from '../privacidad/segmentRing.js';
import {isMuted} from '../privacidad/stopActions.js';
import {BubbleNotify} from './bubbleNotify.js';
import {NotifyList} from './notifyList.js';

const RING_RADIUS = 35;     // the button's radius (29) + 6
const ROOT_SIZE = 74;       // stylesheet: the focus ring, the widest part
const LIGHT_SIZE = 72;
const LIGHT_END = 110;
const center = () => new Graphene.Point({x: 0.5, y: 0.5});
const LONG_PRESS = 600;
// The timer's end: the button shakes twice (angle, scale) and a lilac halo goes out twice.
const SHAKE = [[-12, 1.08], [10, 1.08], [-8, 1.06], [6, 1.04], [-3, 1.02], [0, 1]];
const SHAKE_STEP = 150;
const HALO_TIME = 1200;
const HALO_SCALE = 1.9;

// Free space the strip must leave under itself: half the bubble and its ring, and a gap.
export const BUBBLE_ROOM = 38;
// What the strip's padding grows at the bottom (stylesheet: .con-burbuja, 42 instead of 10).
export const BUBBLE_INSET = 32;
const PEEK_FADE = 200;
const animations = () => St.Settings.get().enable_animations;
const PEEK_CHECK = 400;     // ms between looks at the pointer before leaving

function circle(styleClass, params = {}) {
    return new St.Widget({
        style_class: styleClass,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        pivot_point: center(),
        ...params,
    });
}

export class AppsBubble {
    constructor(strip, settings, view) {
        this._strip = strip;
        this._view = view;
        this._settings = settings;
        this._drawer = null;
        this._open = false;

        this.actor = new St.Widget({
            name: 'escenasAppsBubble',
            style_class: 'escenas-apps-bubble-root',
            layout_manager: new Clutter.BinLayout(),
            pivot_point: center(),
            visible: false,
        });
        this._focusRing = circle('escenas-apps-bubble-focus', {visible: false});
        this._ring = circle('escenas-apps-bubble-ring');
        this._light = circle('escenas-apps-bubble-light', {opacity: 0});
        this._privacyBorder = new SegmentRing(RING_RADIUS, {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            pivot_point: center()});
        this._grid = new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: 21, pivot_point: center()});
        this._cross = new St.Icon({icon_name: 'window-close-symbolic', icon_size: 21, pivot_point: center(),
            opacity: 0, rotation_angle_z: -90});
        this._time = new St.Label({style_class: 'joao-ring-time', visible: false,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._halo = circle('joao-ring-halo', {opacity: 0});
        const icons = new St.Widget({layout_manager: new Clutter.BinLayout()});
        icons.add_child(this._grid);
        icons.add_child(this._cross);
        icons.add_child(this._time);
        this._button = new St.Button({
            style_class: 'escenas-apps-bubble',
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: icons,
            accessible_name: 'Abrir el cajón de apps',
        });
        this._notify = new BubbleNotify(this, settings, this._grid, icons);
        for (const part of [this._halo, this._focusRing, this._ring, this._notify.wave, this._privacyBorder, this._light, this._button, this._notify.count])
            this.actor.add_child(part);
        this.notifyList = new NotifyList(this, settings);
        this.notifyList.connect('notify::hover', () => this._syncListHover());

        this._button.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY || this._drawer)
                return Clutter.EVENT_PROPAGATE;
            ringTools()?.toggleMenu();
            return Clutter.EVENT_STOP;
        });
        this._button.connect('touch-event', (actor, event) => this._onTouch(event));
        this._button.connect('clicked', () => {
            // The long press already opened the menu: its release is not a click.
            if (this._longPressed) {
                this._longPressed = false;
                return;
            }
            // Unread ones: straight to where they are read.
            if (!this._open && this.showsNotifications && notificationStore().unread > 0)
                this._view.showSection('today');
            else
                this._view.toggle();
            this._flash();
        });
        this._button.connect('notify::hover', () => {
            this._easeScale(150, Clutter.AnimationMode.EASE_OUT_QUAD);
            if (this._button.hover)
                this._notify.pointerCame();
            this._syncListHover();
        });
        this._button.connect('notify::pressed', () => {
            if (this._button.pressed)
                this._easeScale(120, Clutter.AnimationMode.EASE_OUT_QUAD);
            else
                this._easeScale(420, Clutter.AnimationMode.EASE_OUT_BACK);
        });
        this._button.connect('scroll-event', (a, event) =>
            this._drawer ? Clutter.EVENT_PROPAGATE : this._strip.wheelVolume(event));
        this._button.connect('key-focus-in', () => this._focusRing.show());
        this._button.connect('key-focus-out', () => this._focusRing.hide());

        Main.layoutManager.addChrome(this.actor);
        this._stripIds = ['x', 'y', 'width', 'height', 'translation-x', 'opacity', 'visible']
            .map(prop => strip.actor.connect(`notify::${prop}`, () => this.sync()));
        this._settingIds = [
            settings.connect('changed::apps-bubble-visible', () => this.sync()),
            ...['notify-style', 'bubble-notifications', 'bubble-notify-list'].map(key =>
                settings.connect(`changed::${key}`, () => this._syncNotifications())),
        ];
        this._privacy = privacyMonitor();
        this._privacyId = this._privacy.connect('changed', () => this._syncPrivacy());
        this._syncPrivacy();
        this._notify.syncCount();
        this.sync();
        ringTools()?.attachBubble(this);
    }

    destroy() {
        ringTools()?.detachBubble(this);
        this._cancelLongPress();
        this._stopShake();
        if (this._haloId)
            GLib.source_remove(this._haloId);
        this._haloId = 0;
        this._stopPeek(false);
        this._stripIds.forEach(id => this._strip.actor.disconnect(id));
        this._settingIds.forEach(id => this._settings.disconnect(id));
        this._privacy.disconnect(this._privacyId);
        privacyCorner()?.bubbleHover(false);
        privacyCorner()?.setBubble(null);
        this._cancelLater();
        this.notifyList.destroy();
        this.notifyList = null;
        this._notify.destroy();
        this._notify = null;
        const drawer = this._drawer;
        this._drawer = null;
        if (drawer) {
            Main.layoutManager.untrackChrome(this.actor);
            drawer.forgetBubble();
        } else {
            Main.layoutManager.removeChrome(this.actor);
        }
        this.actor.destroy();
        this.actor = null;
    }

    get enabled() {
        return this._settings.get_boolean('apps-bubble-visible');
    }

    // The bubble's center on the stage at rest, also while the strip is out of sight.
    center() {
        const rect = this._strip.restingRect();
        return rect ? {x: Math.round(rect.x + rect.width / 2), y: rect.y + rect.height} : null;
    }

    get _size() {
        return ROOT_SIZE * St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    // Follows the strip; in the drawer it stays visible, at the strip's resting place.
    sync() {
        if (!this.actor)
            return;
        const half = this._size / 2;
        if (this._drawer) {
            const center = this.center();
            if (center)
                this.actor.set_position(center.x - this._drawer.x - half, center.y - this._drawer.y - half);
            return;
        }
        const strip = this._strip.actor;
        const center = this._peeking ? this.center() : null;
        if (center) {
            // Telling something while the strip is away: alone, at its resting place.
            this.actor.set_position(center.x - half, center.y - half);
        } else {
            this.actor.visible = this.enabled && strip.visible;
            this.actor.opacity = strip.opacity;
            this.actor.set_position(Math.round(strip.x + strip.translation_x + strip.width / 2 - half),
                Math.round(strip.y + strip.height - half));
        }
        // Out of sight it cannot warn of anything: the corner's dots do it then.
        privacyCorner()?.setBubble(this.actor.visible && this.actor.opacity > 0 ? this.actor : null);
        if (this.onScreen)
            this._notify.placeCaption();
        else
            this._notify.settle();
        if (!this.onScreen) {
            this.notifyList.close(false);
            privacyCorner()?.bubbleHover(false);
        }
        privacyCorner()?.placeLater();
        ringTools()?.bubbleMoved();
    }

    // ---------- the ring's tools ----------

    _onTouch(event) {
        const type = event.type();
        if (type === Clutter.EventType.TOUCH_BEGIN && !this._drawer) {
            this._cancelLongPress();
            this._longPressed = false;
            this._longPressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LONG_PRESS, () => {
                this._longPressId = 0;
                this._longPressed = true;
                ringTools()?.openMenu();
                return GLib.SOURCE_REMOVE;
            });
        } else if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) {
            this._cancelLongPress();
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _cancelLongPress() {
        if (this._longPressId)
            GLib.source_remove(this._longPressId);
        this._longPressId = 0;
    }

    // text: the time left ("12:40"), or null for the grid again. fraction: the lilac arc, 1 → 0.
    setTimer(text, fraction) {
        this._timerText = text;
        this._time.text = text ?? '';
        this._privacyBorder.setTimer(text === null ? null : fraction);
        this._syncTime();
        this.syncName();
    }

    // The scenes card is the ring's menu: the dots turn into a × and the ring is a little lighter.
    setMenuOpen(open) {
        if (this._menuOpen === open)
            return;
        this._menuOpen = open;
        if (open)
            this._button.add_style_class_name('menu');
        else
            this._button.remove_style_class_name('menu');
        this._syncTime();
        // The dots turn into the ×; the button itself does not move (no jump: Frank 2026-11-07).
        this._later(() => this._showIcon(open || this._open, Clutter.AnimationMode.EASE_OUT_QUAD, 350));
    }

    // Not while the page or the menu is open: the button shows its × then.
    _syncTime() {
        const on = !!this._timerText && !this._open && !this._menuOpen;
        this._time.visible = on;
        this._grid.visible = !on;
    }

    // The timer ended: the button shakes twice and a halo goes out of it, twice. Without
    // animations, a single flash of the halo.
    alarm() {
        this._later(() => {
            this._stopShake();
            this._sendHalo(animations() ? 2 : 1);
            if (!animations())
                return;
            const steps = [...SHAKE, ...SHAKE];
            const next = () => {
                const step = steps.shift();
                if (!step || !this.actor) {
                    this._shaking = false;
                    this._easeScale(SHAKE_STEP, Clutter.AnimationMode.EASE_OUT_QUAD);
                    return;
                }
                const [angle, scale] = step;
                this.actor.ease({rotation_angle_z: angle, scale_x: scale, scale_y: scale, duration: SHAKE_STEP,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD, onStopped: finished => finished && next()});
            };
            this._shaking = true;
            next();
        });
    }

    _stopShake() {
        if (!this._shaking || !this.actor)
            return;
        this._shaking = false;
        this.actor.remove_transition('rotation-angle-z');
        this.actor.rotation_angle_z = 0;
    }

    _sendHalo(times) {
        const halo = this._halo;
        halo.remove_all_transitions();
        if (!animations()) {
            // One still flash: shown for a moment, then gone.
            halo.set({scale_x: 1.3, scale_y: 1.3, opacity: 204});
            this._haloId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HALO_TIME / 2, () => {
                this._haloId = 0;
                halo.opacity = 0;
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        halo.set({scale_x: 1, scale_y: 1, opacity: 204});
        halo.ease({scale_x: HALO_SCALE, scale_y: HALO_SCALE, opacity: 0, duration: HALO_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => finished && times > 1 && this._sendHalo(times - 1)});
    }

    // ---------- notifications ----------

    get ring() {
        return this._ring;
    }

    get isOpen() {
        return this._open;
    }

    // Notifications are told here, not in the island.
    get showsNotifications() {
        return this.enabled && this._settings.get_string('notify-style') === 'bubble' &&
            this._settings.get_boolean('bubble-notifications');
    }

    // In sight and free to say something now. Not while sliding away or under the page.
    get onScreen() {
        return this.enabled && !this._drawer && this.actor.visible && (!this._strip.isAway || this._peeking);
    }

    // It can come out for a notification even with the strip away (a window over it, fullscreen,
    // the overview). Not on the lock screen or the login screen.
    get canTell() {
        return !this._drawer && !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter;
    }

    arrive(notification, total) {
        if (!this.onScreen)
            this._startPeek();
        this._cancelPeekEnd();
        this._later(() => this._notify?.arrive(notification, total));
    }

    _startPeek() {
        this.actor.remove_transition('opacity');
        const hidden = !this.actor.visible;
        if (hidden)
            this.actor.opacity = 0;
        if (!this._peeking) {
            this._peeking = true;
            // A fullscreen window on X11 skips the shell's painting unless told not to.
            global.compositor.disable_unredirect();
        }
        this.actor.show();
        this.sync();
        this._later(() => this._peeking && this.actor.ease({opacity: 255, duration: PEEK_FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD}));
    }

    // The bubble has gone back to calm: away with the strip, once the pointer is not on it.
    wentQuiet() {
        if (!this._peeking || this._peekEndId)
            return;
        this._peekEndId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PEEK_CHECK, () => {
            if (this._button.hover || this.notifyList.hover || privacyCorner()?.trayHover)
                return GLib.SOURCE_CONTINUE;
            this._peekEndId = 0;
            this._stopPeek(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPeekEnd() {
        if (this._peekEndId)
            GLib.source_remove(this._peekEndId);
        this._peekEndId = 0;
    }

    _stopPeek(animate) {
        this._cancelPeekEnd();
        if (!this._peeking)
            return;
        this._peeking = false;
        global.compositor.enable_unredirect();
        const stripHere = this._strip.actor.visible && !this._strip.isAway;
        if (!animate || stripHere || !this.actor.has_allocation()) {
            this.actor.remove_transition('opacity');
            this.sync();
            return;
        }
        this.actor.ease({opacity: 0, duration: PEEK_FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => finished && this.sync()});
    }

    easeToRest(duration, mode) {
        this._easeScale(duration, mode);
    }

    _syncNotifications() {
        if (!this.showsNotifications) {
            this._notify.settle();
            this.notifyList.close(false);
            this._stopPeek(false);
        }
        this._notify.syncCount();
        privacyCorner()?.refreshTray();
    }

    get _listsNotifications() {
        return this.showsNotifications && this.onScreen && this._settings.get_boolean('bubble-notify-list');
    }

    get _hasNotifications() {
        return notificationStore().recent(1).length > 0;
    }

    get wantsList() {
        if (!this._listsNotifications || !this._hasNotifications || ringTools()?.cardShown)
            return false;
        return this._button.hover || this.notifyList.hover || !!privacyCorner()?.trayHover;
    }

    openListFromKeyboard() {
        if (!this._listsNotifications)
            return false;
        if (this._hasNotifications)
            this.notifyList.openFromKeyboard();
        else
            privacyCorner()?.openFromKeyboard();   // the card, when something is in use
        return true;
    }

    notificationsChanged() {
        privacyCorner()?.refreshTray();
        this.notifyList?.syncHover();
    }

    otherListHover() {
        this.notifyList?.syncHover();
    }

    syncName() {
        const uses = this._privacy.active.map(d => DEVICE_INFO[d].inUse).join(', ');
        const unread = this.showsNotifications && !this._open ? notificationStore().unread : 0;
        let base = this._open ? 'Cerrar el cajón de apps' : 'Abrir el cajón de apps';
        if (this._timerText && !this._open)
            base = `${base}. Temporizador: ${this._timerText}`;
        if (unread)
            base = unread === 1 ? 'Apps y 1 notificación' : `Apps y ${unread} notificaciones`;
        this._button.accessible_name = uses ? `${base}. ${uses}` : base;
    }

    // A segment per device in use; a muted microphone is not listening, so it has none.
    _syncPrivacy() {
        const live = this._privacy.active.filter(device => device !== 'microphone' ||
            this._privacy.state.microphone.some(entry => !isMuted(entry)));
        this._privacyBorder.setActive(live);
        this.syncName();
        this._syncListHover();
    }

    _syncListHover() {
        privacyCorner()?.bubbleHover((this._button.hover || !!this.notifyList?.hover) && this.onScreen);
        this.notifyList?.syncHover();
    }

    // ---------- called by the page ----------

    enterDrawer(drawer) {
        this._stopPeek(false);
        this._notify.settle();
        this.notifyList.close(false);
        if (this._drawer !== drawer) {
            Main.layoutManager.removeChrome(this.actor);
            drawer.add_child(this.actor);
            // Not holding the input while the page closes: this keeps the bubble clickable on X11.
            Main.layoutManager.trackChrome(this.actor);
            this._drawer = drawer;
        }
        this.actor.show();
        this.actor.opacity = 255;
        this.sync();
        this.setOpen(true);
    }

    setOpen(open) {
        if (this._open === open)
            return;
        this._open = open;
        this._syncTime();
        this._syncPrivacy();
        this._notify.syncCount();
        for (const part of [this._button, this._ring]) {
            if (open)
                part.add_style_class_name('open');
            else
                part.remove_style_class_name('open');
        }
        this._strip.setDrawerOpen(open);
        this._later(() => {
            this._showIcon(open);
            this._easeScale(420, Clutter.AnimationMode.EASE_OUT_BACK);
        });
    }

    leaveDrawer() {
        if (!this._drawer)
            return;
        this._cancelLater();
        this._settle();
        Main.layoutManager.untrackChrome(this.actor);
        this._drawer.remove_child(this.actor);
        Main.layoutManager.addChrome(this.actor);
        this._drawer = null;
        this.sync();
    }

    // ---------- looks ----------

    _targetScale() {
        if (this._open || this._button.pressed)
            return 0.9;
        return this._button.hover ? 1.05 : 1;
    }

    _easeScale(duration, mode) {
        const scale = this._targetScale();
        if (this.actor.has_allocation())
            this.actor.ease({scale_x: scale, scale_y: scale, duration, mode});
    }

    _showIcon(open, mode = Clutter.AnimationMode.EASE_OUT_QUAD, duration = 420) {
        this._grid.ease({rotation_angle_z: open ? 90 : 0, opacity: open ? 0 : 255, duration, mode});
        this._cross.ease({rotation_angle_z: open ? 0 : -90, opacity: open ? 255 : 0, duration, mode});
        this._time.ease({opacity: open ? 0 : 255, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _flash() {
        this._later(() => {
            this._light.remove_all_transitions();
            this._light.set({scale_x: 1, scale_y: 1, opacity: 255});
            const scale = LIGHT_END / LIGHT_SIZE;
            this._light.ease({scale_x: scale, scale_y: scale, opacity: 0, duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    // Moving between parents stops the animations: leaves everything at its final state.
    _settle() {
        for (const part of [this.actor, this._grid, this._cross, this._light])
            part.remove_all_transitions();
        this.actor.set_scale(this._targetScale(), this._targetScale());
        this._grid.set({rotation_angle_z: this._open ? 90 : 0, opacity: this._open ? 0 : 255});
        this._cross.set({rotation_angle_z: this._open ? 0 : -90, opacity: this._open ? 255 : 0});
        this._time.opacity = this._open ? 0 : 255;
        this._light.opacity = 0;
    }

    // Clutter refuses to animate an actor that has just changed parents: waits for it to be laid out.
    _later(fn) {
        if (this.actor.has_allocation()) {
            fn();
            return;
        }
        this._pending = [...this._pending ?? [], fn];
        this._paintId ||= global.stage.connect('after-paint', () => {
            const pending = this._pending;
            this._cancelLater();
            pending.forEach(f => f());
        });
        global.stage.queue_redraw();
    }

    _cancelLater() {
        if (this._paintId)
            global.stage.disconnect(this._paintId);
        this._paintId = 0;
        this._pending = [];
    }
}
