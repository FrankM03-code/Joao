// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The settings strip: the twin of the scenes strip on the other side of the screen, with the time,
// the switches, volume and brightness, the modes, João's privacy row, the battery, and the power
// view behind the bubble. It is always hidden: a 1-px line at the screen edge brings it out when
// the pointer touches it, and it goes away again once the pointer leaves it. It reserves no room.
// While it is on, GNOME's quick settings menu stays hidden (not destroyed: João's switches and
// sliders work through it) and its shortcut toggles the strip.
//
// The frame (reaching the screen edge) belongs to the layout manager, which hides it in fullscreen;
// it takes no input itself. The strip and the bubble take input only while they are visible.
//
// The glass: a live copy of the desktop background, blurred and cut to the strip's corners.
//
// The keyboard: a chrome actor gets no keys, so while the power view is open, a mode's name is
// typed or a mode's menu is shown, the strip holds the input (holdInput). Esc or a click outside
// the strip ends that state; the rest of the time the strip takes nothing.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Panel} from 'resource:///org/gnome/shell/ui/panel.js';

import {EdgeBarrier} from '../franja/edgeBarrier.js';
import {RoundedCorners} from '../franja/sceneThumbnail.js';
import {qs} from '../sistema/gnome.js';
import {Bateria} from './bateria.js';
import {BurbujaEnergia, HOLDER_SIZE} from './burbujaEnergia.js';
import {Cabecera} from './cabecera.js';
import {Controles} from './controles.js';
import {VistaEnergia} from './energia.js';
import {FilaJoao} from './filaJoao.js';
import {animations} from './iconosAnimados.js';
import {Interruptores} from './interruptores.js';
import {Modos} from './modos.js';
import {VistaRed} from './redes.js';

export const STRIP_WIDTH = 276;
export const STRIP_HEIGHT = 720;    // the most it grows; it takes the height of its contents
const EDGE_GAP = 16;
const RADIUS = 22;
const BLUR_RADIUS = 28;
const SHOW_TIME = 300;
const HIDE_TIME = 260;
const SLIDE = 40;
const SHRUNK = 0.92;
const LEAVE_DELAY = 400;    // ms with the pointer away before the strip goes
const NEAR = 24;            // px around the strip that still count as on it
const POLL = 100;
const VIEW_TIME = 460;
const VIEW_SHIFT = 0.4;     // of the width: how far the settings view moves out
const ROW_DELAY = 120;
const ROW_STEP = 45;
const ROW_SHIFT = 16;
const BLINK = 1000;
const TOAST_TIME = 2000;

const SETTINGS = 0, POWER = 1, NET = 2;
const BUTTONS = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK;

let current = null;
export const franjaAjustes = () => current;

export class FranjaAjustes {
    constructor(settings) {
        this._settings = settings;
        this._userShown = false;
        this._waitEnter = false;
        this._leaveId = 0;
        this._shown = false;
        this._view = SETTINGS;
        this._holders = [];
        this._ids = [];
        current = this;

        this._frame = new St.Widget({name: 'joaoAjustesMarco', reactive: false});
        this.strip = new St.Widget({
            name: 'joaoAjustes',
            style_class: 'joao-ajustes',
            layout_manager: new Clutter.BinLayout(),
            width: STRIP_WIDTH,
            reactive: true,
            clip_to_allocation: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            accessible_name: 'Ajustes',
        });
        this._frame.add_child(this.strip);

        this._glass = new St.Widget({clip_to_allocation: true, x_expand: true, y_expand: true});
        this._copy = new Clutter.Clone({source: Main.layoutManager._backgroundGroup});
        this._glass.add_child(this._copy);
        this._mask = new RoundedCorners(STRIP_WIDTH, STRIP_HEIGHT, RADIUS);
        this._glass.add_effect(this._mask);
        this._glass.add_effect(new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: BLUR_RADIUS, brightness: 1}));
        this.strip.add_child(this._glass);
        this.strip.connect('notify::height', () => this._mask.resize(STRIP_WIDTH, this.strip.height, RADIUS));
        this.strip.add_child(new St.Widget({style_class: 'joao-ajustes-cara', x_expand: true, y_expand: true}));

        // The two views slide inside this box, cut to it: nothing leaves the strip.
        this._views = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true,
            clip_to_allocation: true});
        this.strip.add_child(this._views);

        // Over the bubble (expand: a BinLayout only aligns a child that expands).
        this._toast = new St.Label({style_class: 'joao-ajustes-aviso', opacity: 0, visible: false,
            x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START});
        this.strip.add_child(this._toast);

        this._bubble = new BurbujaEnergia(() => this._onBubble());
        this._buildViews();

        // Containers without input of their own; what is inside takes it only while visible.
        Main.layoutManager.addChrome(this._frame, {affectsInputRegion: false, trackFullscreen: true});
        Main.layoutManager.trackChrome(this.strip, {affectsInputRegion: true, trackFullscreen: false});
        Main.layoutManager.addChrome(this._bubble.holder, {affectsInputRegion: false, trackFullscreen: true});
        Main.layoutManager.trackChrome(this._bubble.bubble, {affectsInputRegion: true, trackFullscreen: false});

        // The 1-px line at the screen edge that brings the strip out.
        this._edge = new St.Widget({name: 'joaoAjustesBorde', reactive: true, width: 1, visible: false});
        Main.layoutManager.addChrome(this._edge, {trackFullscreen: false});
        this._connect(this._edge, 'enter-event', () => this.reveal());
        // With another monitor on that side the edge stops nothing: this holds the pointer there.
        this._barrier = new EdgeBarrier(() => this.reveal());

        this._connect(Main.layoutManager, 'monitors-changed', () => this._place());
        this._connect(Main.overview, 'showing', () => this._sync());
        this._connect(Main.overview, 'hidden', () => this._sync());
        this._connect(Main.sessionMode, 'updated', () => this._sync());
        this._connect(settings, 'changed::settings-strip-enabled', () => this._sync());
        this._connect(settings, 'changed::lado', () => this._place());
        // GNOME's style: light glass in light mode, GNOME's neutral dark otherwise.
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._connect(this._interface, 'changed::color-scheme', () => this._syncScheme());
        this._syncScheme();
        this._connect(settings, 'changed::settings-strip-toggles', () => this._buildViews());
        this._connect(settings, 'changed::modes-enabled', () => {
            this._syncModesVisible();
            this._place();
        });
        this._connect(St.Settings.get(), 'notify::enable-animations', () => this._syncLoops());
        this._connect(global.stage, 'captured-event', (a, event) => this._onCaptured(event));

        // GNOME's quick settings: hidden while the strip is on; its shortcut toggles the strip.
        this._injections = new InjectionManager();
        const self = this;
        this._injections.overrideMethod(Panel.prototype, 'toggleQuickSettings', original => function (...args) {
            if (self.enabled)
                return self.toggle();
            return original.apply(this, args);
        });

        this._place();
        this._sync({animate: false});
    }

    _connect(obj, signal, fn) {
        this._ids.push([obj, obj.connect(signal, fn)]);
    }

    _syncScheme() {
        const light = this._interface.get_string('color-scheme') !== 'prefer-dark';
        for (const actor of [this.strip, this._bubble.holder]) {
            if (light)
                actor.add_style_class_name('claro');
            else
                actor.remove_style_class_name('claro');
        }
    }

    get enabled() {
        return this._settings.get_boolean('settings-strip-enabled');
    }

    // This PC only: with more than one monitor, the strip goes to the rightmost one, on its right
    // edge. With a single monitor, on the side the scenes strip leaves free.
    get _monitorIndex() {
        const monitors = Main.layoutManager.monitors;
        let best = Main.layoutManager.primaryIndex;
        for (const m of monitors) {
            const b = monitors[best];
            if (!b || m.x + m.width > b.x + b.width)
                best = m.index;
        }
        return best;
    }

    get _monitor() {
        return Main.layoutManager.monitors[this._monitorIndex] ?? Main.layoutManager.primaryMonitor;
    }

    get _right() {
        if (this._monitorIndex !== Main.layoutManager.primaryIndex)
            return true;
        return this._settings.get_string('lado') !== 'derecha';
    }

    // ---------- contents ----------

    _buildViews() {
        this._releaseAll();
        this._settingsView?.destroy();
        this._energyView?.destroy();
        this._netView?.destroy();
        this._view = SETTINGS;

        const view = this._settingsView = new St.BoxLayout({style_class: 'joao-ajustes-vista joao-ajustes-vista-ajustes',
            orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true});
        this.header = new Cabecera();
        view.add_child(this.header);
        // An empty list hides them all (Preferences); the default is all six.
        this.switches = new Interruptores(this._settings.get_strv('settings-strip-toggles'));
        view.add_child(this.switches);
        this.switches.connect('open', (s, kind) => this.openSub(kind));
        this.switches.connect('action', () => this._screenshot());
        this.controls = new Controles();
        view.add_child(this.controls);
        this.modes = new Modos({
            settings: this._settings,
            switches: this.switches,
            controls: this.controls,
            holdInput: onRelease => this.holdInput(onRelease),
        });
        this.modes.connect('ring-color', (m, color) => this._bubble.setRingColor(color || null));
        this._bubble.setRingColor(this.modes.ringColor);
        this.modes.connect('toast', (m, text) => this.toast(text));
        this.switches.connect('ready', () => this.modes.watch());
        if (this.switches.backends)
            this.modes.watch();
        view.add_child(this.modes);
        this._syncModesVisible();
        this.privacyRow = new FilaJoao();
        view.add_child(this.privacyRow);
        this.battery = new Bateria({
            onSettings: () => this.hide(),
            onLock: () => this.hide(),
        });
        view.add_child(this.battery);
        this._views.add_child(view);
        // A row coming or going (no sound device, João's row, the modes): the height follows.
        view.get_children().forEach(child => child.connect('notify::visible', () => this._queuePlace()));

        const energy = this._energyView = new VistaEnergia(this._settings);
        energy.visible = false;
        energy.connect('back', () => this.closeEnergy());
        // Locking or suspending: back to the settings at once, ready for the return.
        energy.connect('acted', () => this.closeEnergy({animate: false}));
        this._views.add_child(energy);

        const net = this._netView = new VistaRed(this.switches);
        net.visible = false;
        net.connect('back', () => this.closeSub());
        this._views.add_child(net);
        this._syncLoops();
        if (this._edge)
            this._place();
    }

    // "Captura": the strip goes first, so it is not in the picture.
    _screenshot() {
        this.hide();
        if (this._shotId)
            return;
        this._shotId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_TIME + 60, () => {
            this._shotId = 0;
            Main.screenshotUI.open().catch(e => logError(e, 'João: captura'));
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncModesVisible() {
        this.modes.visible = this._settings.get_boolean('modes-enabled');
    }

    // ---------- placement ----------

    _queuePlace() {
        if (this._placeId)
            return;
        this._placeId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._placeId = 0;
            if (this._edge)
                this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    // As tall as the view on show, no more: the top stays, the bottom (and the bubble) moves
    // when the power view comes in or goes.
    _place({animate = false} = {}) {
        const monitor = this._monitor;
        if (!monitor)
            return;
        const right = this._right;
        const bubbleRoom = HOLDER_SIZE / 2;
        const room = Math.min(STRIP_HEIGHT, monitor.height - 2 * bubbleRoom);
        const natural = view => {
            const h = view ? Math.ceil(view.get_preferred_height(STRIP_WIDTH)[1]) : 0;
            return Math.min(h > 0 ? h : STRIP_HEIGHT, room);
        };
        const base = natural(this._settingsView);
        const y = monitor.y + Math.round((monitor.height - base - bubbleRoom) / 2);
        const side = {[POWER]: this._energyView, [NET]: this._netView}[this._view];
        const height = side
            ? Math.min(natural(side), monitor.y + monitor.height - bubbleRoom - y) : base;
        const frameWidth = STRIP_WIDTH + EDGE_GAP;
        const frameX = right ? monitor.x + monitor.width - frameWidth : monitor.x;
        const stripX = right ? 0 : EDGE_GAP;
        this._frame.set_position(frameX, y);
        this._frame.set_size(frameWidth, room);
        this.strip.set_position(stripX, 0);
        this._copy.set_position(-(frameX + stripX), -y);
        this._area = {x: frameX + stripX, y, width: STRIP_WIDTH, height: height + bubbleRoom};

        const centerX = frameX + stripX + STRIP_WIDTH / 2;
        const holder = this._bubble.holder;
        const holderY = Math.round(y + height - HOLDER_SIZE / 2);
        holder.x = Math.round(centerX - HOLDER_SIZE / 2);
        this.strip.remove_transition('height');
        holder.remove_transition('y');
        if (animate && animations()) {
            this.strip.ease({height, duration: VIEW_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            holder.ease({y: holderY, duration: VIEW_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            this.strip.height = height;
            holder.y = holderY;
        }

        this._edge.set_position(right ? monitor.x + monitor.width - 1 : monitor.x, monitor.y);
        this._edge.height = monitor.height;
        this._syncEdge();
    }

    // ---------- showing and hiding ----------

    get visible() {
        return this._shown;
    }

    toggle() {
        if (this._shown)
            this.hide();
        else
            this.show();
    }

    // From the shortcut or the power key: it stays until the pointer has been on it and left.
    show() {
        this._userShown = true;
        this._waitEnter = !this._pointerNear();
        this._sync();
        this._watchPointer();
    }

    // From the screen edge.
    reveal() {
        this._userShown = true;
        this._waitEnter = false;
        this._sync();
        this._watchPointer();
    }

    hide() {
        this._userShown = false;
        this._sync();
    }

    _sync({animate = true} = {}) {
        const enabled = this.enabled;
        const locked = Main.sessionMode.isLocked || Main.sessionMode.isGreeter;
        const show = enabled && this._userShown && !locked && !Main.overview.visible;
        if (!show)
            this._userShown = false;
        this._syncQuickSettings(enabled && !locked);
        if (!show) {
            this.closeEnergy({animate: false});
            this.closeSub({animate: false});
        }
        this._animate(show, animate && !locked && !Main.overview.visible);
        this._syncEdge();
        this._syncLoops();
    }

    // The edge line waits only while the strip is away and could come out.
    _syncEdge() {
        if (!this._edge)
            return;
        const wanted = this.enabled && !this._shown && !Main.overview.visible &&
            !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter;
        this._edge.visible = wanted;
        this._barrier.update(wanted, !this._right, this._monitorIndex);
    }

    _pointerNear() {
        const a = this._area;
        if (!a)
            return false;
        const monitor = this._monitor;
        const [x, y] = global.get_pointer();
        const left = this._right ? a.x - NEAR : monitor.x;
        const right = this._right ? monitor.x + monitor.width : a.x + a.width + NEAR;
        return x >= left && x < right && y >= a.y - NEAR && y < a.y + a.height + NEAR;
    }

    // While out: away again once the pointer has left it for a moment. Not while it holds the input
    // (the power view, a mode's name or menu) nor while a button is down (dragging a bar).
    _watchPointer() {
        if (this._leaveId)
            return;
        let away = 0;
        this._leaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL, () => {
            if (!this._userShown) {
                this._leaveId = 0;
                return GLib.SOURCE_REMOVE;
            }
            const [, , mods] = global.get_pointer();
            const near = this._pointerNear();
            if (near)
                this._waitEnter = false;
            const busy = this._holders.length > 0 || (mods & BUTTONS) !== 0 || this._waitEnter;
            away = near || busy ? 0 : away + POLL;
            if (away < LEAVE_DELAY)
                return GLib.SOURCE_CONTINUE;
            this._leaveId = 0;
            this.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncQuickSettings(hidden) {
        const container = qs()?.container;
        if (!container)
            return;
        if (hidden && !this._qsHidden) {
            this._qsHidden = true;
            container.hide();
        } else if (!hidden && this._qsHidden) {
            this._qsHidden = false;
            container.show();
        }
    }

    _animate(show, animate) {
        if (show === this._shown && !animate)
            return this._setShown(show);
        if (show === this._shown)
            return undefined;
        this._shown = show;
        // Measured while visible: a hidden strip keeps the sizes from before its rows changed.
        if (show) {
            this.strip.show();
            this._settingsView.queue_relayout();
            this._energyView.queue_relayout();
            this._place();
        }
        const strip = this.strip;
        const bubble = this._bubble.bubble;
        strip.remove_all_transitions();
        bubble.remove_all_transitions();
        const away = (this._right ? 1 : -1) * SLIDE;
        if (!animate)
            return this._setShown(show);
        if (show) {
            strip.show();
            strip.set({translation_x: away, scale_x: SHRUNK, scale_y: SHRUNK, opacity: 0});
            strip.ease({translation_x: 0, scale_x: 1, scale_y: 1, opacity: 255, duration: SHOW_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            bubble.show();
            bubble.set({translation_x: away, opacity: 0});
            bubble.ease({translation_x: 0, opacity: 255, duration: SHOW_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            strip.ease({translation_x: away, scale_x: SHRUNK, scale_y: SHRUNK, opacity: 0, duration: HIDE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onStopped: finished => {
                    if (finished)
                        strip.hide();
                }});
            bubble.ease({translation_x: away, opacity: 0, duration: HIDE_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: finished => {
                    if (finished)
                        bubble.hide();
                }});
        }
        return undefined;
    }

    _setShown(show) {
        this._shown = show;
        this.strip.set({visible: show, translation_x: 0, scale_x: 1, scale_y: 1, opacity: 255});
        this._bubble.bubble.set({visible: show, translation_x: 0, opacity: 255});
    }

    // ---------- the power view ----------

    _onBubble() {
        if (!this._shown)
            this.show();
        else if (this._view === POWER)
            this.closeEnergy();
        else
            this.openEnergy();   // from the Wi-Fi or Bluetooth view too
    }

    // Straight to the power view (its shortcut).
    openEnergy() {
        if (!this.enabled || Main.sessionMode.isLocked)
            return;
        if (!this._shown)
            this.show();
        if (this._view === POWER)
            return;
        this.closeSub({animate: false});
        this._energyView.refresh();
        this._openSide(POWER, this._energyView, () => this.closeEnergy());
        this._turnBubble(90, animations());
    }

    closeEnergy({animate = true} = {}) {
        if (this._view !== POWER)
            return;
        this._closeSide(this._energyView, animate);
        this._turnBubble(0, animate && animations());
    }

    // The Wi-Fi or Bluetooth view, from its tile.
    openSub(kind) {
        if (!this.enabled || Main.sessionMode.isLocked || this._view !== SETTINGS)
            return;
        this._netView.start(kind);
        this._openSide(NET, this._netView, () => this.closeSub());
    }

    closeSub({animate = true} = {}) {
        if (this._view !== NET)
            return;
        this._netView.stop();
        this._closeSide(this._netView, animate);
    }

    // The settings view slides out to the left and @to comes in from the right, row by row.
    _openSide(view, to, onRelease) {
        this.modes.cancel();
        this._view = view;
        const from = this._settingsView;
        this._sideRelease = this.holdInput(onRelease);
        const width = STRIP_WIDTH;
        const ease = animations();
        from.remove_all_transitions();
        to.remove_all_transitions();
        to.show();
        if (ease) {
            from.ease({translation_x: -VIEW_SHIFT * width, opacity: 0, duration: VIEW_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC, onStopped: finished => {
                    if (finished)
                        from.hide();
                }});
            to.set({translation_x: width, opacity: 255});
            to.ease({translation_x: 0, duration: VIEW_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            to.rows.filter(row => row.visible).forEach((row, i) => {
                row.remove_all_transitions();
                row.set({translation_x: ROW_SHIFT, opacity: 0});
                row.ease({translation_x: 0, opacity: 255, delay: ROW_DELAY + ROW_STEP * i, duration: 320,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            });
        } else {
            from.hide();
            to.set({translation_x: 0, opacity: 255});
        }
        this._place({animate: ease});
        to.backButton.grab_key_focus();
    }

    _closeSide(from, animate) {
        this._view = SETTINGS;
        const release = this._sideRelease;
        this._sideRelease = null;
        release?.();
        const to = this._settingsView;
        const ease = animate && animations();
        from.remove_all_transitions();
        to.remove_all_transitions();
        to.show();
        if (ease) {
            from.ease({translation_x: STRIP_WIDTH, duration: VIEW_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: finished => {
                    if (finished)
                        from.hide();
                }});
            to.ease({translation_x: 0, opacity: 255, duration: VIEW_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            from.hide();
            to.set({translation_x: 0, opacity: 255});
        }
        from.rows.forEach(row => {
            row.remove_all_transitions();
            row.set({translation_x: 0, opacity: 255});
        });
        this._place({animate: ease});
    }

    _turnBubble(angle, ease) {
        const icon = this._bubble.icon;
        icon.remove_all_transitions();
        if (ease)
            icon.ease({rotation_angle_z: angle, duration: VIEW_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        else
            icon.rotation_angle_z = angle;
    }

    // ---------- holding the keyboard ----------

    // Takes the input for the strip until the returned function runs. A click outside the strip
    // (and its bubble) or Esc calls @onRelease of the latest holder.
    holdInput(onRelease) {
        const holder = {onRelease};
        this._holders.push(holder);
        if (!this._grab)
            this._grab = Main.pushModal(global.stage, {actionMode: Shell.ActionMode.POPUP});
        return () => {
            const i = this._holders.indexOf(holder);
            if (i < 0)
                return;
            this._holders.splice(i, 1);
            if (!this._holders.length && this._grab) {
                Main.popModal(this._grab);
                this._grab = null;
            }
        };
    }

    _releaseAll() {
        const holders = [...this._holders].reverse();
        holders.forEach(h => h.onRelease());
        this._holders = [];
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _inside(actor) {
        return !!actor && (this.strip.contains(actor) || this._bubble.holder.contains(actor));
    }

    _onCaptured(event) {
        if (!this._holders.length)
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        const top = this._holders[this._holders.length - 1];
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            top.onRelease();
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
            if (!this._inside(global.stage.get_event_actor(event))) {
                top.onRelease();
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ---------- small notice and movement ----------

    toast(text) {
        const t = this._toast;
        t.text = text;
        t.remove_all_transitions();
        t.show();
        if (this._toastId)
            GLib.source_remove(this._toastId);
        t.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._toastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOAST_TIME, () => {
            this._toastId = 0;
            t.ease({opacity: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => t.hide()});
            return GLib.SOURCE_REMOVE;
        });
    }

    // The colon, the privacy ring, the equalizer, the gear and the charging battery move only while
    // the strip is on screen and animations are on: no frames spent on a hidden strip.
    _syncLoops() {
        const run = this._shown && animations() && !Main.sessionMode.isLocked;
        this.privacyRow?.looping(run);
        this.battery?.looping(run);
        const colon = this.header?.colon;
        if (run && !this._blinkId && colon) {
            this._blinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BLINK, () => {
                const c = this.header.colon;
                c.ease({opacity: c.opacity > 128 ? 64 : 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!run && this._blinkId) {
            GLib.source_remove(this._blinkId);
            this._blinkId = 0;
        }
        if (!run && colon) {
            colon.remove_all_transitions();
            colon.opacity = 255;
        }
    }

    destroy() {
        this._releaseAll();
        this._injections.clear();
        this._syncQuickSettings(false);
        this._ids.forEach(([obj, id]) => obj.disconnect(id));
        this._ids = [];
        if (this._blinkId)
            GLib.source_remove(this._blinkId);
        this._blinkId = 0;
        if (this._toastId)
            GLib.source_remove(this._toastId);
        this._toastId = 0;
        if (this._leaveId)
            GLib.source_remove(this._leaveId);
        this._leaveId = 0;
        if (this._placeId)
            GLib.source_remove(this._placeId);
        this._placeId = 0;
        if (this._shotId)
            GLib.source_remove(this._shotId);
        this._shotId = 0;
        this._barrier.destroy();
        Main.layoutManager.removeChrome(this._edge);
        this._edge.destroy();
        this._edge = null;
        this.strip.remove_all_transitions();
        this._bubble.bubble.remove_all_transitions();
        this._frame.destroy();
        this._bubble.destroy();
        Main.layoutManager._queueUpdateRegions?.();
        current = null;
        this._settings = null;
    }
}
