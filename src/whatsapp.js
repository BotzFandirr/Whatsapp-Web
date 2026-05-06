const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion, makeCacheableSignalKeyStore, getContentType } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const sessions = new Map();
// Variabel untuk melacak kapan terakhir kali kode diminta (Mencegah Spam/Banned)
const lastPairingRequest = new Map(); 

async function connectToWhatsApp(phoneNumber, socket = null) {

    // 1. SMART CHECK: Jika sesi sudah berjalan di memori
    if (sessions.has(phoneNumber)) {
        const session = sessions.get(phoneNumber);
        if (socket) {
            session.ws = socket; // Update socket dengan yang baru dari UI (jika di-refresh)
            if (session.status === 'connected') {
                socket.emit('connected', 'Sesi sudah aktif dan terhubung (Auto-Restore).');
            }
            socket.emit('log', 'Dashboard terhubung kembali ke mesin WhatsApp.');
        }
        return;
    }

    // 2. SETUP FOLDER
    const sessionDir = path.join(__dirname, `../sessions/${phoneNumber}`);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestWaWebVersion();

    // 3. KONFIGURASI KONEKSI
    const conn = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 2000,
    });

    // Simpan sesi dengan status awal 'connecting'
    sessions.set(phoneNumber, { conn, ws: socket, status: 'connecting' });

    const sendLog = (msg) => {
        const activeSession = sessions.get(phoneNumber);
        if (activeSession && activeSession.ws) {
            activeSession.ws.emit('log', msg);
        }
        console.log(`[${phoneNumber}] ${msg}`);
    };

    // 4. PAIRING CODE DENGAN SISTEM COOLDOWN
    if (!conn.authState.creds.registered) {
        // Cek cooldown 60 detik
        const lastReqTime = lastPairingRequest.get(phoneNumber) || 0;
        const now = Date.now();
        
        if (now - lastReqTime < 60000) { 
            console.log(`[${phoneNumber}] Menahan permintaan kode (Cooldown aktif) untuk mencegah Banned.`);
        } else {
            const activeSession = sessions.get(phoneNumber);
            if (activeSession && activeSession.ws) {
                sendLog('Sedang meminta Kode Pairing...');
                setTimeout(async () => {
                    try {
                        if (!sessions.has(phoneNumber)) return;
                        
                        // Catat waktu permintaan kode
                        lastPairingRequest.set(phoneNumber, Date.now());
                        
                        let code = await conn.requestPairingCode(phoneNumber); 
                        code = code?.match(/.{1,4}/g)?.join("-") || code;
                        
                        if (sessions.get(phoneNumber).ws) {
                            sessions.get(phoneNumber).ws.emit('pairing_code', code);
                        }
                        sendLog(`KODE PAIRING: ${code}`);
                    } catch (err) {
                        sendLog(`Gagal minta kode: ${err.message}`);
                    }
                }, 4000); // Jeda 4 detik agar WS siap
            }
        }
    }

    // --- LISTENER PESAN (PLUGIN LOADER) ---
    conn.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const sender = msg.key.remoteJid;
            const messageType = getContentType(msg.message);
            let textMessage = '';

            if (messageType === 'conversation') textMessage = msg.message.conversation;
            else if (messageType === 'extendedTextMessage') textMessage = msg.message.extendedTextMessage.text;
            else if (messageType === 'imageMessage') textMessage = msg.message.imageMessage.caption || '';

            if (!textMessage) return;

            // ==========================================
            // 🔥 PLUGIN LOADER SYSTEM 🔥
            // ==========================================
            const pluginsDir = path.join(__dirname, '../plugins'); 
            
            if (fs.existsSync(pluginsDir)) {
                const files = fs.readdirSync(pluginsDir);
                
                for (const file of files) {
                    if (file.endsWith('.js')) {
                        try {
                            const pluginPath = path.join(pluginsDir, file);
                            delete require.cache[require.resolve(pluginPath)]; // Hot Reload
                            
                            const plugin = require(pluginPath);
                            
                            if (plugin.active && typeof plugin.handle === 'function') {
                                const isHandled = await plugin.handle(conn, msg, textMessage, sender);
                                if (isHandled) return; 
                            }
                        } catch (err) {
                            console.error(`[PLUGIN ERROR] ${file}:`, err.message);
                        }
                    }
                }
            }
            // ==========================================
        } catch (error) {
            console.error('[MESSAGE ERROR]', error);
        }
    });

    // 5. HANDLE UPDATE KONEKSI
    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const activeSession = sessions.get(phoneNumber);
        const ws = activeSession?.ws;

        if (connection === 'close') {
            let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            
            if (reason === DisconnectReason.loggedOut || reason === 403) {
                console.log(`[${phoneNumber}] Logout/Banned. Hapus Sesi.`);
                if (ws) ws.emit('disconnected', 'Sesi ditolak (Logged out / Banned sementara). Silakan muat ulang halaman.');
                deleteSession(phoneNumber);
            } else if (reason === DisconnectReason.badSession) {
                console.log(`[${phoneNumber}] Sesi Rusak.`);
                if (ws) ws.emit('disconnected', 'Sesi rusak, silakan login ulang.');
                deleteSession(phoneNumber);
            } else {
                console.log(`[${phoneNumber}] Koneksi terputus (Kode: ${reason}). Menunggu 5 detik sebelum reconnect...`);
                if (ws) ws.emit('log', 'Mencoba menghubungkan ulang...');
                
                sessions.delete(phoneNumber);
                
                // Jeda 5 detik sebelum reconnect agar tidak dianggap SPAM
                setTimeout(() => {
                    connectToWhatsApp(phoneNumber, ws);
                }, 5000);
            }
        } else if (connection === 'open') {
            if (activeSession) activeSession.status = 'connected'; // UPDATE STATUS DI MEMORI
            if (ws) {
                ws.emit('connected', 'WhatsApp Berhasil Terhubung!');
                sendLog('Koneksi stabil.');
            }
        }
    });

    conn.ev.on('creds.update', saveCreds);
}

// --- FUNGSI CEK STATUS (Untuk Fitur Tahan Refresh) ---
function checkSessionStatus(phoneNumber) {
    if (sessions.has(phoneNumber)) {
        const session = sessions.get(phoneNumber);
        if (session.status === 'connected') {
            return true;
        }
    }
    return false;
}

// --- INIT SESSIONS (AUTO-START) ---
function initSessions() {
    const sessionDir = path.join(__dirname, '../sessions');
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
        return;
    }
    const files = fs.readdirSync(sessionDir);
    files.forEach(file => {
        const fullPath = path.join(sessionDir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            console.log(`[AUTO-RESTORE] Menghidupkan bot: ${file}`);
            // Panggil tanpa parameter socket
            connectToWhatsApp(file, null);
        }
    });
}

// --- KIRIM PESAN ---
async function sendWhatsappMessage(phoneNumber, to, text, mediaUrl = null) {
    const session = sessions.get(phoneNumber);
    if (!session || !session.conn) throw new Error('Bot belum aktif.');

    if (session.conn.ws && session.conn.ws.isOpen === false) {
        const wsClient = session.ws;
        sessions.delete(phoneNumber);
        connectToWhatsApp(phoneNumber, wsClient);
        throw new Error('Sedang menyambungkan ulang... Coba sebentar lagi.');
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    if (mediaUrl) {
        await session.conn.sendMessage(jid, { image: { url: mediaUrl }, caption: text });
    } else {
        await session.conn.sendMessage(jid, { text: text });
    }
    return true;
}

// --- DELETE SESSION ---
async function deleteSession(phoneNumber) {
    const sessionDir = path.join(__dirname, `../sessions/${phoneNumber}`);
    if (sessions.has(phoneNumber)) {
        try { sessions.get(phoneNumber).conn.end(undefined); } catch {}
        sessions.delete(phoneNumber);
    }
    
    // Hapus tracking cooldown saat sesi dihapus
    lastPairingRequest.delete(phoneNumber);
    
    if (fs.existsSync(sessionDir)) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (err) {}
    }
}

// --- GET GROUPS ---
async function getGroups(phoneNumber) {
    const session = sessions.get(phoneNumber);
    if (!session || !session.conn) throw new Error('Bot belum aktif.');
    const groups = await session.conn.groupFetchAllParticipating();
    return Object.values(groups).map(g => ({
        id: g.id,
        subject: g.subject,
        participants: g.participants.map(p => p.id)
    }));
}

module.exports = { connectToWhatsApp, deleteSession, sendWhatsappMessage, initSessions, getGroups, checkSessionStatus };
