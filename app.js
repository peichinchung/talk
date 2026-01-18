const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    // 關閉內建的 connectionStateRecovery，改用我們自己的 Session 機制比較穩
    pingTimeout: 10000,  // 縮短到 10秒，更快發現斷線
    pingInterval: 15000, 
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));

// 資料結構
let waitingQueue = []; // 存 userId 而不是 socket.id
const userSessions = new Map(); // userId -> { roomId, socketId, disconnectTimer }
const rooms = new Map(); // roomId -> Set(userId)

app.get('/health', (req, res) => {
    res.json({ status: 'ok', online: userSessions.size, waiting: waitingQueue.length });
});

// 中間件：處理身份驗證
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("invalid token"));
    socket.userId = token; // 把 userId 綁定到這個 socket
    next();
});

io.on('connection', (socket) => {
    const userId = socket.userId;
    console.log(`🔗 用戶連線: ${userId} (Socket: ${socket.id})`);

    // ♻️ 檢查是否為「斷線重連」的舊用戶
    if (userSessions.has(userId)) {
        const session = userSessions.get(userId);
        
        // 如果有斷線計時器，先取消（代表他回來了）
        if (session.disconnectTimer) {
            clearTimeout(session.disconnectTimer);
            session.disconnectTimer = null;
        }

        // 更新 session 中的新 socket ID
        session.socketId = socket.id;
        userSessions.set(userId, session);

        // 如果他原本在房間裡，把他拉回去
        if (session.roomId) {
            socket.join(session.roomId);
            socket.roomId = session.roomId;
            
            console.log(`♻️ 用戶 ${userId} 重連回房間 ${session.roomId}`);
            
            // 通知前端恢復成功
            socket.emit('connection_recovered', { roomId: session.roomId });
            
            // 通知對方「我回來了」
            socket.to(session.roomId).emit('partner_status', { 
                status: 'online', 
                msg: '對方已重新連線' 
            });
        }
    } else {
        // 全新用戶
        userSessions.set(userId, { roomId: null, socketId: socket.id, disconnectTimer: null });
    }

    socket.on('start_chat', () => {
        // 清理舊狀態
        const session = userSessions.get(userId);
        if (session && session.roomId) {
            socket.to(session.roomId).emit('partner_left', { msg: '對方已離開' });
            leaveRoom(userId, session.roomId);
        }
        
        // 移除等待隊列中的舊紀錄
        waitingQueue = waitingQueue.filter(id => id !== userId);

        if (waitingQueue.length > 0) {
            // 配對成功
            const partnerId = waitingQueue.shift();
            
            // 檢查 partner 是否還在線
            if (userSessions.has(partnerId)) {
                const roomId = `room_${Math.random().toString(36).substr(2, 9)}`;
                const partnerSession = userSessions.get(partnerId);
                const partnerSocket = io.sockets.sockets.get(partnerSession.socketId);

                // 更新雙方 Session
                session.roomId = roomId;
                partnerSession.roomId = roomId;
                
                // 自己的 socket 設定
                socket.join(roomId);
                socket.roomId = roomId;
                
                // 對方的 socket 設定 (如果對方 socket 還活著)
                if (partnerSocket) {
                    partnerSocket.join(roomId);
                    partnerSocket.roomId = roomId;
                }

                // 記錄房間成員
                rooms.set(roomId, new Set([userId, partnerId]));

                io.to(roomId).emit('matched', { roomId, topics: getRandomTopics() });
                console.log(`✅ 配對成功: ${roomId} (${userId} & ${partnerId})`);
            } else {
                // Partner 失效，把自己放回隊列
                waitingQueue.push(userId);
                socket.emit('waiting', { msg: '搵緊聊天對象...' });
            }
        } else {
            waitingQueue.push(userId);
            socket.emit('waiting', { msg: '搵緊聊天對象...' });
        }
    });

    socket.on('send_msg', (data, callback) => {
        const session = userSessions.get(userId);
        if (!session || !session.roomId) return;
        
        // 確保訊息發送到正確房間
        socket.to(session.roomId).emit('receive_msg', { msg: data.msg });
        if (callback) callback({ status: 'ok' });
    });

    // 處理打字狀態等... (略，與之前相同，記得用 session.roomId)
    socket.on('typing', () => { 
        const s = userSessions.get(userId);
        if (s && s.roomId) socket.to(s.roomId).emit('partner_typing'); 
    });
    socket.on('stop_typing', () => { 
        const s = userSessions.get(userId);
        if (s && s.roomId) socket.to(s.roomId).emit('partner_stop_typing'); 
    });

    socket.on('end_chat', () => {
        const session = userSessions.get(userId);
        if (session && session.roomId) {
            socket.to(session.roomId).emit('partner_left', { msg: '對方已離開' });
            leaveRoom(userId, session.roomId);
            socket.emit('chat_ended', { msg: '對話已結束' });
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`❌ 斷線: ${userId} (${reason})`);
        
        // 從等待隊列移除
        waitingQueue = waitingQueue.filter(id => id !== userId);

        const session = userSessions.get(userId);
        if (session && session.roomId) {
            // 通知對方「斷線中」
            socket.to(session.roomId).emit('partner_status', { 
                status: 'offline', 
                msg: '對方連線不穩，等待重連中...' 
            });

            // 設定 60秒 銷毀倒數
            // 這是關鍵：不會馬上踢人，給 60秒緩衝讓手機重連
            session.disconnectTimer = setTimeout(() => {
                console.log(`💀 用戶 ${userId} 超時未歸，銷毀房間`);
                if (session.roomId) {
                    io.to(session.roomId).emit('partner_left', { msg: '對方已斷線離開' });
                    // 強制清理該房間所有成員
                    const roomUsers = rooms.get(session.roomId);
                    if (roomUsers) {
                        roomUsers.forEach(uid => {
                            const uSession = userSessions.get(uid);
                            if (uSession) uSession.roomId = null;
                            // 這裡不刪除 session，只清空 roomId，讓他下次進來是閒置狀態
                        });
                        rooms.delete(session.roomId);
                    }
                }
            }, 60000); 
        } else {
            // 如果不在房間，直接刪除 session (過一段時間)
            setTimeout(() => {
                if (userSessions.has(userId) && !userSessions.get(userId).roomId) {
                    userSessions.delete(userId);
                }
            }, 5000);
        }
    });
});

function leaveRoom(userId, roomId) {
    // 取得房間內另一個人的 ID
    const roomUsers = rooms.get(roomId);
    if (roomUsers) {
        roomUsers.delete(userId); // 移除自己
        // 如果房間沒人了，刪除房間
        if (roomUsers.size === 0) rooms.delete(roomId);
    }
    
    const session = userSessions.get(userId);
    if (session) session.roomId = null;
    
    // 讓 socket 離開 channel
    const socket = io.sockets.sockets.get(session?.socketId);
    if (socket) socket.leave(roomId);
}

// 輔助：隨機話題
const allTopics = ["🥢 邊度有好嘢食？", "🎬 有冇好戲推介？", "🎮 打機組隊？", "📸 週末去邊玩？"];
function getRandomTopics() { return allTopics.sort(() => 0.5 - Math.random()).slice(0, 3); }

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => { console.log(`✅ Server running on ${PORT}`); });