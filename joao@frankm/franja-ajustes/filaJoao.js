// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// João's privacy row in the settings strip: the segmented ring, "Mic + cámara · App" and an orange
// equalizer. Only while the microphone or the camera is in use (privacidad/privacyMonitor.js, the
// same source as the corner indicator and the bubble's border). While shown and with animations on,
// the ring turns once every 6 s and the equalizer beats; looping() lets the strip stop them while
// it is hidden.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {privacyMonitor} from '../privacidad/privacyMonitor.js';
import {SegmentRing} from '../privacidad/segmentRing.js';
import {animations} from './iconosAnimados.js';

const DEVICES = ['microphone', 'camera'];
const TURN_TIME = 6000;
const BARS = [[420, 0.35], [300, 0.5], [520, 0.3], [360, 0.45]];   // [ms, lowest scale]

export const FilaJoao = GObject.registerClass(
class JoaoAjustesFilaJoao extends St.BoxLayout {
    _init() {
        super._init({style_class: 'joao-ajustes-fila-joao', x_expand: true, visible: false});
        this._ring = new SegmentRing(8, {y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
        this._label = new St.Label({style_class: 'joao-ajustes-fila-joao-texto', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._eq = new St.BoxLayout({style_class: 'joao-ajustes-ecualizador', y_align: Clutter.ActorAlign.CENTER});
        this._bars = BARS.map(() => {
            const bar = new St.Widget({style_class: 'joao-ajustes-ecualizador-barra',
                pivot_point: new Graphene.Point({x: 0.5, y: 1}), y_align: Clutter.ActorAlign.END});
            this._eq.add_child(bar);
            return bar;
        });
        this.add_child(this._ring);
        this.add_child(this._label);
        this.add_child(this._eq);
        this._looping = false;
        this._monitor = privacyMonitor();
        this._monitorId = this._monitor?.connect('changed', () => this._sync()) ?? 0;
        this._sync();
        this.connect('destroy', () => {
            if (this._monitorId)
                this._monitor.disconnect(this._monitorId);
        });
    }

    _sync() {
        const state = this._monitor?.state ?? {};
        const used = DEVICES.filter(d => (state[d] ?? []).length > 0);
        this.visible = used.length > 0;
        this._ring.setActive(used);
        if (used.length) {
            const what = used.length === 2 ? 'Mic + cámara' : used[0] === 'microphone' ? 'Micrófono' : 'Cámara';
            const apps = [...new Set(used.flatMap(d => state[d]).map(e => e.app?.get_name() ?? e.name).filter(Boolean))];
            this._label.text = apps.length ? `${what} · ${apps.join(', ')}` : what;
            this.accessible_name = `${what} en uso${apps.length ? ` por ${apps.join(', ')}` : ''}`;
        }
        this._syncLoop();
    }

    // The strip says whether it is on screen.
    looping(on) {
        this._looping = on;
        this._syncLoop();
    }

    _syncLoop() {
        const run = this._looping && this.visible && animations();
        if (run === this._running)
            return;
        this._running = run;
        this._ring.remove_all_transitions();
        this._bars.forEach(b => b.remove_all_transitions());
        if (!run) {
            this._ring.rotation_angle_z = 0;
            this._bars.forEach(b => b.set({scale_y: 1}));
            return;
        }
        this._ring.rotation_angle_z = 0;
        this._ring.ease({rotation_angle_z: 360, duration: TURN_TIME, repeatCount: -1, mode: Clutter.AnimationMode.LINEAR});
        this._bars.forEach((bar, i) => {
            const [ms, low] = BARS[i];
            bar.scale_y = 1;
            bar.ease({scale_y: low, duration: ms, repeatCount: -1, autoReverse: true,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE});
        });
    }
});
