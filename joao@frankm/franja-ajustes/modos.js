// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Modes: saved sets of settings applied with one click (Trabajo, Reunión, Noche, Cine…).
// Stored as JSON in the key 'modes': [{id, name, color, icon, settings: {bluetooth, dark, dnd,
// 'night-light', wifi?, airplane?, volume?, brightness?}}], only what the mode changes. The one
// chosen last is 'active-mode'.
// Plain pills, no colours. The active one is filled white while it is applied in full; change one of
// its settings by hand and only its outline stays. Clicking the active one again turns it off and
// puts back what the modes changed, as it was before the first of them. "+ Nuevo" saves the current settings under a name typed in the strip; right click
// on a thumbnail: Renombrar · Actualizar con los ajustes actuales · Eliminar. All of it inside the
// strip: the strip holds the keyboard while a name is typed or the menu is open (holdInput).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {animations} from './iconosAnimados.js';

export const SWITCH_KEYS = ['wifi', 'bluetooth', 'dark', 'dnd', 'night-light', 'airplane'];
// What "+ Nuevo" saves: Wi-Fi and airplane mode stay out unless a mode names them.
const SAVED_SWITCHES = ['bluetooth', 'dark', 'dnd', 'night-light'];
const NEW_COLORS = ['#3584e4', '#2ec27e', '#e5a50a', '#c061cb', '#e66100', '#1c9fb0'];
const NEW_ICON = 'starred-symbolic';
const LEVEL_TOLERANCE = 0.02;
const PAGE = 4;
const center = () => new Graphene.Point({x: 0.5, y: 0.5});

export function parseModes(text) {
    try {
        const list = JSON.parse(text);
        return Array.isArray(list) ? list.filter(m => m && typeof m.name === 'string' && m.settings) : [];
    } catch (e) {
        logError(e, 'João: modes');
        return [];
    }
}

const Miniatura = GObject.registerClass(
class JoaoAjustesMiniatura extends St.Button {
    _init(mode) {
        super._init({style_class: 'joao-ajustes-modo', can_focus: true, x_expand: true, y_expand: false,
            pivot_point: center(), accessible_name: mode.name});
        this.mode = mode;
        const content = new St.BoxLayout({style_class: 'joao-ajustes-modo-fila', x_expand: true,
            orientation: Clutter.Orientation.VERTICAL});
        this.icon = new St.Icon({style_class: 'joao-ajustes-modo-icono', icon_name: mode.icon || NEW_ICON, icon_size: 14,
            x_align: Clutter.ActorAlign.CENTER});
        const name = new St.Label({style_class: 'joao-ajustes-modo-nombre', text: mode.name,
            x_align: Clutter.ActorAlign.CENTER});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        content.add_child(this.icon);
        content.add_child(name);
        this.set_child(content);
    }

    setState(active, applied) {
        if (active && applied)
            this.add_style_class_name('activo');
        else
            this.remove_style_class_name('activo');
        if (active && !applied)
            this.add_style_class_name('cambiado');
        else
            this.remove_style_class_name('cambiado');
    }

    // Chosen: a short press, nothing more.
    celebrate() {
        if (!animations())
            return;
        this.remove_all_transitions();
        this.set({scale_x: 0.96, scale_y: 0.96});
        this.ease({scale_x: 1, scale_y: 1, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }
});

export const Modos = GObject.registerClass({
    Signals: {
        'ring-color': {param_types: [GObject.TYPE_STRING]},
        'toast': {param_types: [GObject.TYPE_STRING]},
    },
}, class JoaoAjustesModos extends St.Widget {
    // @switches: the Interruptores (its backends), @controls: the Controles (volume, brightness),
    // @holdInput(onRelease): takes the keyboard for the strip; returns the function that gives it back.
    _init({settings, switches, controls, holdInput}) {
        super._init({style_class: 'joao-ajustes-modos', layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: false});
        this._settings = settings;
        this._switches = switches;
        this._controls = controls;
        this._holdInput = holdInput;
        this._release = null;
        this._thumbs = [];

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'joao-ajustes-modos-caja'});
        this.add_child(box);
        // Title row, or the name being typed.
        this._top = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        const titleRow = this._titleRow = new St.BoxLayout({x_expand: true, style_class: 'joao-ajustes-modos-cabeza'});
        titleRow.add_child(new St.Label({style_class: 'joao-ajustes-titulo', text: 'Modos', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER}));
        this._newButton = new St.Button({style_class: 'joao-ajustes-nuevo', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Nuevo modo: guardar los ajustes actuales',
            child: new St.Icon({icon_name: 'list-add-symbolic', icon_size: 11})});
        this._newButton.connect('clicked', () => this._askName(null));
        titleRow.add_child(this._newButton);
        this._top.add_child(titleRow);
        this._nameRow = new St.BoxLayout({x_expand: true, visible: false, style_class: 'joao-ajustes-nombre-fila'});
        this._entry = new St.Entry({style_class: 'joao-ajustes-nombre', x_expand: true, can_focus: true,
            hint_text: 'Nombre del modo'});
        this._entry.clutter_text.connect('activate', () => this._commitName());
        const ok = new St.Button({style_class: 'joao-ajustes-nombre-ok', can_focus: true, accessible_name: 'Guardar',
            child: new St.Icon({icon_name: 'object-select-symbolic', icon_size: 14})});
        ok.connect('clicked', () => this._commitName());
        this._nameRow.add_child(this._entry);
        this._nameRow.add_child(ok);
        this._top.add_child(this._nameRow);
        box.add_child(this._top);

        // One row of four, as a segmented bar: four modes at a time; with more, the wheel turns the page.
        this._grid = new St.Widget({layout_manager: new Clutter.GridLayout({column_homogeneous: true,
            column_spacing: 4, row_spacing: 4}), x_expand: true, style_class: 'joao-ajustes-modos-rejilla',
        reactive: true});
        this._grid.connect('scroll-event', (a, event) => this._onScroll(event));
        this._page = 0;
        box.add_child(this._grid);

        // The right-click menu, over the grid.
        this._menu = new St.BoxLayout({style_class: 'joao-ajustes-modos-menu', orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, y_align: Clutter.ActorAlign.END, visible: false, reactive: true});
        this._menuTitle = new St.Label({style_class: 'joao-ajustes-modos-menu-titulo'});
        this._menu.add_child(this._menuTitle);
        for (const [label, fn] of [
            ['Renombrar', mode => this._askName(mode)],
            ['Actualizar con los ajustes actuales', mode => this._update(mode)],
            ['Eliminar', mode => this._delete(mode)],
        ]) {
            const item = new St.Button({style_class: 'joao-ajustes-modos-menu-item', label, can_focus: true, x_expand: true,
                x_align: Clutter.ActorAlign.FILL});
            item.get_child().x_align = Clutter.ActorAlign.START;
            item.connect('clicked', () => {
                const mode = this._menuMode;
                this._closeMenu();
                if (mode)
                    fn(mode);
            });
            this._menu.add_child(item);
        }
        this.add_child(this._menu);

        this._ids = [
            settings.connect('changed::modes', () => this._build()),
            settings.connect('changed::active-mode', () => this._syncState()),
        ];
        this._watchIds = [];
        this._build();
        this.connect('destroy', () => this._onDestroy());
    }

    get modes() {
        return parseModes(this._settings.get_string('modes'));
    }

    _save(modes) {
        this._settings.set_string('modes', JSON.stringify(modes));
    }

    // Modes have no colour any more: the bubble keeps its own.
    get ringColor() {
        return null;
    }

    get activeId() {
        return this._settings.get_string('active-mode');
    }

    _build() {
        this._thumbs.forEach(thumb => thumb.destroy());
        const layout = this._grid.layout_manager;
        this._thumbs = this.modes.map(mode => {
            const thumb = new Miniatura(mode);
            thumb.connect('clicked', () => {
                if (this.activeId === mode.id)
                    this.turnOff();
                else
                    this.apply(mode.id);
            });
            thumb.connect('button-press-event', (a, event) => {
                if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                    return Clutter.EVENT_PROPAGATE;
                this._openMenu(mode);
                return Clutter.EVENT_STOP;
            });
            return thumb;
        });
        this._layout = layout;
        this._grid.visible = this._thumbs.length > 0;
        this._showPage(this._page);
        this._syncState();
    }

    get _pages() {
        return Math.max(1, Math.ceil(this._thumbs.length / PAGE));
    }

    // The four thumbnails of @page in the grid (the others wait outside it).
    _showPage(page) {
        this._page = Math.max(0, Math.min(page, this._pages - 1));
        for (const thumb of this._grid.get_children())
            this._grid.remove_child(thumb);
        this._thumbs.slice(this._page * PAGE, (this._page + 1) * PAGE).forEach((thumb, i) =>
            this._layout.attach(thumb, i, 0, 1, 1));
    }

    _onScroll(event) {
        if (this._pages < 2)
            return Clutter.EVENT_PROPAGATE;
        const direction = event.get_scroll_direction();
        let step = 0;
        if (direction === Clutter.ScrollDirection.DOWN)
            step = 1;
        else if (direction === Clutter.ScrollDirection.UP)
            step = -1;
        else if (direction === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            this._wheel = (this._wheel ?? 0) + dy;
            if (Math.abs(this._wheel) >= 1) {
                step = Math.sign(this._wheel);
                this._wheel = 0;
            }
        }
        if (step)
            this._showPage((this._page + step + this._pages) % this._pages);
        return Clutter.EVENT_STOP;
    }

    // Once the switches' backends exist.
    watch() {
        const backends = this._switches.backends;
        if (!backends)
            return;
        for (const sw of Object.values(this._switches.switches))
            this._watchIds.push([sw, sw.connect('toggled', () => this._syncState())]);
        for (const row of [this._controls.volume, this._controls.brightness]) {
            this._watchIds.push([row.slider, row.slider.connect('notify::value', () => this._queueSync())]);
            // Whether there is volume or brightness at all is known a moment later.
            this._watchIds.push([row.row, row.row.connect('notify::visible', () => this._queueSync())]);
        }
        this._syncState();
    }

    // Sliders send many values while moving: look once they rest.
    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._syncId = 0;
            this._syncState();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- reading and applying ----------

    _current() {
        const backends = this._switches.backends ?? {};
        const now = {};
        for (const key of SWITCH_KEYS) {
            if (backends[key]?.available)
                now[key] = backends[key].on;
        }
        if (this._controls.volume.row.visible)
            now.volume = this._controls.volume.slider.value;
        if (this._controls.brightness.row.visible)
            now.brightness = this._controls.brightness.slider.value;
        return now;
    }

    // Does the machine look as the mode says? What it cannot change (no Bluetooth…) does not count.
    _matches(mode) {
        const now = this._current();
        return Object.entries(mode.settings).every(([key, value]) => {
            if (!(key in now))
                return true;
            if (typeof value === 'number')
                return Math.abs(now[key] - value) <= LEVEL_TOLERANCE;
            return now[key] === value;
        });
    }

    _syncState() {
        const active = this.activeId;
        for (const thumb of this._thumbs) {
            const on = thumb.mode.id === active;
            thumb.setState(on, on && this._matches(thumb.mode));
        }
    }

    apply(id) {
        const mode = this.modes.find(m => m.id === id);
        if (!mode)
            return;
        // What it was like before the first mode: turning the modes off puts it back.
        if (!this._before || !this.activeId) {
            this._before = this._current();
            this._touched = new Set();
        }
        Object.keys(mode.settings).forEach(key => this._touched.add(key));
        this._set(mode.settings);
        this._settings.set_string('active-mode', mode.id);
        this._thumbs.find(t => t.mode.id === id)?.celebrate();
        this._syncState();
        this.emit('toast', `Modo ${mode.name} · ajustes aplicados`);
    }

    _set(settings) {
        const backends = this._switches.backends ?? {};
        for (const [key, value] of Object.entries(settings)) {
            if (SWITCH_KEYS.includes(key))
                backends[key]?.set(!!value);
            else if (key === 'volume' && this._controls.volume.row.visible)
                this._controls.volume.slider.value = Math.max(0, Math.min(value, this._controls.volume.slider.maximum_value));
            else if (key === 'brightness' && this._controls.brightness.row.visible)
                this._controls.brightness.slider.value = Math.max(0, Math.min(value, 1));
        }
    }

    // The active mode clicked again: no mode, and what the modes changed goes back.
    turnOff() {
        const mode = this.modes.find(m => m.id === this.activeId);
        if (this._before && this._touched) {
            const back = {};
            for (const key of this._touched) {
                if (key in this._before)
                    back[key] = this._before[key];
            }
            this._set(back);
        }
        this._before = null;
        this._touched = null;
        this._settings.set_string('active-mode', '');
        this._syncState();
        if (mode)
            this.emit('toast', `Modo ${mode.name} desactivado`);
    }

    // What "+ Nuevo" and "Actualizar" save.
    _snapshot(old = null) {
        const now = this._current();
        const keys = old ? Object.keys(old.settings) : [...SAVED_SWITCHES, 'volume', 'brightness'];
        const settings = {};
        for (const key of keys) {
            if (key in now)
                settings[key] = typeof now[key] === 'number' ? Math.round(now[key] * 100) / 100 : now[key];
            else if (old && key in old.settings)
                settings[key] = old.settings[key];
        }
        return settings;
    }

    // ---------- naming, the menu ----------

    _askName(mode) {
        this._closeMenu();
        this._renaming = mode;
        this._titleRow.hide();
        this._nameRow.show();
        this._entry.text = mode ? mode.name : '';
        this._release?.();
        this._release = this._holdInput(() => this._endName());
        this._entry.grab_key_focus();
        this._entry.clutter_text.set_selection(0, -1);
    }

    _commitName() {
        const name = this._entry.text.trim();
        const renaming = this._renaming;
        this._endName();
        if (!name)
            return;
        const modes = this.modes;
        if (renaming) {
            const mode = modes.find(m => m.id === renaming.id);
            if (mode)
                mode.name = name;
            this._save(modes);
            return;
        }
        const id = `modo-${GLib.uuid_string_random().slice(0, 8)}`;
        modes.push({id, name, color: NEW_COLORS[modes.length % NEW_COLORS.length], icon: NEW_ICON,
            settings: this._snapshot()});
        this._save(modes);
        this._settings.set_string('active-mode', id);
        this.emit('toast', `Modo ${name} guardado`);
    }

    _endName() {
        if (!this._nameRow.visible)
            return;
        this._nameRow.hide();
        this._titleRow.show();
        this._renaming = null;
        const release = this._release;
        this._release = null;
        release?.();
    }

    _openMenu(mode) {
        this._endName();
        this._menuMode = mode;
        this._menuTitle.text = mode.name;
        this._menu.show();
        this._release?.();
        this._release = this._holdInput(() => this._closeMenu());
        this._menu.get_child_at_index(1).grab_key_focus();
    }

    _closeMenu() {
        if (!this._menu.visible)
            return;
        this._menu.hide();
        this._menuMode = null;
        const release = this._release;
        this._release = null;
        release?.();
    }

    // Esc and clicks elsewhere end the name or the menu.
    cancel() {
        this._endName();
        this._closeMenu();
    }

    _update(mode) {
        const modes = this.modes;
        const target = modes.find(m => m.id === mode.id);
        if (!target)
            return;
        target.settings = this._snapshot(target);
        this._save(modes);
        this.emit('toast', `Modo ${mode.name} actualizado`);
    }

    _delete(mode) {
        this._save(this.modes.filter(m => m.id !== mode.id));
        if (this.activeId === mode.id)
            this._settings.set_string('active-mode', '');
    }

    _onDestroy() {
        this._release?.();
        this._release = null;
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._syncId = 0;
        this._thumbs.forEach(thumb => thumb.destroy());
        this._thumbs = [];
        this._ids.forEach(id => this._settings.disconnect(id));
        this._watchIds.forEach(([obj, id]) => obj.disconnect(id));
        this._watchIds = [];
    }
});

