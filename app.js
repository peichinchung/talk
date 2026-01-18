const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    connectionStateRecovery: {
        // 斷線後 2 分鐘內可嘗試恢復狀態
        maxDisconnectionDuration: 2 * 60 * 1000, 
        skipMiddlewares: true,
    },
    // ⚡️ 核心修改：讓連線檢測更敏銳
    // Render/Heroku 等平台通常會在 60秒無傳輸時切斷連線
    // 設定 25s Ping + 20s Timeout = 45s，確保連線活躍且能快速發現斷線
    pingTimeout: 20000, 
    pingInterval: 25000, 
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));

let waitingQueue = [];
const MAX_CONNECTIONS = 1000;
const messageRateLimit = new Map();
const roomDestructionTimers = new Map();

const allTopics = [
    "🥢 邊度有好嘢食？", "💼 今晚收幾點？", "🎬 有冇好戲推介？",
    "⚽ 點睇琴晚場波？", "🎮 打機組隊？", "☕ 邊度咖啡好飲？", "📸 近排邊度打卡正？"
];

function getRandomTopics(count = 3) {
    const shuffled = [...allTopics].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        online: io.sockets.sockets.size,
        waiting: waitingQueue.length,
        rooms: Array.from(io.sockets.adapter.rooms.keys()).filter(r => r.startsWith('room_')).length,
        timestamp: new Date().toISOString()
    });
});

io.on('connection', (socket) => {
    // 檢查連線數上限
    if (io.sockets.sockets.size > MAX_CONNECTIONS) {
        socket.emit('error', { msg: '伺服器繁忙，請稍後再試' });
        socket.disconnect(true);
        return;
    }

    // --- 恢復連線邏輯 ---
    if (socket.recovered) {
        const recoveredRoom = socket.roomId || socket.data.roomId;
        console.log(`♻️ 用戶恢復連線: ${socket.id} (Room: ${recoveredRoom})`);
        
        if (recoveredRoom) {
            if (!socket.rooms.has(recoveredRoom)) {
                socket.join(recoveredRoom);
            }
            socket.roomId = recoveredRoom;
            socket.data.roomId = recoveredRoom;
            
            // 取消銷毀倒數 (因為人回來了)
            if (roomDestructionTimers.has(recoveredRoom)) {
                clearTimeout(roomDestructionTimers.get(recoveredRoom));
                roomDestructionTimers.delete(recoveredRoom);
            }
            
            socket.emit('connection_recovered', { 
                roomId: recoveredRoom,
                topics: getRandomTopics()
            });
            socket.to(recoveredRoom).emit('partner_status', { 
                status: 'online', 
                msg: '對方已重新連線' 
            });
        }
        return;
    }

    console.log(`👤 新用戶連線: ${socket.id}`);

    // --- 開始配對邏輯 ---
    socket.on('start_chat', () => {
        // 清理舊狀態
        if (socket.roomId) {
            leaveRoom(socket, socket.roomId);
        }
        
        // 確保不在等待隊列中
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        if (socket.queueTimeout) clearTimeout(socket.queueTimeout);

        // ⚡️ 核心修改：配對時過濾掉「假在線」的 Socket
        let partnerId = null;
        let partnerSocket = null;

        while (waitingQueue.length > 0) {
            partnerId = waitingQueue.shift();
            partnerSocket = io.sockets.sockets.get(partnerId);

            // 嚴格檢查：必須 Connected 且沒有房間
            if (partnerSocket && partnerSocket.connected && !partnerSocket.roomId) {
                break; // 找到有效夥伴
            } else {
                partnerSocket = null; // 無效，繼續找下一個
            }
        }

        if (partnerSocket) {
            // 配對成功
            const roomId = `room_${partnerId}_${socket.id}`;
            
            socket.join(roomId);
            partnerSocket.join(roomId);
            
            socket.roomId = roomId;
            socket.data.roomId = roomId;
            partnerSocket.roomId = roomId;
            partnerSocket.data.roomId = roomId;
            
            // 清理計時器
            if (partnerSocket.queueTimeout) clearTimeout(partnerSocket.queueTimeout);
            if (socket.queueTimeout) clearTimeout(socket.queueTimeout);
            
            io.to(roomId).emit('matched', { roomId, topics: getRandomTopics() });
            console.log(`✅ 配對成功: ${roomId}`);
        } else {
            // 加入隊列等待
            waitingQueue.push(socket.id);
            socket.emit('waiting', { msg: '搵緊聊天對象...' });
            
            // 30秒後通知還在等
            socket.queueTimeout = setTimeout(() => {
                if (waitingQueue.includes(socket.id)) {
                    socket.emit('queue_timeout', { 
                        msg: '等緊人配對中...再等陣啦', 
                        waitingCount: waitingQueue.length 
                    });
                }
            }, 30000);
        }
    });

    // --- 發送訊息邏輯 ---
    // ⚡️ 核心修改：增加 callback 回調函數
    socket.on('send_msg', (data, callback) => {
        const now = Date.now();
        const userMessages = messageRateLimit.get(socket.id) || [];
        const recentMessages = userMessages.filter(time => now - time < 1000);
        
        if (recentMessages.length >= 5) {
            socket.emit('error', { msg: '發送太快，請稍候' });
            if (typeof callback === 'function') callback({ status: 'error' });
            return;
        }
        
        recentMessages.push(now);
        messageRateLimit.set(socket.id, recentMessages);
        
        if (!data || !data.msg || typeof data.msg !== 'string') return;
        const cleanMsg = data.msg.trim();
        if (cleanMsg.length === 0 || cleanMsg.length > 1000) return;
        
        const currentRoom = socket.roomId || socket.data.roomId;
        
        // 嚴格檢查房間匹配
        if (currentRoom && currentRoom === data.roomId) {
            // 檢查房間是否還有其他人 (防止對空氣講話)
            const roomSize = io.sockets.adapter.rooms.get(currentRoom)?.size || 0;
            
            if (roomSize < 2) {
                // 對方可能斷線了
                if (typeof callback === 'function') callback({ status: 'error', msg: '對方已斷線' });
                // 通知發送者對方不在了
                socket.emit('partner_left', { msg: '對方已斷線，無法傳送' });
                cleanupRoom(currentRoom);
            } else {
                // 正常發送
                socket.to(data.roomId).emit('receive_msg', { msg: cleanMsg });
                // 告訴前端發送成功
                if (typeof callback === 'function') callback({ status: 'ok' });
            }
        } else {
            if (typeof callback === 'function') callback({ status: 'error', msg: '房間錯誤' });
        }
    });

    socket.on('typing', () => { 
        const r = socket.roomId;
        if (r) socket.to(r).emit('partner_typing'); 
    });
    
    socket.on('stop_typing', () => { 
        const r = socket.roomId;
        if (r) socket.to(r).emit('partner_stop_typing'); 
    });
    
    socket.on('msg_read', () => { 
        const r = socket.roomId;
        if (r) socket.to(r).emit('partner_read'); 
    });

    socket.on('end_chat', () => {
        const r = socket.roomId;
        if (r) {
            socket.to(r).emit('partner_left', { msg: '對方已離開' });
            leaveRoom(socket, r);
            cleanupRoom(r); // 強制清理房間
            socket.emit('chat_ended', { msg: '對話已結束' });
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`👋 用戶斷線: ${socket.id}, 原因: ${reason}`);
        
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        if (socket.queueTimeout) clearTimeout(socket.queueTimeout);
        
        const r = socket.roomId || socket.data.roomId;
        
        if (r) {
            socket.to(r).emit('partner_status', { 
                status: 'offline', 
                msg: '對方連線不穩，等待重連中...' 
            });

            // 設置房間銷毀倒數 (60秒後若沒重連則銷毀)
            // 手機版切換 App 容易斷線，給予一點緩衝時間
            if (!roomDestructionTimers.has(r)) {
                const timer = setTimeout(() => {
                    console.log(`⏰ 房間 ${r} 超時，強制清理`);
                    io.to(r).emit('partner_left', { msg: '對方已斷線離開' });
                    cleanupRoom(r);
                }, 60000); // 1分鐘緩衝
                roomDestructionTimers.set(r, timer);
            }
        }
    });
});

// 輔助函數：讓單一 Socket 離開房間
function leaveRoom(socket, roomId) {
    socket.leave(roomId);
    socket.roomId = null;
    socket.data.roomId = null;
}

// 輔助函數：徹底清理房間
function cleanupRoom(roomId) {
    if (roomDestructionTimers.has(roomId)) {
        clearTimeout(roomDestructionTimers.get(roomId));
        roomDestructionTimers.delete(roomId);
    }
    
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room) {
        // 讓房間內剩下的所有人離開
        room.forEach(socketId => {
            const s = io.sockets.sockets.get(socketId);
            if (s) {
                leaveRoom(s, roomId);
                s.emit('partner_left', { msg: '對話已結束' });
            }
        });
    }
}

// 定期清理任務 (5分鐘)
setInterval(() => {
    const now = Date.now();
    for (const [id, times] of messageRateLimit.entries()) {
        if (times.length === 0 || now - times[times.length - 1] > 60000) {
            messageRateLimit.delete(id);
        }
    }
    // 再次確認等待隊列中的 socket 是否真的活著
    waitingQueue = waitingQueue.filter(id => {
        const s = io.sockets.sockets.get(id);
        return s && s.connected;
    });
}, 300000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 暖港野伺服器啟動於 Port ${PORT}`);
});