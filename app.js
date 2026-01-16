const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    // ✅ 啟用連線狀態恢復 (Connection State Recovery)
    // 這是 Socket.io V4.6+ 的新功能，專門解決手機斷線問題
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // 2分鐘內回來都算同一個人
        skipMiddlewares: true,
    },
    pingTimeout: 60000, 
    pingInterval: 25000 
});

app.use(express.static('public'));

let waitingQueue = [];
const MAX_CONNECTIONS = 1000;
const messageRateLimit = new Map();

// 用來記錄房間的「銷毀倒數計時器」
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
    if (io.sockets.sockets.size > MAX_CONNECTIONS) {
        socket.emit('error', { msg: '伺服器繁忙，請稍後再試' });
        socket.disconnect(true);
        return;
    }

    // ✅ 檢查是否為「恢復連線」的用戶
    if (socket.recovered) {
        console.log(`♻️ 用戶恢復連線: ${socket.id} (Room: ${socket.roomId})`);
        
        // 如果這個房間原本在「倒數銷毀中」，現在有人回來了，就取消倒數！
        if (socket.roomId && roomDestructionTimers.has(socket.roomId)) {
            clearTimeout(roomDestructionTimers.get(socket.roomId));
            roomDestructionTimers.delete(socket.roomId);
            console.log(`🛡️ 房間 ${socket.roomId} 銷毀倒數已取消`);
            
            // 通知房間裡的其他人：我也回來了
            socket.to(socket.roomId).emit('partner_status', { status: 'online', msg: '對方已重新連線' });
        }
        return; // 恢復連線者不需要重跑下面的初始化邏輯
    }

    console.log(`👤 新用戶連線: ${socket.id}`);

    socket.on('start_chat', () => {
        if (socket.roomId) {
            socket.leave(socket.roomId);
            socket.roomId = null;
        }
        
        if (waitingQueue.includes(socket.id)) return;

        if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();
            const partnerSocket = io.sockets.sockets.get(partnerId);
            
            if (partnerSocket && !partnerSocket.roomId) {
                const roomId = `room_${partnerId}_${socket.id}`;
                socket.join(roomId);
                partnerSocket.join(roomId);
                
                // 設定 Socket 資料，方便斷線恢復時辨識
                socket.data.roomId = roomId;
                partnerSocket.data.roomId = roomId;
                socket.roomId = roomId;
                partnerSocket.roomId = roomId;
                
                if (socket.queueTimeout) { clearTimeout(socket.queueTimeout); socket.queueTimeout = null; }
                if (partnerSocket.queueTimeout) { clearTimeout(partnerSocket.queueTimeout); partnerSocket.queueTimeout = null; }
                
                io.to(roomId).emit('matched', { roomId, topics: getRandomTopics() });
                console.log(`✅ 配對成功: ${roomId}`);
            } else {
                waitingQueue.push(socket.id);
                socket.emit('waiting', { msg: '搵緊聊天對象...' });
            }
        } else {
            waitingQueue.push(socket.id);
            socket.emit('waiting', { msg: '搵緊聊天對象...' });
            
            socket.queueTimeout = setTimeout(() => {
                if (waitingQueue.includes(socket.id)) {
                    socket.emit('queue_timeout', { msg: '等緊人配對中...再等陣啦', waitingCount: waitingQueue.length });
                }
            }, 30000);
        }
    });

    socket.on('send_msg', (data) => {
        const now = Date.now();
        const userMessages = messageRateLimit.get(socket.id) || [];
        const recentMessages = userMessages.filter(time => now - time < 1000);
        
        if (recentMessages.length >= 5) {
            socket.emit('error', { msg: '發送太快，請稍候' });
            return;
        }
        
        recentMessages.push(now);
        messageRateLimit.set(socket.id, recentMessages);
        
        if (!data || !data.msg || typeof data.msg !== 'string') return;
        const cleanMsg = data.msg.trim();
        if (cleanMsg.length === 0 || cleanMsg.length > 1000) return;
        
        // 使用 socket.data.roomId 以支援恢復
        const currentRoom = socket.roomId || socket.data.roomId;
        if (currentRoom && currentRoom === data.roomId) {
            socket.to(data.roomId).emit('receive_msg', { msg: cleanMsg });
        }
    });

    socket.on('typing', () => { 
        const r = socket.roomId || socket.data.roomId;
        if (r) socket.to(r).emit('partner_typing'); 
    });
    
    socket.on('stop_typing', () => { 
        const r = socket.roomId || socket.data.roomId;
        if (r) socket.to(r).emit('partner_stop_typing'); 
    });
    
    socket.on('msg_read', () => { 
        const r = socket.roomId || socket.data.roomId;
        if (r) socket.to(r).emit('partner_read'); 
    });

    socket.on('end_chat', () => {
        const r = socket.roomId || socket.data.roomId;
        if (!r) return;
        socket.to(r).emit('partner_left', { msg: '對方已離開' });
        cleanupRoom(r);
        socket.emit('chat_ended', { msg: '對話已結束' });
    });

    socket.on('disconnect', (reason) => {
        messageRateLimit.delete(socket.id);
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        if (socket.queueTimeout) clearTimeout(socket.queueTimeout);
        
        const r = socket.roomId || socket.data.roomId;
        
        // ✅ 關鍵修改：如果是意外斷線 (transport close)，不要馬上清理房間
        if (r) {
            // 通知對方：他斷線了，但可能等等回來
            socket.to(r).emit('partner_status', { status: 'offline', msg: '對方連線不穩，等待重連中...' });

            // 設定 60 秒倒數，如果 60 秒內沒連回來，才真的清理房間
            if (!roomDestructionTimers.has(r)) {
                const timer = setTimeout(() => {
                    io.to(r).emit('partner_left', { msg: '對方已斷線離開' });
                    cleanupRoom(r);
                    roomDestructionTimers.delete(r);
                }, 60000); // 60秒寬限期
                roomDestructionTimers.set(r, timer);
            }
        }
    });
});

function cleanupRoom(roomId) {
    if (roomDestructionTimers.has(roomId)) {
        clearTimeout(roomDestructionTimers.get(roomId));
        roomDestructionTimers.delete(roomId);
    }
    
    try {
        const room = io.sockets.adapter.rooms.get(roomId);
        if (room) {
            room.forEach(socketId => {
                const s = io.sockets.sockets.get(socketId);
                if (s) {
                    s.leave(roomId);
                    s.roomId = null;
                    s.data.roomId = null;
                }
            });
        }
    } catch (err) {
        console.error('Cleanup error:', err);
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [id, times] of messageRateLimit.entries()) {
        if (times.length === 0 || now - times[times.length - 1] > 60000) {
            messageRateLimit.delete(id);
        }
    }
}, 300000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 暖港野伺服器啟動於 Port ${PORT}`);
});