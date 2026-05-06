const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

// Import mesin WhatsApp dari folder src
const { connectToWhatsApp, deleteSession, initSessions, checkSessionStatus } = require('./src/whatsapp');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public')); // Pastikan folder 'public' berisi index.html & dashboard.html

// Fungsi untuk membaca database.json
const dbPath = path.join(__dirname, 'database.json');
function getDatabase() {
    // Jika file belum ada, buat otomatis dengan contoh data
    if (!fs.existsSync(dbPath)) {
        fs.writeFileSync(dbPath, JSON.stringify({
            "FANDIRR-PRO-2026": {
                "phone": "6283155619441",
                "expired_at": "2026-12-31"
            }
        }, null, 2));
    }
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

// --- API ENDPOINT UNTUK LOGIN ---
app.post('/api/login', (req, res) => {
    const { key } = req.body;
    const dbObj = getDatabase();
    const user = dbObj[key]; // Mencari key di dalam database.json

    if (user) {
        // Mengubah format tanggal string (YYYY-MM-DD) menjadi timestamp
        const expiredDate = new Date(user.expired_at).getTime();
        
        if (Date.now() < expiredDate) {
            // Jika key masih berlaku (belum expired)
            res.json({ success: true, message: 'Login berhasil!', phone: user.phone });
        } else {
            // Jika sudah lewat batas tanggal
            res.status(401).json({ success: false, message: `Key sudah kedaluwarsa sejak ${user.expired_at}!` });
        }
    } else {
        res.status(401).json({ success: false, message: 'Key tidak terdaftar di sistem!' });
    }
});

// --- KONEKSI SOCKET.IO ---
io.on('connection', (socket) => {
    console.log('Client Web terhubung dengan socket ID:', socket.id);

    // 1. Event saat dashboard di-refresh (Mengecek apakah nomor sudah login WA)
    socket.on('check_status', (phoneNumber) => {
        if (!phoneNumber) return;
        
        // Cek status sesi dari memory yang ada di whatsapp.js
        const isConnected = checkSessionStatus(phoneNumber);
        
        if (isConnected) {
            socket.emit('connected', 'Sesi sudah terhubung (Auto-Restore).');
            // Tautkan socket web terbaru ke mesin WA agar log/pesan tetap bisa dikirim ke frontend
            connectToWhatsApp(phoneNumber, socket); 
        } else {
            socket.emit('disconnected', 'Menunggu koneksi. Silakan sambungkan perangkat.');
        }
    });

    // 2. Event untuk meminta kode pairing (Memulai koneksi baru)
    socket.on('start_wa', async (phoneNumber) => {
        if (!phoneNumber) return socket.emit('log', 'Nomor telepon kosong!');
        socket.emit('log', 'Memulai koneksi ke server WhatsApp...');
        
        connectToWhatsApp(phoneNumber, socket);
    });

    // 3. Event untuk menghapus sesi (Logout)
    socket.on('delete_session', async (phoneNumber) => {
        if (!phoneNumber) return;
        await deleteSession(phoneNumber);
        socket.emit('log', `Sesi untuk perangkat ini telah berhasil diputus.`);
    });
});

// --- JALANKAN SERVER ---
const PORT = process.env.PORT || 4909;
server.listen(PORT, () => {
    console.log(`🚀 Server Web berjalan di http://localhost:${PORT}`);
    
    // Jalankan ulang semua bot/nomor WA yang foldernya masih ada di folder ./sessions
    initSessions();
});
