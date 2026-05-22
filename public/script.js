let socket, board, ctx, canvas;
let zIndexCounter = 10000;
let isDragging = false;
let currentDragElement = null;
let dragOffset = { x: 0, y: 0 };
let currentDrawMode = null;
let currentLineWidth = 2;
let lastDrawPos = { x: 0, y: 0 };
let localDrawings = [];
let isDrawing = false;

let velocity = { x: 0, y: 0 };
let lastPos = { x: 0, y: 0 };
let lastTime = 0;
let animationFrameId = null;
const friction = 0.80;
const stopThreshold = 0.5;

let longPressTimer = null;
let remoteCursors = {};

// FIX: Added throttle trackers to prevent socket flooding
let lastMoveEmit = 0;
let lastCursorEmit = 0;

let myRole = 'student';
let studentPerms = { move: false, draw: false, erase: false };
let currentBackground = 'none';
let currentBoardSize = localStorage.getItem('userBoardSize') || 'large';

function getEventPoint(e) {
    if (e.touches && e.touches.length > 0) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
}

document.addEventListener('DOMContentLoaded', () => {
    board = document.getElementById('board');
    setupCanvas();

    try {
        socket = io();
        socket.on('connect', () => {
            setupSocketListeners();
            attemptJoinFromUrl();
        });
    } catch (e) { console.error("Socket Error", e); }

    const tiles = document.querySelectorAll('.tile');
    const idCounters = {};

    tiles.forEach(tile => {
        let text = tile.innerText.trim().toLowerCase();
        let key = text.replace(/[^a-z0-9]/g, '') || 'tile';
        idCounters[key] = (idCounters[key] || 0) + 1;
        tile.id = `tile-${key}-${idCounters[key]}`;

        let level = 4;
        if (['a', 'e', 'i', 'o', 'u'].includes(text) || tile.closest('.alphabet-strip')) { level = 1; }
        else if (tile.closest('.right-complex') || tile.closest('.suffix-row')) { level = 2; }
        else if (tile.closest('#section-roots') || tile.closest('.prefix-col')) { level = 3; }

        tile.setAttribute('data-min-start', level);
        tile.setAttribute('data-state', 'idle');
        attachTileListeners(tile);
    });

    const lobbyInput = document.getElementById('modal-input');
    const userInput = document.getElementById('modal-username');
    const passInput = document.getElementById('modal-password');
    if (lobbyInput) lobbyInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') attemptJoinFromModal(); });
    if (userInput) userInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') attemptJoinFromModal(); });
    if (passInput) passInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') attemptJoinFromModal(); });

    document.addEventListener('mousemove', onGlobalMove, { passive: false });
    document.addEventListener('touchmove', onGlobalMove, { passive: false });
    document.addEventListener('mouseup', onGlobalEnd);
    document.addEventListener('touchend', onGlobalEnd);
    document.addEventListener('touchcancel', onGlobalEnd);

    restoreSettings();
    refreshLayoutDropdown();

    applyBoardSize(currentBoardSize, false);
    if (canvas) canvas.style.pointerEvents = 'none';
});

function setupSocketListeners() {
    socket.on('joinSuccess', (data) => {
        myRole = data.role;
        document.body.setAttribute('data-role', myRole);
        document.getElementById('landing-modal').style.display = 'none';

        const badge = document.getElementById('role-badge');
        if (myRole === 'tutor') {
            badge.innerText = `(Tutor ${data.name})`;
            badge.style.color = "#00bcd4";
            if (data.isAdmin) {
                const adminBtn = document.getElementById('admin-access-btn');
                if (adminBtn) adminBtn.style.display = 'block';
            }
        } else {
            badge.innerText = "(Student)";
            badge.style.color = "#aaa";
        }

        socket.emit('requestState');
        applyPermissions(data.perms);
    });

    socket.on('joinError', (msg) => {
        const err = document.getElementById('modal-error');
        err.innerText = msg; err.style.display = 'block';
    });

    socket.on('roomClosed', (msg) => { alert(msg); window.location.href = '/'; });
    socket.on('permissionsUpdated', (newPerms) => { applyPermissions(newPerms); });

    socket.on('accountAlert', (msg) => {
        alert(msg);
        if (msg.includes("Success") || msg.includes("deleted") || msg.includes("updated")) {
            if (document.getElementById('admin-modal').style.display === 'flex') { socket.emit('requestAccounts'); hideAdminForm(); }
        }
    });

    socket.on('accountList', (accounts) => {
        const tbody = document.getElementById('admin-accounts-list');
        if (!tbody) return;
        tbody.innerHTML = '';
        for (let uname in accounts) {
            const acc = accounts[uname];
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid #333';
            const actionsHTML = acc.isAdmin ?
                `<button onclick="editAccountInit('${uname}', '${acc.name}', '${acc.rooms}')" style="background: #00bcd4; color: black; border: none; border-radius: 4px; cursor: pointer; padding: 6px 12px; font-weight: bold;">Edit</button>` :
                `<button onclick="editAccountInit('${uname}', '${acc.name}', '${acc.rooms}')" style="background: #00bcd4; color: black; border: none; border-radius: 4px; cursor: pointer; padding: 6px 12px; margin-right: 5px; font-weight: bold;">Edit</button>
                 <button onclick="deleteAccountReq('${uname}')" style="background: #e53935; color: white; border: none; border-radius: 4px; cursor: pointer; padding: 6px 12px; font-weight: bold;">Delete</button>`;
            tr.innerHTML = `<td style="padding: 12px; font-weight: bold;">${uname} ${acc.isAdmin ? '👑' : ''}</td><td style="padding: 12px;">${acc.name}</td><td style="padding: 12px; color: #aaa;">${acc.rooms}</td><td style="padding: 12px; text-align: right;">${actionsHTML}</td>`;
            tbody.appendChild(tr);
        }
    });

    socket.on('updateCursor', (data) => {
        const { id, x, y } = data;
        if (!remoteCursors[id]) {
            const cursor = document.createElement('div'); cursor.className = 'remote-cursor';
            cursor.style.backgroundColor = `hsl(${Math.random() * 360}, 100%, 50%)`;
            board.appendChild(cursor); remoteCursors[id] = cursor;
        }
        const cursor = remoteCursors[id];
        cursor.style.left = x + 'px'; cursor.style.top = y + 'px';
    });

    socket.on('userDisconnected', (id) => { if (remoteCursors[id]) { remoteCursors[id].remove(); delete remoteCursors[id]; } });

    // --- FIX: SMART STATE RECOVERY ---
    socket.on('requestState', (data) => {
        const reqId = data.id || data;
        const reqRole = data.role || 'student';

        // Tutors always share state. Students ONLY share state if the Tutor refreshed and is asking for it!
        if (myRole === 'tutor' || reqRole === 'tutor') {
            const currentLevel = parseInt(document.body.getAttribute('data-current-level')) || 4;

            // Add a tiny random delay for students so they don't flood the server all at once
            const delay = myRole === 'student' ? Math.random() * 500 : 0;

            setTimeout(() => {
                socket.emit('sendState', {
                    targetId: reqId, state: {
                        level: currentLevel, background: currentBackground, drawings: localDrawings, boardSize: currentBoardSize,
                        tiles: Array.from(document.querySelectorAll('.tile[data-state="active"]')).map(t => ({
                            id: t.id, text: t.innerText, x: parseFloat(t.style.left), y: parseFloat(t.style.top), z: t.style.zIndex, minStart: t.getAttribute('data-min-start'), type: Array.from(original.classList).find(c => ['green', 'red', 'yellow', 'white', 'plus-tile'].includes(c)) || 'white',
                            isWide: t.classList.contains('wide'), isBlind: t.classList.contains('blind')
                        }))
                    }
                });
            }, delay);
        }
    });

    socket.on('sendState', (data) => {
        const s = data.state;
        if (s.boardSize) applyBoardSize(s.boardSize, false);
        if (s.level) applyStartLevel(s.level);
        if (s.background) drawGraphicOrganizer(s.background, false);

        // Clear canvas before applying state to prevent bold/overlapping lines
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        localDrawings = [];

        if (s.drawings) {
            s.drawings.forEach(d => renderLine(d));
            localDrawings = s.drawings;
        }

        s.tiles.forEach(t => {
            // FIX: Universal Z-Index tracking
            if (t.z > zIndexCounter) zIndexCounter = t.z;

            let el = document.getElementById(t.id);
            if (!el && t.id.startsWith('dup-')) {
                createStandardTile({ id: t.id, text: t.text, x: t.x, y: t.y, zIndex: t.z, minStart: t.minStart, type: t.type, isWide: t.isWide });
                el = document.getElementById(t.id);
            } else if (el) { updateTilePosition(el, t.x, t.y, t.z); }
            if (el && t.isBlind) el.classList.add('blind');
        });
    });

    socket.on('changeBackground', (bg) => drawGraphicOrganizer(bg, false));
    socket.on('changeBoardSize', (size) => applyBoardSize(size, false));
    socket.on('flipTile', (id) => document.getElementById(id)?.classList.toggle('blind'));
    socket.on('changeStartLevel', (l) => applyStartLevel(l));
    socket.on('resetBoard', () => performLocalReset());
    socket.on('resetSingleTile', (id) => { const el = document.getElementById(id); if (el) restoreTileToGrid(el); });

    socket.on('createTile', (d) => {
        if (d.zIndex > zIndexCounter) zIndexCounter = d.zIndex;
        createStandardTile(d);
    });

    socket.on('deleteTile', (id) => document.getElementById(id)?.remove());
    socket.on('playSound', (d) => playSound(d.key, false));

    socket.on('moveTile', (d) => {
        if (d.z > zIndexCounter) zIndexCounter = d.z;
        const el = document.getElementById(d.id);
        if (el && currentDragElement !== el) updateTilePosition(el, d.x, d.y, d.z);
    });

    socket.on('drawPath', (d) => { renderLine(d); localDrawings.push(d); });
    socket.on('clearDrawings', () => { if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); localDrawings = []; });

    setInterval(() => { if (socket && socket.connected) socket.emit('keepAlive'); }, 25000);
}

function applyPermissions(perms) {
    studentPerms = perms;
    const drawBtn = document.getElementById('btn-draw'), eraseBtn = document.getElementById('btn-erase'), resetBtn = document.getElementById('btn-reset'), trashBtn = document.getElementById('trash-can');

    if (myRole === 'student') {
        if (perms.move) {
            board.classList.remove('student-restricted-move');
            if (resetBtn) resetBtn.classList.remove('student-restricted'); if (trashBtn) trashBtn.classList.remove('student-restricted');
        } else {
            board.classList.add('student-restricted-move');
            if (resetBtn) resetBtn.classList.add('student-restricted'); if (trashBtn) trashBtn.classList.add('student-restricted');
        }
        if (perms.draw) { if (drawBtn) drawBtn.classList.remove('student-restricted'); } else { if (drawBtn) drawBtn.classList.add('student-restricted'); if (currentDrawMode === 'draw') setDrawMode(null); }
        if (perms.erase) { if (eraseBtn) eraseBtn.classList.remove('student-restricted'); } else { if (eraseBtn) eraseBtn.classList.add('student-restricted'); if (currentDrawMode === 'erase') setDrawMode(null); }
    } else if (myRole === 'tutor') {
        board.classList.remove('student-restricted-move');
        if (drawBtn) drawBtn.classList.remove('student-restricted'); if (eraseBtn) eraseBtn.classList.remove('student-restricted'); if (resetBtn) resetBtn.classList.remove('student-restricted'); if (trashBtn) trashBtn.classList.remove('student-restricted');
        const permMoveBox = document.getElementById('perm-move'), permDrawBox = document.getElementById('perm-draw'), permEraseBox = document.getElementById('perm-erase');
        if (permMoveBox) permMoveBox.checked = perms.move; if (permDrawBox) permDrawBox.checked = perms.draw; if (permEraseBox) permEraseBox.checked = perms.erase;
    }
}

function emitPermissions() { if (myRole !== 'tutor') return; socket.emit('updatePermissions', { move: document.getElementById('perm-move').checked, draw: document.getElementById('perm-draw').checked, erase: document.getElementById('perm-erase').checked }); }
function attemptJoinFromModal() { const room = document.getElementById('modal-input').value.trim().toLowerCase(); const username = document.getElementById('modal-username').value.trim(); const password = document.getElementById('modal-password').value; if (room) { document.getElementById('room-display').innerText = room; socket.emit('joinRoom', { room: room, username: username, password: password }); } }

function openAdminModal() { document.getElementById('admin-modal').style.display = 'flex'; document.getElementById('settings-menu').style.display = 'none'; socket.emit('requestAccounts'); }
function closeAdminModal() { document.getElementById('admin-modal').style.display = 'none'; hideAdminForm(); }
function showAdminForm() { document.getElementById('admin-form-container').style.display = 'block'; document.getElementById('admin-form-title').innerText = 'Create New Account'; document.getElementById('admin-edit-target').value = ''; const uInput = document.getElementById('admin-username'); uInput.value = ''; uInput.disabled = false; uInput.style.opacity = '1'; document.getElementById('admin-name').value = ''; document.getElementById('admin-password').value = ''; document.getElementById('admin-password').placeholder = "Password"; document.getElementById('admin-rooms').value = ''; }
function hideAdminForm() { document.getElementById('admin-form-container').style.display = 'none'; }
function editAccountInit(uname, name, rooms) { showAdminForm(); document.getElementById('admin-form-title').innerText = 'Edit Account: ' + uname; document.getElementById('admin-edit-target').value = uname; const uInput = document.getElementById('admin-username'); uInput.value = uname; uInput.disabled = true; uInput.style.opacity = '0.5'; document.getElementById('admin-name').value = name; document.getElementById('admin-password').value = ''; document.getElementById('admin-password').placeholder = "Leave blank to keep current password"; document.getElementById('admin-rooms').value = rooms; }

function submitAdminForm() {
    const target = document.getElementById('admin-edit-target').value; const uname = document.getElementById('admin-username').value.trim(); const name = document.getElementById('admin-name').value.trim(); const pass = document.getElementById('admin-password').value; const rooms = document.getElementById('admin-rooms').value.trim();
    if (!uname || !name || !rooms) return alert("Username, Name, and Rooms are required.");
    if (target) { socket.emit('editAccount', { username: target, name: name, password: pass, rooms: rooms }); } else { if (!pass) return alert("Password is required for new accounts."); socket.emit('createAccount', { username: uname, name: name, password: pass, rooms: rooms }); }
}
function deleteAccountReq(uname) { if (confirm(`Are you absolutely sure you want to delete the account for ${uname}?`)) { socket.emit('deleteAccount', uname); } }

function requestPasswordChange() {
    if (myRole !== 'tutor') return;
    const currentPw = document.getElementById('current-password').value; const newPw = document.getElementById('new-tutor-password').value;
    if (!currentPw || !newPw) return alert("Please fill in both password fields.");
    if (newPw.length < 4) return alert("Your new password must be at least 4 characters long.");
    socket.emit('changePassword', { currentPassword: currentPw, newPassword: newPw });
    document.getElementById('current-password').value = ''; document.getElementById('new-tutor-password').value = ''; toggleSettingsMenu();
}

function takeSnapshot() {
    if (myRole !== 'tutor') return; const boardEl = document.getElementById('board');
    document.querySelectorAll('.remote-cursor').forEach(c => c.style.display = 'none');
    html2canvas(boardEl, { backgroundColor: window.getComputedStyle(document.body).backgroundColor, scrollY: -window.scrollY }).then(canvas => {
        const link = document.createElement('a'); link.download = `Blosser_Session_${new Date().toLocaleDateString().replace(/\//g, '-')}.png`; link.href = canvas.toDataURL(); link.click();
        document.querySelectorAll('.remote-cursor').forEach(c => c.style.display = 'block');
    });
}

function emitBackgroundChange(bgType) { if (myRole !== 'tutor') return; drawGraphicOrganizer(bgType, true); }
function drawGraphicOrganizer(type, shouldEmit) {
    currentBackground = type; const bgLayer = document.getElementById('board-bg'); bgLayer.innerHTML = '';
    const select = document.getElementById('bg-select'); if (select && select.value !== type) select.value = type;
    const isDark = document.body.classList.contains('bg-white') ? false : true; const strokeColor = isDark ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.4)';

    if (type === 'elkonin3') { bgLayer.innerHTML = `<div style="display:flex; justify-content:center; align-items:center; height:100%; padding-bottom: 100px;"><div style="width: 140px; height: 140px; border: 5px solid ${strokeColor}; border-right: none;"></div><div style="width: 140px; height: 140px; border: 5px solid ${strokeColor}; border-right: none;"></div><div style="width: 140px; height: 140px; border: 5px solid ${strokeColor};"></div></div>`; }
    else if (type === 'elkonin4') { bgLayer.innerHTML = `<div style="display:flex; justify-content:center; align-items:center; height:100%; padding-bottom: 100px;"><div style="width: 140px; height: 140px; border: 5px solid ${strokeColor}; border-right: none;"></div><div style="width: 140px; height: 140px; border: 5px solid ${strokeColor}; border-right: none;"></div><div style="width: 140px; height: 140px; border: 5px solid ${strokeColor}; border-right: none;"></div><div style="width: 140px; height: 140px; border: 5px solid ${strokeColor};"></div></div>`; }
    else if (type === 'tchart') { bgLayer.innerHTML = `<div style="position:absolute; top: 180px; left: 10%; width: 80%; height: 80%;"><div style="width: 100%; border-top: 5px solid ${strokeColor};"></div><div style="position:absolute; top: 0; left: 50%; width: 5px; height: 100%; background: ${strokeColor};"></div></div>`; }
    if (shouldEmit && socket) socket.emit('changeBackground', type);
}

function spawnCustomTile() {
    if (myRole !== 'tutor') return;
    const text = document.getElementById('custom-tile-text').value.trim(); if (!text) return;
    const color = document.getElementById('custom-tile-color').value; const bRect = board.getBoundingClientRect();
    const tileData = { id: 'dup-' + Math.random().toString(36).substr(2, 9), text: text, type: color, isWide: text.length > 3, x: board.scrollLeft + (bRect.width / 2) - 25, y: board.scrollTop + (bRect.height / 2) - 25, zIndex: ++zIndexCounter, minStart: parseInt(document.body.getAttribute('data-current-level')) || 4 };
    createStandardTile(tileData); if (socket) socket.emit('createTile', tileData);
    document.getElementById('custom-tile-text').value = ''; toggleSettingsMenu();
}

function saveCurrentLayout() {
    if (myRole !== 'tutor') return; const name = document.getElementById('layout-name').value.trim(); if (!name) return alert("Enter a layout name first!");
    const activeTiles = Array.from(document.querySelectorAll('.tile[data-state="active"]')).map(t => ({ text: t.innerText, type: Array.from(t.classList).find(c => ['green', 'red', 'yellow', 'white', 'plus-tile'].includes(c)) || 'white', isWide: t.classList.contains('wide'), x: parseFloat(t.style.left), y: parseFloat(t.style.top), z: t.style.zIndex, minStart: t.getAttribute('data-min-start'), isBlind: t.classList.contains('blind') }));
    let layouts = JSON.parse(localStorage.getItem('savedLayouts') || '{}'); layouts[name] = activeTiles; localStorage.setItem('savedLayouts', JSON.stringify(layouts));
    refreshLayoutDropdown(); document.getElementById('layout-name').value = ''; alert(`Layout "${name}" saved!`);
}

function refreshLayoutDropdown() {
    const select = document.getElementById('layout-select'); if (!select) return; select.innerHTML = ''; let layouts = JSON.parse(localStorage.getItem('savedLayouts') || '{}');
    for (let name in layouts) { let opt = document.createElement('option'); opt.value = name; opt.innerText = name; select.appendChild(opt); }
}

function loadSelectedLayout() {
    if (myRole !== 'tutor') return; const name = document.getElementById('layout-select').value; if (!name) return;
    let layouts = JSON.parse(localStorage.getItem('savedLayouts') || '{}'); let tiles = layouts[name]; if (!tiles) return;
    requestResetBoard();
    setTimeout(() => {
        tiles.forEach(t => {
            const tileData = { id: 'dup-' + Math.random().toString(36).substr(2, 9), text: t.text, type: t.type, isWide: t.isWide, x: t.x, y: t.y, zIndex: t.z || ++zIndexCounter, minStart: t.minStart };
            createStandardTile(tileData); if (t.isBlind) document.getElementById(tileData.id).classList.add('blind'); if (socket) socket.emit('createTile', tileData);
        });
    }, 150);
    toggleSettingsMenu();
}

function deleteSelectedLayout() {
    if (myRole !== 'tutor') return; const name = document.getElementById('layout-select').value; if (!name) return;
    if (confirm(`Are you sure you want to delete the layout "${name}"?`)) { let layouts = JSON.parse(localStorage.getItem('savedLayouts') || '{}'); delete layouts[name]; localStorage.setItem('savedLayouts', JSON.stringify(layouts)); refreshLayoutDropdown(); }
}

function attachTileListeners(el) {
    let lastTapTime = 0;
    function handleTileStart(e) {
        if (e.type === 'mousedown' && e.button !== 0) return;
        if (myRole === 'student' && !studentPerms.move) return;

        if (e.type === 'touchstart') {
            e.preventDefault(); const now = Date.now();
            if (now - lastTapTime < 300) { playSound(el.getAttribute('data-sound') || el.innerText, true); }
            lastTapTime = now;
        }

        cancelAnimationFrame(animationFrameId);
        currentDragElement = el; isDragging = false;

        const canUseTrash = myRole === 'tutor' || (myRole === 'student' && studentPerms.move);
        if (canUseTrash) document.body.classList.add('is-dragging-tile');

        const rect = el.getBoundingClientRect(); const point = getEventPoint(e);
        dragOffset = { x: point.x - rect.left, y: point.y - rect.top }; lastPos = { x: point.x, y: point.y }; lastTime = Date.now();
        zIndexCounter++; el.style.zIndex = zIndexCounter;

        longPressTimer = setTimeout(() => { if (currentDragElement === el && !isDragging) { duplicateTile(el); currentDragElement = null; document.body.classList.remove('is-dragging-tile'); } }, 500);
    }
    el.addEventListener('mousedown', handleTileStart);
    el.addEventListener('touchstart', handleTileStart, { passive: false });
    el.addEventListener('dblclick', () => { if (myRole === 'student' && !studentPerms.move) return; playSound(el.getAttribute('data-sound') || el.innerText, true); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (myRole === 'student' && !studentPerms.move) return; el.classList.toggle('blind'); if (socket) socket.emit('flipTile', el.id); });
}

function onGlobalMove(e) {
    const point = getEventPoint(e); const bRect = board.getBoundingClientRect();
    const boardX = (point.x - bRect.left + board.scrollLeft); const boardY = (point.y - bRect.top + board.scrollTop);

    const now = Date.now();

    // FIX: Throttle the cursor socket emit to 30 FPS to prevent server flooding
    if (now - lastCursorEmit > 30) {
        if (socket && socket.connected) { socket.emit('mouseMove', { x: boardX, y: boardY }); }
        lastCursorEmit = now;
    }

    if (!currentDragElement) return;
    if (e.type === 'touchmove') e.preventDefault();

    isDragging = true;
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

    const canUseTrash = myRole === 'tutor' || (myRole === 'student' && studentPerms.move);
    if (canUseTrash) {
        const trashRect = document.getElementById('trash-can').getBoundingClientRect(); const tRect = currentDragElement.getBoundingClientRect();
        const isOverlapping = !(tRect.right < trashRect.left || tRect.left > trashRect.right || tRect.bottom < trashRect.top || tRect.top > trashRect.bottom);
        if (isOverlapping) document.body.classList.add('trash-hover'); else document.body.classList.remove('trash-hover');
    }

    const dt = now - lastTime;
    if (dt > 0) { velocity.x = (point.x - lastPos.x) / (dt / 16); velocity.y = (point.y - lastPos.y) / (dt / 16); }
    lastPos = { x: point.x, y: point.y }; lastTime = now;

    let x = boardX - dragOffset.x; let y = boardY - dragOffset.y;
    y = Math.max(0, y);

    // Always update locally immediately for smooth visuals
    updateTilePosition(currentDragElement, x, y, zIndexCounter);

    // FIX: Throttle tile movement socket emits to ~30 FPS
    if (now - lastMoveEmit > 30) {
        socket.emit('moveTile', { id: currentDragElement.id, x, y, z: zIndexCounter });
        lastMoveEmit = now;
    }
}

function onGlobalEnd(e) {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    if (currentDragElement) {
        const trashRect = document.getElementById('trash-can').getBoundingClientRect(); const tRect = currentDragElement.getBoundingClientRect();
        const isOverlapping = !(tRect.right < trashRect.left || tRect.left > trashRect.right || tRect.bottom < trashRect.top || tRect.top > trashRect.bottom);
        document.body.classList.remove('is-dragging-tile', 'trash-hover');

        const canUseTrash = myRole === 'tutor' || (myRole === 'student' && studentPerms.move);
        if (canUseTrash && isOverlapping) { handleToss(currentDragElement); currentDragElement = null; isDragging = false; return; }

        let snapped = false; const myRect = currentDragElement.getBoundingClientRect(); const activeTiles = document.querySelectorAll('.tile[data-state="active"]');
        for (let target of activeTiles) {
            if (target === currentDragElement) continue;
            const targetRect = target.getBoundingClientRect();
            if (Math.abs(myRect.left - targetRect.right) < 25 && Math.abs(myRect.top - targetRect.top) < 25) {
                let newX = parseFloat(target.style.left) + targetRect.width + 2; let newY = parseFloat(target.style.top);
                updateTilePosition(currentDragElement, newX, newY, zIndexCounter);
                socket.emit('moveTile', { id: currentDragElement.id, x: newX, y: newY, z: zIndexCounter });
                snapped = true; break;
            }
        }

        // FIX: Ensure the final position is always broadcasted exactly, even if packets drop
        if (!snapped) {
            startInertia(currentDragElement);
        } else {
            socket.emit('moveTile', { id: currentDragElement.id, x: parseFloat(currentDragElement.style.left), y: parseFloat(currentDragElement.style.top), z: zIndexCounter });
        }
    }
    currentDragElement = null; isDragging = false;
}

function startInertia(el) {
    if (Math.abs(velocity.x) < stopThreshold && Math.abs(velocity.y) < stopThreshold) {
        socket.emit('moveTile', { id: el.id, x: parseFloat(el.style.left), y: parseFloat(el.style.top), z: el.style.zIndex }); return;
    }

    let lastInertiaEmit = 0;
    function step(timestamp) {
        if (currentDragElement === el) return;
        velocity.x *= friction; velocity.y *= friction;
        let nextX = parseFloat(el.style.left) + velocity.x; let nextY = parseFloat(el.style.top) + velocity.y;
        const rect = el.getBoundingClientRect();
        if (nextX < 0) { nextX = 0; velocity.x = 0; } if (nextY < 0) { nextY = 0; velocity.y = 0; }
        if (nextY > board.scrollHeight - rect.height) { nextY = board.scrollHeight - rect.height; velocity.y = 0; }
        if (nextX > board.clientWidth - rect.width) { handleToss(el); return; }

        updateTilePosition(el, nextX, nextY, el.style.zIndex);

        // FIX: Throttle inertia socket emits so they don't break the server
        if (timestamp - lastInertiaEmit > 35) {
            socket.emit('moveTile', { id: el.id, x: nextX, y: nextY, z: el.style.zIndex });
            lastInertiaEmit = timestamp;
        }

        if (Math.abs(velocity.x) > stopThreshold || Math.abs(velocity.y) > stopThreshold) {
            animationFrameId = requestAnimationFrame(step);
        } else {
            // Emits final resting place
            socket.emit('moveTile', { id: el.id, x: nextX, y: nextY, z: el.style.zIndex });
        }
    }
    animationFrameId = requestAnimationFrame(step);
}

function duplicateTile(original) {
    const rect = original.getBoundingClientRect(); const bRect = board.getBoundingClientRect(); const nextX = (rect.left - bRect.left + board.scrollLeft) + rect.width + 5; const inheritLevel = original.getAttribute('data-min-start') || 4;
    const tileData = { id: 'dup-' + Math.random().toString(36).substr(2, 9), text: original.innerText, type: Array.from(original.classList).find(c => ['green', 'red', 'yellow', 'white', 'plus-tile'].includes(c)) || 'white', isWide: original.classList.contains('wide'), x: nextX, y: (rect.top - bRect.top + board.scrollTop), zIndex: ++zIndexCounter, minStart: inheritLevel };
    createStandardTile(tileData); if (socket) socket.emit('createTile', tileData);
}

function handleToss(el) { if (el.id.startsWith('dup-')) { el.remove(); if (socket) socket.emit('deleteTile', el.id); } else { restoreTileToGrid(el); if (socket) socket.emit('resetSingleTile', el.id); } }
function updateTilePosition(el, x, y, z) { if (el.getAttribute('data-state') !== 'active') liftTileFromGrid(el); el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.zIndex = z; }
function liftTileFromGrid(el) {
    const rect = el.getBoundingClientRect(); const boardRect = board.getBoundingClientRect(); const placeholder = document.createElement('div'); placeholder.className = 'tile-placeholder' + (el.classList.contains('wide') ? ' wide' : '');
    if (el.style.gridArea) { placeholder.style.gridArea = el.style.gridArea; }
    if (el.parentNode) el.parentNode.insertBefore(placeholder, el); el._placeholder = placeholder; el.style.position = 'absolute'; el.style.left = (rect.left - boardRect.left + board.scrollLeft) + 'px'; el.style.top = (rect.top - boardRect.top + board.scrollTop) + 'px'; el.setAttribute('data-state', 'active'); board.appendChild(el);
}
function restoreTileToGrid(el) {
    if (el._placeholder && el._placeholder.parentNode) { el.style.position = ''; el.style.left = ''; el.style.top = ''; el.setAttribute('data-state', 'idle'); el._placeholder.parentNode.replaceChild(el, el._placeholder); el._placeholder = null; }
}

function playSound(key, shouldEmit) { new Audio(`/audio/${key.trim().toLowerCase()}.mp3`).play().catch(() => { }); if (shouldEmit && socket) socket.emit('playSound', { key: key }); }

function setupCanvas() {
    canvas = document.getElementById('drawing-layer'); ctx = canvas.getContext('2d');
    function handleDrawStart(e) {
        if (!currentDrawMode) return;
        if (myRole === 'student') { if (currentDrawMode === 'draw' && !studentPerms.draw) return; if (currentDrawMode === 'erase' && !studentPerms.erase) return; }
        if (e.type === 'touchstart') e.preventDefault();
        isDrawing = true; lastDrawPos = getCoords(e);
    }
    function handleDrawMove(e) {
        if (!isDrawing || !currentDrawMode) return;
        if (e.type === 'touchmove') e.preventDefault();
        const curr = getCoords(e); const data = { x0: lastDrawPos.x, y0: lastDrawPos.y, x1: curr.x, y1: curr.y, mode: currentDrawMode, width: currentLineWidth };
        renderLine(data); localDrawings.push(data); socket.emit('drawPath', data); lastDrawPos = curr;
    }
    canvas.addEventListener('mousedown', handleDrawStart); canvas.addEventListener('touchstart', handleDrawStart, { passive: false });
    canvas.addEventListener('mousemove', handleDrawMove); canvas.addEventListener('touchmove', handleDrawMove, { passive: false });
    window.addEventListener('mouseup', () => isDrawing = false); window.addEventListener('touchend', () => isDrawing = false); window.addEventListener('touchcancel', () => isDrawing = false);
}

function getCoords(e) { const r = canvas.getBoundingClientRect(); const point = getEventPoint(e); return { x: point.x - r.left, y: point.y - r.top }; }

function renderLine(d) {
    if (!ctx) return; ctx.beginPath(); ctx.moveTo(d.x0, d.y0); ctx.lineTo(d.x1, d.y1); ctx.lineCap = 'round';
    if (d.mode === 'erase') { ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth = 20; } else { ctx.globalCompositeOperation = 'source-over'; ctx.lineWidth = d.width; ctx.strokeStyle = document.body.classList.contains('bg-white') ? '#000' : '#fff'; } ctx.stroke();
}

function requestResetBoard() { if (myRole === 'student' && !studentPerms.move) return; performLocalReset(); if (socket) socket.emit('resetBoard'); }
function performLocalReset() { document.querySelectorAll('.tile[data-state="active"]').forEach(tile => { if (tile.id.startsWith('dup-')) tile.remove(); else restoreTileToGrid(tile); }); if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); localDrawings = []; drawGraphicOrganizer('none', true); }
function toggleSettingsMenu() { const m = document.getElementById('settings-menu'); m.style.display = (m.style.display === 'block') ? 'none' : 'block'; }
function restoreSettings() { changeFont(localStorage.getItem('userFont') || 'font-opendyslexic'); changeTheme(localStorage.getItem('userTheme') || 'bg-black'); const savedLevel = localStorage.getItem('startLevel'); if (savedLevel) applyStartLevel(savedLevel); }
function changeTheme(c) { document.body.classList.remove('bg-black', 'bg-white', 'bg-purple', 'bg-dark-blue'); document.body.classList.add(c); localStorage.setItem('userTheme', c); const themeSelect = document.getElementById('theme-select'); if (themeSelect) themeSelect.value = c; drawGraphicOrganizer(currentBackground, false); }
function changeStartLevel(l) { if (myRole !== 'tutor') return; applyStartLevel(l); if (socket) socket.emit('changeStartLevel', l); }
function applyStartLevel(l) { const level = parseInt(l); document.body.setAttribute('data-current-level', level); localStorage.setItem('startLevel', level); document.querySelectorAll('.tool-btn[id^="btn-start-"]').forEach(btn => btn.classList.toggle('active', btn.id === `btn-start-${level}`)); }
function changeFont(f) { document.body.classList.remove('font-opendyslexic', 'font-poppins', 'font-comic', 'font-serif'); document.body.classList.add(f); localStorage.setItem('userFont', f); }
function setDrawMode(m) {
    currentDrawMode = (currentDrawMode === m) ? null : m; document.body.classList.toggle('drawing-mode-active', !!currentDrawMode);
    const d = document.getElementById('btn-draw'), e = document.getElementById('btn-erase');
    if (d) d.classList.toggle('active', currentDrawMode === 'draw'); if (e) e.classList.toggle('active', currentDrawMode === 'erase');
    if (canvas) { if (currentDrawMode) { canvas.style.position = 'absolute'; canvas.style.top = '0'; canvas.style.left = '0'; canvas.style.zIndex = '999999'; canvas.style.pointerEvents = 'auto'; } else { canvas.style.zIndex = '2'; canvas.style.pointerEvents = 'none'; } }
}
function updatePenSize(s) { currentLineWidth = s; document.querySelectorAll('.size-btn').forEach(btn => btn.classList.toggle('selected-size', btn.id === `size-${s}`)); }
function exitRoom() { window.location.href = '/'; }
function copyRoomLink() { const room = document.getElementById('room-display').innerText; if (room && room !== '...') { const link = window.location.origin + '/?room=' + encodeURIComponent(room) + '&student=true'; navigator.clipboard.writeText(link); alert("Student Auto-Join Link Copied!\n\n" + link); } else { alert("Please join a room first!"); } }
function attemptJoinFromUrl() { const urlParams = new URLSearchParams(window.location.search); const room = urlParams.get('room'); const isStudent = urlParams.get('student'); if (room) { document.getElementById('modal-input').value = room; if (isStudent === 'true') { document.getElementById('room-display').innerText = room; socket.emit('joinRoom', { room: room.toLowerCase(), username: '', password: '' }); } } }
function createStandardTile(d) {
    const el = document.createElement('div'); const tileType = d.type || 'white';
    el.className = `tile ${tileType} ${d.isWide ? 'wide' : ''}`; el.className = `tile ${tileType} ${d.isWide ? 'wide' : ''}`; el.innerText = d.text; el.id = d.id; el.style.position = 'absolute'; el.style.left = d.x + 'px'; el.style.top = d.y + 'px'; el.style.zIndex = d.zIndex; el.setAttribute('data-state', 'active'); let level = d.minStart; if (!level) { if (['a', 'e', 'i', 'o', 'u'].includes(d.text.trim())) level = 1; else level = 4; } el.setAttribute('data-min-start', level); board.appendChild(el); attachTileListeners(el); }
function clearLocalDrawings() { if (myRole !== 'tutor') return; if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); localDrawings = []; socket.emit('clearDrawings'); }
function emitBoardSize(size) { if (myRole !== 'tutor') return; applyBoardSize(size, true); }
function applyBoardSize(size, shouldEmit) {
    currentBoardSize = size;
    localStorage.setItem('userBoardSize', size);

    let w = 1920, h = 1035;
    if (size === 'medium') { w = 1600; h = 900; }
    else if (size === 'small') { w = 1280; h = 720; }
    else if (size === 'xsmall') { w = 1024; h = 576; }

    // THE FIX: We apply the width to the ROOT so the background box sees it
    document.documentElement.style.setProperty('--board-width', w + 'px');
    document.documentElement.style.setProperty('--board-height', h + 'px');

    if (canvas) {
        // THE FIX: Width stays full screen
        canvas.width = window.innerWidth;

        // THE FIX: Instead of a fixed number, we tell the canvas to measure 
        // the total height of the entire webpage including your 800px storage space.
        // We add a small 200px buffer just to be safe.
        const totalHeight = document.documentElement.scrollHeight || (h + 2000);
        canvas.height = totalHeight + 200;

        // Ensure the canvas stays at the very top and covers everything
        canvas.style.width = "100%";
        canvas.style.position = "absolute";
        canvas.style.top = "0";
        canvas.style.left = "0";

        if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            localDrawings.forEach(d => renderLine(d));
        }
    }

    const select = document.getElementById('size-select');
    if (select && select.value !== size) select.value = size;
    if (shouldEmit && socket) socket.emit('changeBoardSize', size);
}