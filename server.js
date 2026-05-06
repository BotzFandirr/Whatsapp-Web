const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Import mesin WhatsApp dari folder src
const {
    connectToWhatsApp,
    deleteSession,
    initSessions,
    checkSessionStatus,
    sendWhatsappMessage,
    getGroups
} = require('./src/whatsapp');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public')); // Pastikan folder 'public' berisi index.html, register.html, admin.html & dashboard.html

const dbPath = path.join(__dirname, 'database.json');
const FREE_DAILY_MESSAGE_LIMIT = 5;
const DEFAULT_DB = {
    users: [
        {
            id: 'admin',
            username: 'admin',
            password: 'admin123',
            role: 'admin',
            plan: 'premium',
            premium_expires_at: '2099-12-31',
            created_at: new Date().toISOString(),
            message_usage: {}
        }
    ]
};

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function normalizePhone(phone) {
    return String(phone || '').replace(/\D/g, '');
}

function normalizeDatabase(rawDb) {
    if (rawDb && Array.isArray(rawDb.users)) {
        return {
            ...DEFAULT_DB,
            ...rawDb,
            users: rawDb.users.map((user) => ({
                role: 'user',
                plan: 'free',
                premium_expires_at: '',
                created_at: new Date().toISOString(),
                message_usage: {},
                ...user,
                username: String(user.username || '').trim().toLowerCase()
            }))
        };
    }

    const migratedUsers = Object.entries(rawDb || {}).map(([key, user]) => ({
        id: crypto.randomUUID(),
        username: key.trim().toLowerCase(),
        password: key,
        role: 'user',
        plan: user.expired_at && new Date(user.expired_at).getTime() >= Date.now() ? 'premium' : 'free',
        premium_expires_at: user.expired_at || '',
        created_at: new Date().toISOString(),
        message_usage: {}
    }));

    return {
        ...DEFAULT_DB,
        users: [...DEFAULT_DB.users, ...migratedUsers]
    };
}

function getDatabase() {
    if (!fs.existsSync(dbPath)) {
        fs.writeFileSync(dbPath, JSON.stringify(DEFAULT_DB, null, 2));
    }

    const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8') || '{}');
    const normalized = normalizeDatabase(parsed);

    // Database lama berbasis access-key otomatis dimigrasikan ke format users[].
    if (!Array.isArray(parsed.users)) {
        saveDatabase(normalized);
    }

    return normalized;
}

function saveDatabase(dbObj) {
    fs.writeFileSync(dbPath, JSON.stringify(dbObj, null, 2));
}

function sanitizeUser(user) {
    if (!user) return null;
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        plan: getEffectivePlan(user),
        premium_expires_at: user.premium_expires_at || '',
        created_at: user.created_at,
        message_usage: user.message_usage || {}
    };
}

function getEffectivePlan(user) {
    if (user.role === 'admin') return 'premium';
    if (user.plan === 'premium' && user.premium_expires_at) {
        const expiresAt = new Date(`${user.premium_expires_at}T23:59:59.999Z`).getTime();
        if (Date.now() <= expiresAt) return 'premium';
    }
    return 'free';
}

function findUserByUsername(dbObj, username) {
    const cleanUsername = String(username || '').trim().toLowerCase();
    return dbObj.users.find((user) => user.username === cleanUsername);
}

function authenticateUser(key) {
    const dbObj = getDatabase();
    const user = dbObj.users.find((item) => item.id === key);
    return { dbObj, user };
}

function requireUser(req, res) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '') || req.body?.authKey || req.query?.authKey;
    const { dbObj, user } = authenticateUser(token);

    if (!user) {
        res.status(401).json({ success: false, message: 'Sesi tidak valid. Silakan login ulang.' });
        return null;
    }

    return { dbObj, user };
}

function requireAdmin(req, res) {
    const context = requireUser(req, res);
    if (!context) return null;

    if (context.user.role !== 'admin') {
        res.status(403).json({ success: false, message: 'Akses admin diperlukan.' });
        return null;
    }

    return context;
}

app.post('/api/register', (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (username.length < 3) {
        return res.status(400).json({ success: false, message: 'Username minimal 3 karakter.' });
    }

    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password minimal 6 karakter.' });
    }

    const dbObj = getDatabase();
    if (findUserByUsername(dbObj, username)) {
        return res.status(409).json({ success: false, message: 'Username sudah terdaftar.' });
    }

    const user = {
        id: crypto.randomUUID(),
        username,
        password,
        role: 'user',
        plan: 'free',
        premium_expires_at: '',
        created_at: new Date().toISOString(),
        message_usage: {}
    };

    dbObj.users.push(user);
    saveDatabase(dbObj);

    res.status(201).json({ success: true, message: 'Pendaftaran berhasil. Silakan login.', user: sanitizeUser(user) });
});

app.post('/api/login', (req, res) => {
    const username = String(req.body.username || req.body.key || '').trim().toLowerCase();
    const password = String(req.body.password || req.body.key || '');
    const dbObj = getDatabase();
    const user = findUserByUsername(dbObj, username);

    if (!user || user.password !== password) {
        return res.status(401).json({ success: false, message: 'Username atau password salah.' });
    }

    res.json({
        success: true,
        message: 'Login berhasil!',
        authKey: user.id,
        user: sanitizeUser(user),
        limits: { freeDailyMessageLimit: FREE_DAILY_MESSAGE_LIMIT }
    });
});

app.get('/api/me', (req, res) => {
    const context = requireUser(req, res);
    if (!context) return;

    res.json({ success: true, user: sanitizeUser(context.user), limits: { freeDailyMessageLimit: FREE_DAILY_MESSAGE_LIMIT } });
});

app.post('/api/send-message', async (req, res) => {
    const context = requireUser(req, res);
    if (!context) return;

    const phoneNumber = normalizePhone(req.body.phoneNumber);
    const to = normalizePhone(req.body.to);
    const text = String(req.body.text || '').trim();

    if (!phoneNumber || !to || !text) {
        return res.status(400).json({ success: false, message: 'Nomor bot, nomor tujuan, dan pesan wajib diisi.' });
    }

    const plan = getEffectivePlan(context.user);
    const usageKey = todayKey();
    const messageUsage = context.user.message_usage || {};
    const todayUsage = messageUsage[usageKey] || 0;

    if (plan === 'free' && todayUsage >= FREE_DAILY_MESSAGE_LIMIT) {
        return res.status(403).json({
            success: false,
            message: `Limit pengguna free tercapai (${FREE_DAILY_MESSAGE_LIMIT} pesan per hari). Upgrade premium untuk membuka semua fitur.`
        });
    }

    try {
        await sendWhatsappMessage(phoneNumber, to, text);
        context.user.message_usage = { ...messageUsage, [usageKey]: todayUsage + 1 };
        saveDatabase(context.dbObj);
        res.json({ success: true, message: 'Pesan berhasil dikirim.', usage: context.user.message_usage[usageKey] });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.get('/api/groups', async (req, res) => {
    const context = requireUser(req, res);
    if (!context) return;

    if (getEffectivePlan(context.user) !== 'premium') {
        return res.status(403).json({ success: false, message: 'Daftar grup hanya tersedia untuk pengguna premium.' });
    }

    const phoneNumber = normalizePhone(req.query.phoneNumber);
    if (!phoneNumber) {
        return res.status(400).json({ success: false, message: 'Nomor bot wajib diisi.' });
    }

    try {
        const groups = await getGroups(phoneNumber);
        res.json({ success: true, groups });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/users', (req, res) => {
    const context = requireAdmin(req, res);
    if (!context) return;

    res.json({ success: true, users: context.dbObj.users.map(sanitizeUser) });
});

app.patch('/api/admin/users/:id', (req, res) => {
    const context = requireAdmin(req, res);
    if (!context) return;

    const user = context.dbObj.users.find((item) => item.id === req.params.id);
    if (!user) {
        return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });
    }

    if (typeof req.body.plan === 'string') {
        user.plan = req.body.plan === 'premium' ? 'premium' : 'free';
    }

    if (typeof req.body.premium_expires_at === 'string') {
        user.premium_expires_at = req.body.premium_expires_at;
    }

    if (typeof req.body.role === 'string' && context.user.id !== user.id) {
        user.role = req.body.role === 'admin' ? 'admin' : 'user';
    }

    saveDatabase(context.dbObj);
    res.json({ success: true, message: 'Pengguna berhasil diperbarui.', user: sanitizeUser(user) });
});

app.delete('/api/admin/users/:id', (req, res) => {
    const context = requireAdmin(req, res);
    if (!context) return;

    if (context.user.id === req.params.id) {
        return res.status(400).json({ success: false, message: 'Admin tidak dapat menghapus akun sendiri.' });
    }

    const beforeLength = context.dbObj.users.length;
    context.dbObj.users = context.dbObj.users.filter((item) => item.id !== req.params.id);

    if (context.dbObj.users.length === beforeLength) {
        return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' });
    }

    saveDatabase(context.dbObj);
    res.json({ success: true, message: 'Pengguna berhasil dihapus.' });
});

io.on('connection', (socket) => {
    console.log('Client Web terhubung dengan socket ID:', socket.id);

    function validateSocketPayload(payload) {
        const data = typeof payload === 'object' && payload !== null ? payload : { phoneNumber: payload };
        const { user } = authenticateUser(data.authKey);
        const phoneNumber = normalizePhone(data.phoneNumber);

        if (!user) {
            socket.emit('log', 'Sesi tidak valid. Silakan login ulang.');
            return null;
        }

        if (!phoneNumber) {
            socket.emit('log', 'Nomor WhatsApp wajib diisi manual.');
            return null;
        }

        return { user, phoneNumber };
    }

    socket.on('check_status', (payload) => {
        const context = validateSocketPayload(payload);
        if (!context) return;

        const isConnected = checkSessionStatus(context.phoneNumber);
        if (isConnected) {
            socket.emit('connected', 'Sesi sudah terhubung (Auto-Restore).');
            connectToWhatsApp(context.phoneNumber, socket);
        } else {
            socket.emit('disconnected', 'Menunggu koneksi. Silakan sambungkan perangkat.');
        }
    });

    socket.on('start_wa', async (payload) => {
        const context = validateSocketPayload(payload);
        if (!context) return;

        socket.emit('log', 'Memulai koneksi ke server WhatsApp...');
        connectToWhatsApp(context.phoneNumber, socket);
    });

    socket.on('delete_session', async (payload) => {
        const context = validateSocketPayload(payload);
        if (!context) return;

        await deleteSession(context.phoneNumber);
        socket.emit('log', 'Sesi untuk perangkat ini telah berhasil diputus.');
    });
});

const PORT = process.env.PORT || 4909;
server.listen(PORT, () => {
    console.log(`🚀 Server Web berjalan di http://localhost:${PORT}`);
    initSessions();
});
