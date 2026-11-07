// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Which app is using the microphone, the camera or the screen. The same sources as GNOME's own
// indicators say THAT a device is in use; PipeWire's graph and the process tree say WHO.
// One addition: GNOME only sees cameras opened through PipeWire, and browsers open /dev/video*
// directly, so those files are checked too.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {parseGraph, parseFuser, parentPid} from './pipewireGraph.js';

// In the order the marks use.
export const DEVICES = ['microphone', 'camera', 'screen'];
export const DEVICE_INFO = {
    microphone: {name: 'Micrófono', short: 'Micrófono', inUse: 'Micrófono en uso', doing: 'usando el micrófono', icon: 'audio-input-microphone-symbolic'},
    camera: {name: 'Cámara', short: 'Cámara', inUse: 'Cámara en uso', doing: 'usando la cámara', icon: 'camera-web-symbolic'},
    screen: {name: 'Pantalla compartida', short: 'Pantalla', inUse: 'Pantalla compartida', doing: 'compartiendo pantalla', icon: 'screen-shared-symbolic'},
};

// The same list as GNOME: they only show the input level.
const LEVEL_METERS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];
const SETTLE = 120;           // ms: a burst of stream changes is read once
const RETRY = 1000;           // ms: the graph may not have its links yet when the device starts
const CAMERA_POLL = 5;        // s
const MAX_ANCESTORS = 16;
const VIDEO_DEVICES = 16;

let current = null;
export const privacyMonitor = () => current;

// The app behind a process: its own window, or a parent's (a terminal for what runs inside it).
async function appFromPid(pid) {
    const tracker = Shell.WindowTracker.get_default();
    for (let i = 0; pid > 1 && i < MAX_ANCESTORS; i++) {
        const app = tracker.get_app_from_pid(pid);
        if (app)
            return app;
        pid = await parentPid(pid);
    }
    return null;
}

function appFromId(id) {
    if (!id)
        return null;
    const system = Shell.AppSystem.get_default();
    return system.lookup_app(`${id}.desktop`) ??
        system.lookup_app(id) ??
        system.lookup_desktop_wmclass(id) ??
        system.lookup_startup_wmclass(id) ??
        system.lookup_heuristic_basename(`${id}.desktop`);
}

async function identify({pid = 0, appId = null, name = null}) {
    const app = appFromId(appId) ?? (pid ? await appFromPid(pid) : null) ?? appFromId(name);
    return {app, appId: app?.get_id() ?? null, name: app?.get_name() ?? name ?? 'Una app', pid};
}

function run(argv) {
    return new Promise((resolve, reject) => {
        try {
            const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            process.communicate_utf8_async(null, null, (p, result) => {
                try {
                    resolve(p.communicate_utf8_finish(result)[1] ?? '');
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

export const PrivacyMonitor = GObject.registerClass({
    Signals: {changed: {}},
}, class JoaoPrivacyMonitor extends GObject.Object {
    _init() {
        super._init();
        current = this;
        this.state = {microphone: [], camera: [], screen: []};
        this._signature = '';
        this._handles = new Set();
        this._directCamera = [];
        this._ids = [];
        this._streamIds = [];
        this._token = 0;
        this._since = new Map();   // 'device:app' -> when it started (s, real time)
        this._alive = true;

        this._control = getMixerControl();
        this._listen(this._control, 'stream-added', () => this._queue());
        this._listen(this._control, 'stream-removed', () => this._queue());
        this._listen(this._control, 'state-changed', () => this._queue());

        this._cameraMonitor = new Shell.CameraMonitor();
        this._listen(this._cameraMonitor, 'notify::cameras-in-use', () => this._queue());

        this._controller = global.backend.get_remote_access_controller();
        if (this._controller)
            this._listen(this._controller, 'new-handle', (c, handle) => this._addHandle(handle));
        // Sharing that started before João: GNOME's indicators know about it.
        const remote = Main.panel?.statusArea?.quickSettings?._remoteAccess?._handles ?? [];
        const sharing = Main.panel?.statusArea?.screenSharing?._handles ?? [];
        [...remote, ...sharing].forEach(handle => this._addHandle(handle));

        // GNOME's own screen recorder.
        if (Main.screenshotUI)
            this._listen(Main.screenshotUI, 'notify::screencast-in-progress', () => this._queue());

        // A window that appears later says whose a recording process was.
        this._listen(Shell.WindowTracker.get_default(), 'tracked-windows-changed', () => {
            if (this._hasUnknown)
                this._queue();
        });

        this._cameraPollId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, CAMERA_POLL, () => {
            this._pollCamera();
            return GLib.SOURCE_CONTINUE;
        });
        this._pollCamera();
        this._queue();
    }

    _listen(object, signal, handler) {
        this._ids.push([object, object.connect(signal, handler)]);
    }

    _addHandle(handle) {
        if (this._handles.has(handle))
            return;
        this._handles.add(handle);
        const id = handle.connect('stopped', () => {
            handle.disconnect(id);
            this._handles.delete(handle);
            this._queue();
        });
        this._queue();
    }

    _queue() {
        if (this._queueId)
            return;
        this._queueId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE, () => {
            this._queueId = 0;
            this._refresh().catch(e => logError(e, 'João: privacidad'));
            return GLib.SOURCE_REMOVE;
        });
    }

    // Who has a video device open without going through PipeWire. fuser only sees this user's
    // processes, which is what matters; PipeWire's own hold is the case GNOME already covers.
    async _pollCamera() {
        const devices = [];
        for (let i = 0; i < VIDEO_DEVICES; i++) {
            const path = `/dev/video${i}`;
            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                devices.push(path);
        }
        if (!devices.length || !GLib.find_program_in_path('fuser'))
            return;
        let pids = [];
        try {
            pids = await parseFuser(await run(['fuser', ...devices]));
        } catch {
            return;
        }
        if (!this._alive)
            return;
        const same = pids.length === this._directCamera.length && pids.every(p => this._directCamera.includes(p));
        this._directCamera = pids;
        if (!same)
            this._queue();
    }

    get _inputs() {
        return this._control.get_state() === Gvc.MixerControlState.READY
            ? this._control.get_source_outputs().filter(o => !LEVEL_METERS.includes(o.get_application_id()))
            : [];
    }

    async _refresh() {
        const token = ++this._token;
        const inputs = this._inputs;
        const cameras = this._cameraMonitor.cameras_in_use > 0;
        // A recording by GNOME itself has its own row below; these are the apps sharing the screen.
        const sharing = this.sharingHandles.length > 0;

        let graph = null;
        if (inputs.length || cameras || sharing) {
            try {
                graph = parseGraph(JSON.parse(await run(['pw-dump'])));
            } catch {
                graph = null;   // no pw-dump: the apps are known less well, the devices just as well
            }
            if (!this._alive || token !== this._token)
                return;
        }

        const [microphone, cameraUsers, directCamera, screen] = await Promise.all([
            Promise.all(inputs.map(async stream => {
                const node = graph?.bySerial.get(String(stream.get_index()));
                return {...await identify({pid: node?.pid, appId: stream.get_application_id() ?? node?.appId,
                    name: node?.name ?? stream.get_name()}), stream};
            })),
            cameras ? this._consumers(graph?.camera) : [],
            Promise.all(this._directCamera.map(pid => identify({pid}))),
            sharing ? this._consumers(graph?.screen) : [],
        ]);
        if (!this._alive || token !== this._token)
            return;
        const state = {
            microphone: this._group(microphone),
            camera: this._group([...cameraUsers, ...directCamera]),
            screen: this.recording
                ? [{app: null, appId: null, name: 'Grabación de pantalla', pid: 0, streams: [], recording: true},
                    ...this._group(screen)]
                : this._group(screen),
        };
        this._stamp(state);
        this._hasUnknown = DEVICES.some(d => state[d].some(entry => !entry.app));
        this._watchStreams(state.microphone);
        this._publish(state);

        // The graph had no reader for a device that says it is in use: look again in a moment.
        const unfinished = (cameras && !graph?.camera.length) || (sharing && !graph?.screen.length);
        if (unfinished && !this._retried) {
            this._retried = true;
            this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY, () => {
                this._retryId = 0;
                this._queue();
                return GLib.SOURCE_REMOVE;
            });
        } else if (!unfinished) {
            this._retried = false;
        }
    }

    // In use, but the app cannot be known: still one "Una app".
    async _consumers(nodes) {
        const found = await Promise.all((nodes ?? []).map(node =>
            identify({pid: node.pid, appId: node.appId, name: node.name})));
        return found.length ? found : [await identify({})];
    }

    // One entry per app, with all its streams.
    _group(entries) {
        const groups = new Map();
        for (const entry of entries) {
            const key = entry.appId ?? `name:${entry.name}`;
            const group = groups.get(key) ?? {...entry, streams: []};
            if (entry.stream)
                group.streams.push(entry.stream);
            delete group.stream;
            groups.set(key, group);
        }
        // A known app beats "Una app" for the same device.
        const list = [...groups.values()];
        const known = list.filter(e => e.app || e.name !== 'Una app');
        return known.length ? known : list;
    }

    get recording() {
        return !!Main.screenshotUI?.screencast_in_progress;
    }

    // Each use keeps the time it started, for the card's clock.
    _stamp(state) {
        const now = GLib.get_real_time() / 1e6;
        const seen = new Set();
        for (const device of DEVICES) {
            for (const entry of state[device]) {
                const key = `${device}:${entry.appId ?? entry.name}`;
                seen.add(key);
                if (!this._since.has(key))
                    this._since.set(key, now);
                entry.since = this._since.get(key);
            }
        }
        for (const key of [...this._since.keys()]) {
            if (!seen.has(key))
                this._since.delete(key);
        }
    }

    _watchStreams(entries) {
        this._streamIds.forEach(([stream, id]) => stream.disconnect(id));
        this._streamIds = [];
        for (const stream of entries.flatMap(e => e.streams))
            this._streamIds.push([stream, stream.connect('notify::is-muted', () => this._publish(this.state))]);
    }

    _publish(state) {
        const signature = JSON.stringify(DEVICES.map(device => state[device].map(e =>
            [e.appId, e.name, e.streams.map(s => s.is_muted)])));
        this.state = state;
        if (signature === this._signature)
            return;
        this._signature = signature;
        this.emit('changed');
    }

    get active() {
        return DEVICES.filter(device => this.state[device].length > 0);
    }

    // What the header's pill says; empty when nothing is in use.
    get text() {
        return this.active.map(device => DEVICE_INFO[device].name).join(' · ');
    }

    // [[device, entry], …] for one app, in the order of DEVICES.
    usesOf(appId) {
        return DEVICES.flatMap(device => this.state[device]
            .filter(entry => entry.appId === appId)
            .map(entry => [device, entry]));
    }

    get sharingHandles() {
        return [...this._handles].filter(handle => !(handle.is_recording && this.recording));
    }

    get defaultInput() {
        return this._control.get_default_source();
    }

    destroy() {
        this._alive = false;
        for (const key of ['_queueId', '_retryId', '_cameraPollId']) {
            if (this[key])
                GLib.source_remove(this[key]);
            this[key] = 0;
        }
        this._ids.forEach(([object, id]) => object.disconnect(id));
        this._ids = [];
        this._streamIds.forEach(([stream, id]) => stream.disconnect(id));
        this._streamIds = [];
        this._cameraMonitor = null;
        this._handles.clear();
        if (current === this)
            current = null;
    }
});
