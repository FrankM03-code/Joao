// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What the search box can find among the system's controls and actions.
// "control" results light up the control in the panel; "action" results run it.
const fold = text => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

const SETTINGS = [
    {id: 'volume', name: 'Volumen', icon: 'audio-volume-high-symbolic', words: ['volumen', 'sonido', 'audio', 'silenciar']},
    {id: 'brightness', name: 'Brillo', icon: 'display-brightness-symbolic', words: ['brillo', 'pantalla']},
    {id: 'wifi', name: 'Wi‑Fi', icon: 'network-wireless-symbolic', words: ['wifi', 'wi-fi', 'red', 'internet']},
    {id: 'bluetooth', name: 'Bluetooth', icon: 'bluetooth-active-symbolic', words: ['bluetooth']},
    {id: 'dark', name: 'Modo oscuro', icon: 'dark-mode-symbolic', words: ['oscuro', 'modo oscuro', 'tema']},
    {id: 'dnd', name: 'No molestar', icon: 'notifications-disabled-symbolic', words: ['no molestar', 'molestar', 'notificaciones']},
    {id: 'night', name: 'Luz nocturna', icon: 'night-light-symbolic', words: ['luz nocturna', 'nocturna', 'noche']},
    {id: 'airplane', name: 'Modo avión', icon: 'airplane-mode-symbolic', words: ['avion', 'modo avion']},
    {id: 'profile', name: 'Modo de energía', icon: 'power-profile-balanced-symbolic', words: ['energia', 'modo de energia', 'rendimiento', 'ahorro']},
    {id: 'lock', name: 'Bloquear', icon: 'system-lock-screen-symbolic', words: ['bloquear'], action: true},
    {id: 'suspend', name: 'Suspender', icon: 'media-playback-pause-symbolic', words: ['suspender'], action: true},
    {id: 'restart', name: 'Reiniciar', icon: 'system-reboot-symbolic', words: ['reiniciar'], action: true},
    {id: 'poweroff', name: 'Apagar', icon: 'system-shutdown-symbolic', words: ['apagar'], action: true},
    {id: 'logout', name: 'Cerrar sesión', icon: 'system-log-out-symbolic', words: ['cerrar sesion', 'salir'], action: true},
    {id: 'settings', name: 'Ajustes', icon: 'org.gnome.Settings-symbolic', words: ['ajustes', 'configuracion'], action: true},
    {id: 'awake', name: 'Modo activo', icon: 'weather-clear-symbolic', words: ['modo activo', 'activo', 'suspender', 'suspension', 'cafeina']},
];

export function searchSettings(query) {
    const q = fold(query.trim());
    if (q.length < 2)
        return [];
    return SETTINGS.filter(s => s.words.some(w => w.startsWith(q)));
}
