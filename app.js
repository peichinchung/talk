const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    // ⚡️ 關鍵設定：快速偵測斷線
    // pingTimeout 10秒：如果10秒內沒收到回應，視為斷線 (解決殭屍連線)
    pingTimeout: 10000, 
    pingInterval: 15000, 
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));

// --- 資料結構 ---
let waitingQueue = []; // 存 userId 而不是 socket.id
const userSessions = new Map(); // userId -> { roomId, socketId, disconnectTimer }
const rooms = new Map(); // roomId -> Set(userId)

const allTopics = [
    "🥢 邊度有好嘢食？", "🎬 有冇好戲推介？", "🎮 打機組隊？", 
    "📸 週末去邊玩？", "💼 返工有無趣事？", "👻 講個鬼故黎聽下？"
];

function getRandomTopics() {
    return [...allTopics].sort(() => 0.5 - Math.random()).slice(0, 3);
}

// --- 中間件：身份驗證 ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication error"));
    socket.userId = token; // 將 Socket 綁定到特定的 UserID
    next();
});

io.on('connection', (socket) => {
    const userId = socket.userId;
    console.log(`🔗 連線: ${userId} (${socket.id})`);

    // ♻️ [重連機制] 檢查是否為斷線重連的用戶
    if (userSessions.has(userId)) {
        const session = userSessions.get(userId);
        
        // 更新新的 Socket ID
        session.socketId = socket.id;
        
        // 如果有斷線銷毀倒數，先取消 (代表他在時間內回來了)
        if (session.disconnectTimer) {
            clearTimeout(session.disconnectTimer);
            session.disconnectTimer = null;
            console.log(`✨ 用戶 ${userId} 在銷毀前重連成功！`);
        }

        // 如果他原本在房間裡，強制把他拉回去
        if (session.roomId) {
            socket.join(session.roomId);
            socket.roomId = session.roomId; // 方便後續存取
            
            // 通知前端：你已回到房間
            socket.emit('connection_recovered', { roomId: session.roomId });
            
            // 通知對方：我回來了
            socket.to(session.roomId).emit('partner_status', { 
                status: 'online', 
                msg: '對方已重新連線 ✅' 
            });
        }
        userSessions.set(userId, session); // 更新 Map
    } else {
        // 新用戶初始化
        userSessions.set(userId, { roomId: null, socketId: socket.id, disconnectTimer: null });
    }

    // --- 配對邏輯 ---
    socket.on('start_chat', () => {
        const session = userSessions.get(userId);
        
        // 如果已經在房間，先離開
        if (session && session.roomId) {
            socket.to(session.roomId).emit('partner_left', { msg: '對方已離開' });
            leaveRoom(userId, session.roomId);
        }

        // 清理自己在等待隊列的舊紀錄
        waitingQueue = waitingQueue.filter(id => id !== userId);

        if (waitingQueue.length > 0) {
            // 找到對象
            let partnerId = waitingQueue.shift();
            
            // 再次確認 partner 是否有效 (防止配對到剛斷線的人)
            while (!userSessions.has(partnerId) && waitingQueue.length > 0) {
                 partnerId = waitingQueue.shift();
            }

            if (userSessions.has(partnerId)) {
                const partnerSession = userSessions.get(partnerId);
                const roomId = `room_${Math.random().toString(36).substr(2, 9)}`;
                
                // 設定雙方狀態
                session.roomId = roomId;
                partnerSession.roomId = roomId;
                
                // Socket Join
                socket.join(roomId);
                socket.roomId = roomId;

                const partnerSocket = io.sockets.sockets.get(partnerSession.socketId);
                if (partnerSocket) {
                    partnerSocket.join(roomId);
                    partnerSocket.roomId = roomId;
                }

                rooms.set(roomId, new Set([userId, partnerId]));
                
                io.to(roomId).emit('matched', { roomId, topics: getRandomTopics() });
                console.log(`✅ 配對成功: ${roomId}`);
            } else {
                // 如果佇列沒人有效，把自己放進去
                waitingQueue.push(userId);
                socket.emit('waiting', { msg: '搵緊聊天對象...' });
            }
        } else {
            waitingQueue.push(userId);
            socket.emit('waiting', { msg: '搵緊聊天對象...' });
        }
    });

    // --- 發送訊息 (含 Ack 回調) ---
    socket.on('send_msg', (data, callback) => {
        const session = userSessions.get(userId);
        
        if (!session || !session.roomId) {
            if (callback) callback({ status: 'error', msg: '你不在房間內' });
            return;
        }

        // 檢查房間是否只剩自己 (防止對方已斷線但還沒銷毀)
        const roomUsers = rooms.get(session.roomId);
        if (!roomUsers || roomUsers.size < 2) {
             // 這裡可以選擇是否允許發送，或者提示對方斷線
             // 為了體驗，我們還是允許發送，但可以標記
        }

        socket.to(session.roomId).emit('receive_msg', { msg: data.msg });
        
        // 告訴前端發送成功
        if (callback) callback({ status: 'ok' });
    });

    socket.on('typing', () => {
        const s = userSessions.get(userId);
        if (s && s.roomId) socket.to(s.roomId).emit('partner_typing');
    });

    socket.on('stop_typing', () => {
        const s = userSessions.get(userId);
        if (s && s.roomId) socket.to(s.roomId).emit('partner_stop_typing');
    });

    socket.on('end_chat', () => {
        const s = userSessions.get(userId);
        if (s && s.roomId) {
            socket.to(s.roomId).emit('partner_left', { msg: '對方已離開' });
            leaveRoom(userId, s.roomId);
            socket.emit('chat_ended', { msg: '對話已結束' });
        }
    });

    // --- 斷線處理 (最關鍵的部分) ---
    socket.on('disconnect', (reason) => {
        console.log(`❌ 斷線: ${userId} (${reason})`);
        
        // 從等待隊列移除
        waitingQueue = waitingQueue.filter(id => id !== userId);

        const session = userSessions.get(userId);
        if (session && session.roomId) {
            // 1. 先通知對方「連線不穩」
            socket.to(session.roomId).emit('partner_status', { 
                status: 'offline', 
                msg: '對方連線不穩，等待重連中... ⏳' 
            });

            // 2. 設定 60秒 倒數
            session.disconnectTimer = setTimeout(() => {
                console.log(`💀 用戶 ${userId} 超時未歸，銷毀房間`);
                
                // 再次檢查是否真的還沒回來 (防止 race condition)
                const currentSession = userSessions.get(userId);
                if (currentSession && currentSession.roomId) {
                    io.to(currentSession.roomId).emit('partner_left', { msg: '對方已斷線離開' });
                    
                    // 強制拆房
                    const rId = currentSession.roomId;
                    const users = rooms.get(rId);
                    if (users) {
                        users.forEach(u => {
                            const uS = userSessions.get(u);
                            if (uS) uS.roomId = null;
                        });
                        rooms.delete(rId);
                    }
                }
            }, 60000); // 60秒寬限期
        } else {
            // 如果不在房間，5秒後清理 Session
            setTimeout(() => {
                if (userSessions.has(userId) && !userSessions.get(userId).roomId) {
                    userSessions.delete(userId);
                }
            }, 5000);
        }
    });
});

function leaveRoom(userId, roomId) {
    const roomUsers = rooms.get(roomId);
    if (roomUsers) {
        roomUsers.delete(userId);
        if (roomUsers.size === 0) rooms.delete(roomId);
    }
    
    const session = userSessions.get(userId);
    if (session) {
        const socket = io.sockets.sockets.get(session.socketId);
        if (socket) socket.leave(roomId);
        session.roomId = null;
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 伺服器啟動於 Port ${PORT}`);
});