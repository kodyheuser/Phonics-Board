require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose'); // NEW: Replaced 'fs' with Mongoose

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(express.static(path.join(__dirname, 'public')));

const socketUsers = {};
const activeRooms = {};
const roomCloseTimers = {};

// ==========================================
// NEW: MONGODB DATABASE SETUP
// ==========================================
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Define the structure for a Tutor Account
const tutorSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, required: true },
    hash: { type: String, required: true },
    allowedRooms: { type: [String], default: [] },
    isAdmin: { type: Boolean, default: false }
});

const Tutor = mongoose.model('Tutor', tutorSchema);

// Check for Master Admin on startup, create if missing
async function initializeAdmin() {
    try {
        const adminExists = await Tutor.findOne({ username: 'admin' });
        if (!adminExists) {
            console.log("Creating Master Admin account in database...");
            await Tutor.create({
                username: 'admin',
                name: 'Master Admin',
                hash: bcrypt.hashSync(process.env.PASS_ADMIN || "admin999", 10),
                allowedRooms: ["*"],
                isAdmin: true
            });
        }
    } catch (err) { console.error("Error initializing admin:", err); }
}
initializeAdmin();
// ==========================================


io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // FIX: Make this function 'async' so it can talk to the database
    socket.on('joinRoom', async (data) => {
        const { room, username, password } = data;
        let role = 'student';
        let tutorName = null;
        let isAdmin = false;

        if (username || password) {
            try {
                // Read from Database instead of local JSON
                const account = await Tutor.findOne({ username: username.toLowerCase() });

                if (account) {
                    const isPasswordValid = bcrypt.compareSync(password, account.hash);
                    if (isPasswordValid) {
                        if (account.allowedRooms.includes(room) || account.allowedRooms.includes("*")) {
                            role = 'tutor';
                            tutorName = account.name;
                            isAdmin = account.isAdmin || false;
                        } else {
                            socket.emit('joinError', `Access Denied. Tutor ${account.name} does not have access to room: "${room}"`);
                            return;
                        }
                    } else {
                        setTimeout(() => { socket.emit('joinError', 'Invalid Username or Password.'); }, 1500); return;
                    }
                } else {
                    setTimeout(() => { socket.emit('joinError', 'Invalid Username or Password.'); }, 1500); return;
                }
            } catch (err) {
                console.error(err);
                socket.emit('joinError', 'Database error during login.'); return;
            }
        }

        if (!activeRooms[room]) {
            if (role !== 'tutor') { socket.emit('joinError', 'Room does not exist. A Tutor must create it first.'); return; }
            activeRooms[room] = { perms: { move: false, draw: false, erase: false } };
        }

        if (role === 'tutor' && roomCloseTimers[room]) {
            clearTimeout(roomCloseTimers[room]);
            delete roomCloseTimers[room];
            console.log(`Tutor reconnected. Room ${room} closure cancelled.`);
        }

        socket.join(room);
        socketUsers[socket.id] = { room, role, name: tutorName, isAdmin: isAdmin, username: username ? username.toLowerCase() : null };
        console.log(`Socket ${socket.id} joined ${room} as ${role}`);

        socket.emit('joinSuccess', { role: role, name: tutorName, isAdmin: isAdmin, perms: activeRooms[room].perms });
        socket.to(room).emit('userJoined', { id: socket.id, role: role });
    });

    socket.on('changePassword', async (data) => {
        const user = socketUsers[socket.id];
        if (!user || user.role !== 'tutor' || !user.username) return;

        try {
            const account = await Tutor.findOne({ username: user.username });
            if (!account) return;

            const { currentPassword, newPassword } = data;
            const isPasswordValid = bcrypt.compareSync(currentPassword, account.hash);
            if (!isPasswordValid) return socket.emit('accountAlert', 'Error: Current password incorrect.');

            account.hash = bcrypt.hashSync(newPassword, 10);
            await account.save(); // Save to database
            socket.emit('accountAlert', 'Success! Your password has been changed.');
        } catch (e) { console.error(e); }
    });

    // --- ADMIN DASHBOARD (CRUD via MongoDB) ---
    socket.on('requestAccounts', async () => {
        const user = socketUsers[socket.id];
        if (!user || !user.isAdmin) return;

        try {
            const allAccounts = await Tutor.find({});
            const safeAccounts = {};
            allAccounts.forEach(acc => {
                safeAccounts[acc.username] = {
                    name: acc.name,
                    rooms: acc.allowedRooms.join(', '),
                    isAdmin: acc.isAdmin
                };
            });
            socket.emit('accountList', safeAccounts);
        } catch (e) { console.error(e); }
    });

    socket.on('createAccount', async (newAcc) => {
        const user = socketUsers[socket.id];
        if (!user || !user.isAdmin) return;
        const { username, name, password, rooms } = newAcc;
        const lowerUser = username.toLowerCase().trim();

        try {
            const exists = await Tutor.findOne({ username: lowerUser });
            if (exists) return socket.emit('accountAlert', 'Error: Username already exists!');

            await Tutor.create({
                username: lowerUser,
                name: name.trim(),
                hash: bcrypt.hashSync(password, 10),
                allowedRooms: rooms.split(',').map(r => r.trim().toLowerCase()),
                isAdmin: false
            });
            socket.emit('accountAlert', `Success! Account for ${name} created.`);
        } catch (e) { console.error(e); socket.emit('accountAlert', 'Database Error.'); }
    });

    socket.on('editAccount', async (data) => {
        const user = socketUsers[socket.id];
        if (!user || !user.isAdmin) return;
        const target = data.username.toLowerCase();

        try {
            const account = await Tutor.findOne({ username: target });
            if (!account) return;

            account.name = data.name.trim();
            account.allowedRooms = data.rooms.split(',').map(r => r.trim().toLowerCase());
            if (data.password && data.password.trim() !== '') {
                account.hash = bcrypt.hashSync(data.password, 10);
            }

            await account.save();
            socket.emit('accountAlert', `Success! Account ${target} updated.`);
        } catch (e) { console.error(e); }
    });

    socket.on('deleteAccount', async (uname) => {
        const user = socketUsers[socket.id];
        if (!user || !user.isAdmin) return;
        const target = uname.toLowerCase();

        try {
            const account = await Tutor.findOne({ username: target });
            if (!account) return;
            if (account.isAdmin) return socket.emit('accountAlert', 'Error: Cannot delete Master Admin accounts.');

            await Tutor.deleteOne({ username: target });
            socket.emit('accountAlert', `Success! Account ${target} deleted.`);
        } catch (e) { console.error(e); }
    });

    // ==========================================
    // THE REST OF YOUR REAL-TIME LOGIC REMAINS EXACTLY THE SAME
    // ==========================================

    socket.on('updatePermissions', (newPerms) => {
        const user = socketUsers[socket.id];
        if (user && user.role === 'tutor') { activeRooms[user.room].perms = newPerms; io.to(user.room).emit('permissionsUpdated', newPerms); }
    });

    socket.on('requestState', () => {
        const user = socketUsers[socket.id];
        if (user) socket.to(user.room).emit('requestState', { id: socket.id, role: user.role });
    });

    socket.on('sendState', (data) => { io.to(data.targetId).emit('sendState', data); });

    socket.on('mouseMove', (data) => { const user = socketUsers[socket.id]; if (user) socket.to(user.room).emit('updateCursor', { id: socket.id, x: data.x, y: data.y }); });
    socket.on('changeBackground', (bgType) => { const user = socketUsers[socket.id]; if (user && user.role === 'tutor') socket.to(user.room).emit('changeBackground', bgType); });
    socket.on('changeBoardSize', (size) => { const user = socketUsers[socket.id]; if (user && user.role === 'tutor') socket.to(user.room).emit('changeBoardSize', size); });
    socket.on('flipTile', (id) => { const user = socketUsers[socket.id]; if (!user) return; if (user.role === 'tutor' || activeRooms[user.room].perms.move) socket.to(user.room).emit('flipTile', id); });
    socket.on('moveTile', (data) => { const user = socketUsers[socket.id]; if (!user) return; if (user.role === 'tutor' || activeRooms[user.room].perms.move) socket.to(user.room).emit('moveTile', data); });
    socket.on('createTile', (data) => { const user = socketUsers[socket.id]; if (!user) return; if (user.role === 'tutor' || activeRooms[user.room].perms.move) socket.to(user.room).emit('createTile', data); });
    socket.on('deleteTile', (id) => { const user = socketUsers[socket.id]; if (!user) return; if (user.role === 'tutor' || activeRooms[user.room].perms.move) socket.to(user.room).emit('deleteTile', id); });
    socket.on('resetSingleTile', (id) => { const user = socketUsers[socket.id]; if (!user) return; if (user.role === 'tutor' || activeRooms[user.room].perms.move) socket.to(user.room).emit('resetSingleTile', id); });
    socket.on('resetBoard', () => { const user = socketUsers[socket.id]; if (!user) return; if (user.role === 'tutor' || activeRooms[user.room].perms.move) socket.to(user.room).emit('resetBoard'); });
    socket.on('changeStartLevel', (level) => { const user = socketUsers[socket.id]; if (user && user.role === 'tutor') socket.to(user.room).emit('changeStartLevel', level); });
    socket.on('playSound', (data) => { const user = socketUsers[socket.id]; if (user) socket.to(user.room).emit('playSound', data); });

    socket.on('drawPath', (data) => {
        const user = socketUsers[socket.id]; if (!user) return;
        const perms = activeRooms[user.room].perms;
        const isAllowed = user.role === 'tutor' || (data.mode === 'draw' && perms.draw) || (data.mode === 'erase' && perms.erase);
        if (isAllowed) socket.to(user.room).emit('drawPath', data);
    });

    socket.on('clearDrawings', () => { const user = socketUsers[socket.id]; if (user && user.role === 'tutor') socket.to(user.room).emit('clearDrawings'); });
    socket.on('keepAlive', () => { /* Keeps the connection active */ });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        const user = socketUsers[socket.id];

        if (user) {
            socket.to(user.room).emit('userDisconnected', socket.id);
            if (user.role === 'tutor') {
                console.log(`Tutor disconnected. Starting 60s grace period for room: ${user.room}`);
                roomCloseTimers[user.room] = setTimeout(() => {
                    console.log(`Grace period ended. Closing room: ${user.room}`);
                    socket.to(user.room).emit('roomClosed', 'The tutor has disconnected from the session.');
                    io.in(user.room).socketsLeave(user.room);
                    delete activeRooms[user.room];
                    delete roomCloseTimers[user.room];
                }, 60000);
            }
            delete socketUsers[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });