// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The latest notifications, beside the bubble while the pointer is on it. A row opens the
// notification; "Limpiar" discards them all. The glass is the island's: a still picture of the
// screen, blurred and cut to shape.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {appColor, rgb} from '../notificaciones/bubbleLook.js';
import {notificationStore} from '../notificaciones/notificationStore.js';
import {screenPicture} from '../notificaciones/screenPicture.js';
import {sourceIcon, sourceName} from '../notificaciones/sourceLook.js';
import {connectKeyPress} from '../escritorio/keyEvents.js';
import {privacyCorner} from '../privacidad/cornerIndicator.js';
import {plainBody} from '../sistema/notifications.js';
import {RoundedCorners} from './sceneThumbnail.js';

const WIDTH = 300;
const RADIUS = 22;
const ROWS = 4;
const GAP = 4;
const CHIPS_GAP = 6;
const MARGIN = 8;
const LEAVE_MARGIN = 250;
const FADE = 180;
const GROW = 320;
const SHIFT = 10;
const SCALE_FROM = 0.92;
const BLUR_RADIUS = 30;
const BLUR_BRIGHTNESS = 1.0;   // Shell.BlurEffect accepts at most 1.0 (GNOME 48)

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

function line(style, text) {
    const label = new St.Label({style_class: style, text});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

export const NotifyList = GObject.registerClass(
class JoaoNotifyList extends St.Widget {
    _init(bubble, settings) {
        super._init({
            style_class: 'joao-notify-list',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._bubble = bubble;
        this._settings = settings;
        this._leaveId = 0;
        this._run = 0;
        this._closing = false;
        this._store = notificationStore();

        this._shadow = new St.Widget({style_class: 'joao-notify-list-shadow', x_expand: true, y_expand: true});
        this.add_child(this._shadow);
        this._glass = new St.Widget({clip_to_allocation: true, x_expand: true, y_expand: true});
        this._copy = new Clutter.Actor();
        this._glass.add_child(this._copy);
        this._mask = new RoundedCorners(1, 1, RADIUS);
        this._glass.add_effect(this._mask);
        this._glass.add_effect(new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: BLUR_RADIUS, brightness: BLUR_BRIGHTNESS}));
        this.add_child(this._glass);
        this._face = new St.Widget({style_class: 'joao-notify-list-face', x_expand: true, y_expand: true});
        this.add_child(this._face);

        this._box = new St.BoxLayout({style_class: 'joao-notify-list-box', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.add_child(this._box);
        this._rows = new St.BoxLayout({style_class: 'joao-notify-rows', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._box.add_child(this._rows);
        this._clear = new St.Button({
            style_class: 'joao-notify-clear',
            label: 'Limpiar',
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Limpiar las notificaciones',
        });
        this._clear.connect('clicked', () => this._store.clearAll());
        this._box.add_child(this._clear);

        Main.layoutManager.addTopChrome(this);
        connectKeyPress(this, event => this._onKey(event));
        this._storeId = this._store.connect('changed', () => {
            if (this.visible && !this._closing) {
                if (this._store.recent(1).length > 0)
                    this._fill();
                else
                    this.close(true);
            }
            this._bubble.notificationsChanged();
        });
    }

    get isShowing() {
        return this.visible && !this._closing;
    }

    // The pointer on the bubble or here, or on the chips of what is in use, right below this one.
    syncHover() {
        if (this._leaveId)
            GLib.source_remove(this._leaveId);
        this._leaveId = 0;
        if (this._bubble.wantsList) {
            this._open();
            return;
        }
        if (!this.visible || this._byKeyboard)
            return;
        this._leaveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVE_MARGIN, () => {
            this._leaveId = 0;
            this.close(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _open() {
        if (this.isShowing)
            return;
        const reopening = this._closing;
        this._closing = false;
        this.remove_all_transitions();
        const run = ++this._run;
        if (!reopening) {
            // Before it is on screen: the picture must not have the list in it.
            await this._takePicture();
            if (run !== this._run || (!this._bubble.wantsList && !this._byKeyboard))
                return;
            this.set({opacity: 0, translation_x: -this._side * SHIFT, scale_x: SCALE_FROM, scale_y: SCALE_FROM, visible: true});
            Main.layoutManager.uiGroup.set_child_above_sibling(this, null);
        }
        this._fill();
        this.ease({opacity: 255, duration: FADE, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        this.ease({translation_x: 0, scale_x: 1, scale_y: 1, duration: GROW, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    openFromKeyboard() {
        this._byKeyboard = true;
        this._returnFocus = global.stage.get_key_focus();
        this._open().then(() => {
            if (this.visible && !this.navigate_focus(null, St.DirectionType.TAB_FORWARD, false))
                this.grab_key_focus();
        });
    }

    _onKey(event) {
        if (event.get_key_symbol() !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        this.close(true);
        return Clutter.EVENT_STOP;
    }

    close(animate) {
        this._run++;
        this._byKeyboard = false;
        if (this._leaveId)
            GLib.source_remove(this._leaveId);
        this._leaveId = 0;
        if (this._returnFocus !== undefined) {
            if (this.contains(global.stage.get_key_focus()))
                global.stage.set_key_focus(this._returnFocus);
            this._returnFocus = undefined;
        }
        if (!this.visible)
            return;
        this.remove_all_transitions();
        if (!animate) {
            this._finishClosing();
            return;
        }
        this._closing = true;
        this.ease({opacity: 0, translation_x: -this._side * SHIFT, duration: FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => {
                if (finished)
                    this._finishClosing();
            }});
    }

    _finishClosing() {
        this._closing = false;
        this.hide();
        this._copy.destroy_all_children();
    }

    async _takePicture() {
        this._copy.destroy_all_children();
        const blur = this._settings.get_boolean('island-blur');
        this._glass.visible = blur;
        // Without the glass over it, the shadow's solid base would show through.
        this._shadow.visible = blur;
        if (!blur)
            return;
        try {
            this._copy.add_child(await screenPicture());
        } catch (e) {
            logError(e, 'João: foto bajo la lista');
        }
    }

    // ---------- contents and place ----------

    _fill() {
        this._rows.destroy_all_children();
        const notifications = this._store.recent(ROWS);
        notifications.forEach(notification => this._rows.add_child(this._row(notification)));
        this._face.style = `background-color: rgba(255, 255, 255, ${this._settings.get_double('island-glass')});`;
        this._place();
    }

    _row(notification) {
        const name = sourceName(notification.source);
        const title = notification.title || name;
        const body = plainBody(notification);
        const row = new St.Button({
            style_class: 'joao-notify-row',
            can_focus: true,
            x_expand: true,
            accessible_name: `${name}: ${title}`,
        });
        const box = new St.BoxLayout({style_class: 'joao-notify-row-box', x_expand: true});
        const gicon = sourceIcon(notification);
        const icon = new St.Icon({icon_size: 18, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        if (gicon)
            icon.gicon = gicon;
        else
            icon.icon_name = 'preferences-system-notifications-symbolic';
        box.add_child(new St.Bin({
            style_class: 'joao-notify-row-icon',
            style: `background-color: ${rgb(appColor(notification))};`,
            y_align: Clutter.ActorAlign.CENTER,
            child: icon,
        }));
        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        words.add_child(line('joao-notify-row-title', title));
        if (body)
            words.add_child(line('joao-notify-row-body', body));
        box.add_child(words);
        row.set_child(box);
        row.connect('clicked', () => {
            this.close(false);
            this._store.markRead(notification);
            notification.activate();
        });
        return row;
    }

    // 1 when it opens towards the right of the bubble, -1 towards the left.
    get _side() {
        const center = this._bubble.center();
        const monitor = Main.layoutManager.primaryMonitor;
        const onRight = center && monitor && center.x > monitor.x + monitor.width / 2;
        return onRight ? -1 : 1;
    }

    chipsMoved() {
        if (this.isShowing)
            this._place();
    }

    // Beside the bubble, towards the middle of the screen, aligned with it below, or above the chips
    // when there are any.
    _place() {
        const actor = this._bubble.actor;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = scaleFactor();
        const width = WIDTH * scale;
        const [, height] = this._box.get_preferred_height(width);
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        const gap = GAP * scale;
        const left = this._side > 0 ? x + w + gap : x - width - gap;
        const chipsTop = privacyCorner()?.chipsTop ?? null;
        const bottom = chipsTop === null ? y + h : chipsTop - CHIPS_GAP * scale;
        const top = Math.max(monitor.y + MARGIN * scale, Math.min(bottom - height, monitor.y + monitor.height - height - MARGIN * scale));
        this.set_position(Math.round(left), Math.round(top));
        this.set_size(width, height);
        this.set_pivot_point(this._side > 0 ? 0 : 1, 1);
        this._mask.resize(width, height, RADIUS * scale);
        this._copy.set({translation_x: -left, translation_y: -top});
    }

    destroy() {
        this._run++;
        if (this._leaveId)
            GLib.source_remove(this._leaveId);
        this._leaveId = 0;
        this._store.disconnect(this._storeId);
        this._copy.destroy_all_children();
        Main.layoutManager.removeChrome(this);
        super.destroy();
    }
});
