const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    // ✅ 優化手機體驗：
    // pingTimeout: 伺服器多久沒收到心跳才算斷線。
    // 手機網絡不穩，建議設長一點 (由 30000 改為 60000)，避免用戶切換 App 時馬上斷線。
    pingTimeout: 60000, 
    pingInterval: 25000 
});

app.use(express.static('public'));

let waitingQueue = [];
const MAX_CONNECTIONS = 1000;
const messageRateLimit = new Map();

// ✅ 新增：閒置斷線時間 (5分鐘 = 300000 毫秒)
const IDLE_TIMEOUT = 5 * 60 * 1000;

const allTopics = [
    "🥢 邊度有好嘢食？", "💼 今晚收幾點？", "🎬 有冇好戲推介？",
    "⚽ 點睇琴晚場波？", "🎮 打機組隊？", "☕ 邊度咖啡好飲？", "📸 近排邊度打卡正？"
];

function getRandomTopics(count = 3) {
    const shuffled = [...allTopics].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

// ✅ 新增：重置閒置計時器函式
function resetIdleTimer(socket) {
    if (socket.idleTimer) clearTimeout(socket.idleTimer);
    
    // 只有在已經配對的狀態下才需要倒數
    if (socket.roomId) {
        socket.idleTimer = setTimeout(() => {
            // 時間到，強制斷線
            if (socket.roomId) {
                io.to(socket.roomId).emit('partner_left', { msg: '對方因太耐冇講嘢而被系統踢出' });
                socket.emit('error', { msg: '因為閒置太耐，連線已結束' });
                
                // 執行離開房間邏輯
                const roomId = socket.roomId;
                cleanupRoom(roomId);
            }
        }, IDLE_TIMEOUT);
    }
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

    console.log(`👤 用戶連線: ${socket.id}`);

    socket.on('start_chat', () => {
        // 清除舊狀態
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
                socket.roomId = roomId;
                partnerSocket.roomId = roomId;
                
                // 清除排隊超時
                if (socket.queueTimeout) { clearTimeout(socket.queueTimeout); socket.queueTimeout = null; }
                if (partnerSocket.queueTimeout) { clearTimeout(partnerSocket.queueTimeout); partnerSocket.queueTimeout = null; }
                
                // ✅ 配對成功，雙方啟動閒置計時器
                resetIdleTimer(socket);
                resetIdleTimer(partnerSocket);

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
        
        if (socket.roomId && socket.roomId === data.roomId) {
            socket.to(data.roomId).emit('receive_msg', { msg: cleanMsg });
            
            // ✅ 有傳訊息，重置雙方的閒置計時器 (因為代表這個房間還活躍)
            // 這樣可以避免「對方一直講話，但我只是聽，結果我被踢」的情況
            const room = io.sockets.adapter.rooms.get(socket.roomId);
            if (room) {
                room.forEach(sid => {
                    const s = io.sockets.sockets.get(sid);
                    if (s) resetIdleTimer(s);
                });
            }
        }
    });

    socket.on('typing', () => { if (socket.roomId) socket.to(socket.roomId).emit('partner_typing'); });
    socket.on('stop_typing', () => { if (socket.roomId) socket.to(socket.roomId).emit('partner_stop_typing'); });
    socket.on('msg_read', () => { if (socket.roomId) socket.to(socket.roomId).emit('partner_read'); });

    socket.on('end_chat', () => {
        if (!socket.roomId) return;
        const roomId = socket.roomId;
        socket.to(roomId).emit('partner_left', { msg: '對方已離開' });
        cleanupRoom(roomId);
        socket.emit('chat_ended', { msg: '對話已結束' });
    });

    socket.on('disconnect', () => {
        // ✅ 斷線時清除計時器
        if (socket.idleTimer) clearTimeout(socket.idleTimer);
        
        messageRateLimit.delete(socket.id);
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        if (socket.queueTimeout) clearTimeout(socket.queueTimeout);
        
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_left', { msg: '對方已離開' });
            cleanupRoom(socket.roomId);
        }
    });
});

function cleanupRoom(roomId) {
    try {
        const room = io.sockets.adapter.rooms.get(roomId);
        if (room) {
            room.forEach(socketId => {
                const s = io.sockets.sockets.get(socketId);
                if (s) {
                    // ✅ 離開房間時，也要清除計時器
                    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
                    s.leave(roomId);
                    s.roomId = null;
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