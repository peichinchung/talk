const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    // ⚡️ 保持 10秒 快速偵測，解決殭屍連線問題
    pingTimeout: 10000, 
    pingInterval: 15000, 
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));

// --- 資料結構 ---
let waitingQueue = []; // 存 userId
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
    socket.userId = token; 
    next();
});

io.on('connection', (socket) => {
    const userId = socket.userId;
    console.log(`🔗 連線: ${userId} (${socket.id})`);

    // ♻️ [重連機制]
    if (userSessions.has(userId)) {
        const session = userSessions.get(userId);
        session.socketId = socket.id;
        
        // 取消銷毀倒數
        if (session.disconnectTimer) {
            clearTimeout(session.disconnectTimer);
            session.disconnectTimer = null;
        }

        // 如果原本在房間，拉回去
        if (session.roomId) {
            socket.join(session.roomId);
            socket.roomId = session.roomId;
            
            socket.emit('connection_recovered', { roomId: session.roomId });
            
            // 通知對方：我回來了
            socket.to(session.roomId).emit('partner_status', { 
                status: 'online', 
                msg: '對方已回來 ✅' 
            });
        }
        userSessions.set(userId, session);
    } else {
        userSessions.set(userId, { roomId: null, socketId: socket.id, disconnectTimer: null });
    }

    // --- 配對邏輯 ---
    socket.on('start_chat', () => {
        const session = userSessions.get(userId);
        
        // 如果已經在房間，先離開 (支援重新配對按鈕)
        if (session && session.roomId) {
            socket.to(session.roomId).emit('partner_left', { msg: '對方已離開' });
            leaveRoom(userId, session.roomId);
        }

        // 移除舊的排隊紀錄
        waitingQueue = waitingQueue.filter(id => id !== userId);

        if (waitingQueue.length > 0) {
            // 尋找對象
            let partnerId = waitingQueue.shift();
            
            // 確保對象有效
            while (!userSessions.has(partnerId) && waitingQueue.length > 0) {
                 partnerId = waitingQueue.shift();
            }

            if (userSessions.has(partnerId)) {
                const partnerSession = userSessions.get(partnerId);
                const roomId = `room_${Math.random().toString(36).substr(2, 9)}`;
                
                session.roomId = roomId;
                partnerSession.roomId = roomId;
                
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
                waitingQueue.push(userId);
                socket.emit('waiting', { msg: '搵緊聊天對象...' });
            }
        } else {
            waitingQueue.push(userId);
            socket.emit('waiting', { msg: '搵緊聊天對象...' });
        }
    });

    // --- 發送訊息 ---
    socket.on('send_msg', (data, callback) => {
        const session = userSessions.get(userId);
        if (session && session.roomId) {
            socket.to(session.roomId).emit('receive_msg', { msg: data.msg });
            if (callback) callback({ status: 'ok' });
        }
    });

    // ✨ 新增功能：轉發已讀狀態
    socket.on('msg_read', () => {
        const s = userSessions.get(userId);
        if (s && s.roomId) socket.to(s.roomId).emit('partner_read');
    });

    // ✨ 新增功能：轉發打字狀態
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

    // --- 斷線處理 ---
    socket.on('disconnect', (reason) => {
        console.log(`❌ 斷線: ${userId} (${reason})`);
        
        waitingQueue = waitingQueue.filter(id => id !== userId);
        const session = userSessions.get(userId);
        
        if (session && session.roomId) {
            // ✨ 修改點：這裡改成你指定的文字
            socket.to(session.roomId).emit('partner_status', { 
                status: 'offline', 
                msg: '對方暫時跳出了視窗 請等等' 
            });

            // 60秒後銷毀房間
            session.disconnectTimer = setTimeout(() => {
                if (session.roomId) {
                    io.to(session.roomId).emit('partner_left', { msg: '對方已斷線離開' });
                    // 強制清理
                    const rId = session.roomId;
                    const users = rooms.get(rId);
                    if (users) {
                        users.forEach(u => {
                            const uS = userSessions.get(u);
                            if (uS) uS.roomId = null;
                        });
                        rooms.delete(rId);
                    }
                }
            }, 60000); 
        } else {
            // 不在房間則 5秒後清除 Session
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