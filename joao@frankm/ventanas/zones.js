// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The places a window can be tiled to by hand. No GNOME imports: plain geometry.
export const MAXIMIZE = 'maximize';
export const RESTORE = 'restore';

const EDGE = 3;       // px from the screen edge that count as touching it
const CORNER = 96;    // px along an edge that count as its corner

// Which zone is under the pointer while a window is dragged, or null.
// @bounds: the monitor. @blocked: edges shared with another monitor, which are not zones.
export function zoneAt(x, y, bounds, blocked = {}) {
    const right = bounds.x + bounds.width - 1;
    const bottom = bounds.y + bounds.height - 1;
    const atLeft = !blocked.left && x <= bounds.x + EDGE;
    const atRight = !blocked.right && x >= right - EDGE;
    const atTop = !blocked.top && y <= bounds.y + EDGE;
    const atBottom = !blocked.bottom && y >= bottom - EDGE;
    if (atLeft || atRight) {
        const side = atLeft ? 'left' : 'right';
        if (y < bounds.y + CORNER)
            return `top-${side}`;
        return y > bottom - CORNER ? `bottom-${side}` : side;
    }
    if (!atTop && !atBottom)
        return null;
    if (x < bounds.x + CORNER)
        return atTop ? 'top-left' : 'bottom-left';
    if (x > right - CORNER)
        return atTop ? 'top-right' : 'bottom-right';
    return atTop ? MAXIMIZE : 'bottom';
}

// The rectangle of @zone inside @area, with @gap as margin and as room between windows.
export function zoneRect(zone, area, gap) {
    if (zone === MAXIMIZE)
        return {...area};
    const innerW = area.width - 2 * gap;
    const innerH = area.height - 2 * gap;
    const halfW = Math.floor((innerW - gap) / 2);
    const halfH = Math.floor((innerH - gap) / 2);
    const isRight = zone.endsWith('right');
    const isLeft = zone.endsWith('left');
    const isBottom = zone.startsWith('bottom');
    const isTop = zone.startsWith('top');
    return {
        x: area.x + gap + (isRight ? halfW + gap : 0),
        y: area.y + gap + (isBottom ? halfH + gap : 0),
        width: isRight ? innerW - halfW - gap : isLeft ? halfW : innerW,
        height: isTop ? halfH : isBottom ? innerH - halfH - gap : innerH,
    };
}

// What an arrow key does from each zone: @zone is null when the window is not tiled. Pressing
// towards the side it is already on gives its size back. Returns null when there is nothing to do.
const MOVES = {
    left: {
        none: 'left', [MAXIMIZE]: 'left', right: 'left', bottom: 'bottom-left',
        'top-right': 'top-left', 'bottom-right': 'bottom-left',
        left: RESTORE, 'top-left': RESTORE, 'bottom-left': RESTORE,
    },
    right: {
        none: 'right', [MAXIMIZE]: 'right', left: 'right', bottom: 'bottom-right',
        'top-left': 'top-right', 'bottom-left': 'bottom-right',
        right: RESTORE, 'top-right': RESTORE, 'bottom-right': RESTORE,
    },
    up: {
        none: MAXIMIZE, left: 'top-left', right: 'top-right', bottom: MAXIMIZE,
        'bottom-left': 'left', 'bottom-right': 'right',
    },
    down: {
        [MAXIMIZE]: RESTORE, left: 'bottom-left', right: 'bottom-right', bottom: RESTORE,
        'top-left': 'left', 'top-right': 'right',
    },
};

export const nextZone = (zone, key) => MOVES[key][zone ?? 'none'] ?? null;
