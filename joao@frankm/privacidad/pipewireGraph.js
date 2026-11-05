// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Reads what `pw-dump` and `fuser` print. No GNOME Shell here, so the tests can run it alone.
import GLib from 'gi://GLib';

const SYSTEM_PROCESSES = ['pipewire', 'wireplumber', 'gnome-shell'];

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : '';
    } catch {
        return '';
    }
}

export function parentPid(pid) {
    // "pid (name with spaces and parens) state ppid …"
    const stat = readText(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[1]) || 0;
}

export function parseFuser(output) {
    return output.trim().split(/\s+/).filter(Boolean).map(Number)
        .filter(pid => pid > 0 && !SYSTEM_PROCESSES.includes(readText(`/proc/${pid}/comm`).trim()));
}

// Who reads the camera and the shared screen, and the audio streams by the number PulseAudio
// knows them by (Gvc's stream index is PipeWire's object.serial).
export function parseGraph(objects) {
    const nodes = new Map();
    const clients = new Map();
    const links = [];
    for (const object of objects) {
        if (object.type?.endsWith(':Node'))
            nodes.set(object.id, object.info?.props ?? {});
        else if (object.type?.endsWith(':Client'))
            clients.set(object.id, object.info?.props ?? {});
        else if (object.type?.endsWith(':Link'))
            links.push(object.info ?? {});
    }

    const describe = props => {
        const client = clients.get(Number(props['client.id'])) ?? {};
        return {
            pid: Number(props['application.process.id'] ?? client['application.process.id'] ?? client['pipewire.sec.pid']) || 0,
            appId: client['pipewire.access.portal.app_id'] ?? props['application.id'] ?? client['application.id'] ?? null,
            name: props['application.name'] ?? client['application.name'] ?? null,
        };
    };
    const readersOf = isSource => {
        const readers = new Map();
        for (const link of links) {
            const from = nodes.get(link['output-node-id']);
            const to = nodes.get(link['input-node-id']);
            if (from && to && isSource(from) && to['media.class'] === 'Stream/Input/Video')
                readers.set(link['input-node-id'], describe(to));
        }
        return [...readers.values()];
    };

    const bySerial = new Map();
    for (const props of nodes.values()) {
        if (props['media.class'] === 'Stream/Input/Audio')
            bySerial.set(String(props['object.serial']), describe(props));
    }
    return {
        bySerial,
        camera: readersOf(p => p['media.class'] === 'Video/Source' && p['media.role'] === 'Camera'),
        screen: readersOf(p => p['media.class'] === 'Stream/Output/Video' && p['node.name']?.startsWith('meta-screen-cast')),
    };
}
