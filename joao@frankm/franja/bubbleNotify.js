// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// A notification arriving at the strip's bubble: it jumps, lets out a wave of the app's colour, its
// grid turns into the app's icon, a line of text comes out below, and after a few seconds it all
// goes back to calm. The count stays until they are read.
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {CHROME_NO_INPUT} from '../sistema/compat.js';
import {appColor, captionOf, rgb} from '../notificaciones/bubbleLook.js';
import {notificationStore, retire} from '../notificaciones/notificationStore.js';
import {sourceIcon} from '../notificaciones/sourceLook.js';

const SPRING = Clutter.AnimationMode.EASE_OUT_BACK;
const SOFT = Clutter.AnimationMode.EASE_OUT_CUBIC;
const center = () => new Graphene.Point({x: 0.5, y: 0.5});

const JUMP_SCALE = 1.14;
const JUMP_UP = 180;
const JUMP_TOTAL = 420;
const WAVE_SCALE = 2.3;
const WAVE_TIME = 760;
const WAVE_OPACITY = 204;
const FADE_TIME = 180;
const GRID_TIME = 360;
const ICON_TIME = 460;
const ICON_FROM = 0.3;
const RING_TIME = 300;
const RING_REST = [28, 95, 189, 0.9];       // stylesheet: .escenas-apps-bubble-ring
const COUNT_SCALE = 1.35;
const COUNT_TOTAL = 360;
const CAPTION_BELOW = 46;                   // from the bubble's center to the top of the line
const CAPTION_SHIFT = 8;
const CAPTION_IN = 260;
const CAPTION_MOVE = 360;
const CAPTION_MARGIN = 8;
const CALM_AFTER_LINE = 600;
const BURST_COUNT = 3;
const BURST_WINDOW = 2000;
const MAX_COUNT = 99;

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;
const animations = () => St.Settings.get().enable_animations;

export class BubbleNotify {
    constructor(bubble, settings, grid, icons) {
        this._bubble = bubble;
        this._settings = settings;
        this._grid = grid;
        this._arrivals = [];
        this._shown = new Map();    // notification -> its 'destroy' handler
        this._lineId = 0;
        this._calmId = 0;
        this._ringNow = RING_REST;
        this._active = false;       // the icon and the colour are on
        this._sticky = null;        // an urgent one, waiting for the pointer

        this._wave = new St.Widget({
            style_class: 'joao-bubble-wave',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: center(),
            opacity: 0,
        });

        this._appIcon = new St.Icon({icon_size: 20, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._iconCircle = new St.Bin({
            style_class: 'joao-bubble-app',
            child: this._appIcon,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: center(),
            opacity: 0,
        });
        icons.add_child(this._iconCircle);

        this._countText = new St.Label({style_class: 'joao-bubble-count-text', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._count = new St.Bin({
            style_class: 'joao-bubble-count',
            child: this._countText,
            // The layout only looks at the align of what expands.
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            pivot_point: center(),
            // The bubble is 58 px in a root of 74, and the count sticks out 6 px of it.
            translation_x: -2,
            translation_y: 2,
            visible: false,
        });

        this._caption = new St.Label({
            style_class: 'joao-bubble-caption',
            visible: false,
            accessible_role: Atk.Role.NOTIFICATION,
        });
        Main.layoutManager.addTopChrome(this._caption, CHROME_NO_INPUT);

        this._store = notificationStore();
        this._storeId = this._store.connect('changed', () => this.syncCount());
    }

    get wave() {
        return this._wave;
    }

    get count() {
        return this._count;
    }

    // ---------- arriving ----------

    // @total: how many it stands for, when several come at once (back from fullscreen).
    arrive(notification, total = 1) {
        const now = GLib.get_monotonic_time() / 1000;
        this._arrivals = [...this._arrivals.filter(t => now - t < BURST_WINDOW), now];
        const burst = this._arrivals.length > BURST_COUNT;
        const urgent = notification.urgency === MessageTray.Urgency.CRITICAL;

        this._cancelTimers();
        this._retireShown();
        // Gone by itself before its turn to retire: nothing left to do with it.
        if (!this._shown.has(notification))
            this._shown.set(notification, notification.connect('destroy', () => this._shown.delete(notification)));

        // In a burst there has already been a jump and a wave.
        if (!burst) {
            this._jump();
            this._sendWave(notification);
        }
        this._popCount();
        this._showApp(notification);
        this._tweenRing([...appColor(notification), 1], RING_TIME);

        // An urgent line stays until the pointer comes: what arrives after it does not take its place.
        if (urgent && !this._sticky) {
            this._sticky = notification;
            notification.connectObject('destroy', () => this._endSticky(), this);
        }
        if (this._sticky) {
            this._showCaption(this._sticky === notification ? captionOf(notification, this._hideText) : this._caption.text);
            return;
        }
        const many = burst ? this._arrivals.length : total;
        this._showCaption(many > 1 ? `${many} notificaciones nuevas` : captionOf(notification, this._hideText));
        const seconds = this._settings.get_int('notify-caption-seconds');
        this._lineId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, seconds * 1000, () => {
            this._lineId = 0;
            this._hideCaption();
            this._calmLater();
            return GLib.SOURCE_REMOVE;
        });
    }

    get _hideText() {
        return this._settings.get_boolean('notify-hide-message-text');
    }

    _jump() {
        if (!animations() || !this._bubble.actor.has_allocation())
            return;
        const actor = this._bubble.actor;
        actor.remove_transition('scale-x');
        actor.remove_transition('scale-y');
        actor.ease({
            scale_x: JUMP_SCALE,
            scale_y: JUMP_SCALE,
            duration: JUMP_UP,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => {
                if (finished)
                    this._bubble.easeToRest(JUMP_TOTAL - JUMP_UP, SPRING);
            },
        });
    }

    _sendWave(notification) {
        if (!animations())
            return;
        const wave = this._wave;
        wave.remove_all_transitions();
        wave.style = `border-color: ${rgb(appColor(notification))};`;
        wave.set({scale_x: 1, scale_y: 1, opacity: WAVE_OPACITY});
        wave.ease({scale_x: WAVE_SCALE, scale_y: WAVE_SCALE, opacity: 0, duration: WAVE_TIME, mode: SOFT});
    }

    _showApp(notification) {
        const app = notification.source;
        const circle = this._iconCircle;
        circle.style = `background-color: ${rgb(appColor(notification))};`;
        const gicon = sourceIcon(notification);
        if (gicon)
            this._appIcon.gicon = gicon;
        else
            this._appIcon.icon_name = 'preferences-system-notifications-symbolic';
        // The same app as before: nothing to change.
        if (this._active && app === this._lastSource)
            return;
        this._lastSource = app;
        this._active = true;

        const grid = this._grid;
        grid.remove_all_transitions();
        grid.ease({opacity: 0, duration: FADE_TIME, mode: SOFT});
        grid.ease({scale_x: 0.5, scale_y: 0.5, rotation_angle_z: -90, duration: GRID_TIME, mode: SOFT});
        circle.remove_all_transitions();
        circle.set({opacity: 0, scale_x: ICON_FROM, scale_y: ICON_FROM});
        circle.ease({opacity: 255, duration: FADE_TIME, mode: SOFT});
        circle.ease({scale_x: 1, scale_y: 1, duration: ICON_TIME, mode: SPRING});
    }

    // St cannot animate a background from its style: a new style on every frame.
    _tweenRing(to, duration) {
        this._ringTimeline?.stop();
        this._ringTimeline = null;
        const ring = this._bubble.ring;
        const from = this._ringNow;
        const paint = progress => {
            this._ringNow = from.map((v, i) => v + (to[i] - v) * progress);
            const [r, g, b, a] = this._ringNow;
            ring.style = `background-color: rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a});`;
        };
        if (!animations() || !ring.has_allocation()) {
            paint(1);
            return;
        }
        const timeline = new Clutter.Timeline({actor: ring, duration});
        timeline.connect('new-frame', () => paint(timeline.get_progress()));
        timeline.connect('completed', () => {
            paint(1);
            if (this._ringTimeline === timeline)
                this._ringTimeline = null;
        });
        this._ringTimeline = timeline;
        timeline.start();
    }

    _popCount() {
        const count = this._count;
        if (!animations() || !count.visible || !count.has_allocation())
            return;
        count.remove_all_transitions();
        count.ease({
            scale_x: COUNT_SCALE,
            scale_y: COUNT_SCALE,
            duration: JUMP_UP,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => {
                if (finished)
                    count.ease({scale_x: 1, scale_y: 1, duration: COUNT_TOTAL - JUMP_UP, mode: SPRING});
            },
        });
    }

    // ---------- the line of text ----------

    _showCaption(text) {
        const caption = this._caption;
        const already = caption.visible && caption.opacity === 255;
        caption.text = text;
        caption.accessible_name = text;
        caption.remove_all_transitions();
        // Measured visible: St has no styles to measure with on hidden actors.
        if (!caption.visible)
            caption.set({opacity: 0, visible: true});
        Main.layoutManager.uiGroup.set_child_above_sibling(caption, null);
        this.placeCaption();
        caption.get_accessible()?.notify_state_change?.(Atk.StateType.SHOWING, true);
        if (already)
            return;
        caption.translation_y = -CAPTION_SHIFT;
        caption.ease({opacity: 255, duration: CAPTION_IN, mode: SOFT});
        caption.ease({translation_y: 0, duration: CAPTION_MOVE, mode: SOFT});
    }

    _hideCaption() {
        const caption = this._caption;
        if (!caption.visible)
            return;
        caption.remove_all_transitions();
        caption.ease({opacity: 0, translation_y: -CAPTION_SHIFT, duration: CAPTION_IN, mode: SOFT,
            onStopped: finished => {
                if (finished)
                    caption.hide();
            }});
    }

    // Below the bubble, centered, and never out of the screen.
    placeCaption() {
        const caption = this._caption;
        const center = this._bubble.center();
        if (!caption.visible || !center)
            return;
        const scale = scaleFactor();
        const monitor = Main.layoutManager.monitors.find(m =>
            center.x >= m.x && center.x < m.x + m.width && center.y >= m.y && center.y < m.y + m.height) ?? Main.layoutManager.primaryMonitor;
        const [, width] = caption.get_preferred_width(-1);
        const [, height] = caption.get_preferred_height(width);
        const margin = CAPTION_MARGIN * scale;
        const x = Math.max(monitor.x + margin, Math.min(center.x - width / 2, monitor.x + monitor.width - width - margin));
        const y = Math.min(center.y + CAPTION_BELOW * scale, monitor.y + monitor.height - height - margin);
        caption.set_position(Math.round(x), Math.round(y));
    }

    // ---------- back to calm ----------

    _calmLater() {
        this._calmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CALM_AFTER_LINE, () => {
            this._calmId = 0;
            this._calm();
            return GLib.SOURCE_REMOVE;
        });
    }

    _calm() {
        this._arrivals = [];
        this._retireShown();
        this._active = false;
        this._lastSource = null;
        const grid = this._grid;
        grid.remove_all_transitions();
        grid.ease({opacity: 255, duration: FADE_TIME, mode: SOFT});
        grid.ease({scale_x: 1, scale_y: 1, rotation_angle_z: 0, duration: GRID_TIME, mode: SOFT});
        const circle = this._iconCircle;
        circle.remove_all_transitions();
        circle.ease({opacity: 0, duration: FADE_TIME, mode: SOFT});
        circle.ease({scale_x: ICON_FROM, scale_y: ICON_FROM, duration: GRID_TIME, mode: SOFT});
        this._tweenRing(RING_REST, RING_TIME);
        this._bubble.wentQuiet();
    }

    // The pointer has seen it, or it is gone.
    _endSticky() {
        const sticky = this._sticky;
        if (!sticky)
            return;
        this._sticky = null;
        sticky.disconnectObject(this);
        this._cancelTimers();
        this._hideCaption();
        this._calmLater();
    }

    pointerCame() {
        this._endSticky();
    }

    _retireShown() {
        // Not the urgent one on screen: it goes when it has been seen.
        for (const [notification, id] of [...this._shown]) {
            if (notification === this._sticky)
                continue;
            notification.disconnect(id);
            this._shown.delete(notification);
            retire(notification);
        }
    }

    _cancelTimers() {
        if (this._lineId)
            GLib.source_remove(this._lineId);
        this._lineId = 0;
        if (this._calmId)
            GLib.source_remove(this._calmId);
        this._calmId = 0;
    }

    // Everything at rest at once, except the count: the page opened, the strip went away.
    settle() {
        this._cancelTimers();
        const sticky = this._sticky;
        this._sticky = null;
        sticky?.disconnectObject(this);
        this._retireShown();
        this._arrivals = [];
        this._active = false;
        this._lastSource = null;
        this._ringTimeline?.stop();
        this._ringTimeline = null;
        this._ringNow = RING_REST;
        this._bubble.ring.style = null;
        for (const part of [this._wave, this._iconCircle, this._caption, this._grid])
            part.remove_all_transitions();
        this._wave.opacity = 0;
        this._iconCircle.set({opacity: 0, scale_x: 1, scale_y: 1});
        this._caption.hide();
        this._grid.set({scale_x: 1, scale_y: 1});
        this._bubble.wentQuiet();
    }

    // ---------- the count ----------

    syncCount() {
        const unread = this._store.unread;
        const show = unread > 0 && this._bubble.showsNotifications && !this._bubble.isOpen;
        this._count.visible = show;
        this._countText.text = unread > MAX_COUNT ? `${MAX_COUNT}+` : `${unread}`;
        this._bubble.syncName();
    }

    destroy() {
        this.settle();
        this._store.disconnect(this._storeId);
        Main.layoutManager.removeChrome(this._caption);
        this._caption.destroy();
    }
}
