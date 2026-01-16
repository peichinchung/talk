const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    // ✅ 手機防斷線關鍵：
    // 設定 60 秒 (60000ms) 超時。
    // 這代表手機網路斷開或切換 App 超過 1 分鐘，伺服器才會認定斷線。
    pingTimeout: 60000, 
    pingInterval: 25000 
});

app.use(express.static('public'));

let waitingQueue = [];
const MAX_CONNECTIONS = 1000;
const messageRateLimit = new Map();

// ❌ 已刪除 IDLE_TIMEOUT (閒置踢人功能)，現在會無限期保持連線

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
    // 連線數限制
    if (io.sockets.sockets.size > MAX_CONNECTIONS) {
        socket.emit('error', { msg: '伺服器繁忙，請稍後再試' });
        socket.disconnect(true);
        return;
    }

    console.log(`👤 用戶連線: ${socket.id}`);

    socket.on('start_chat', () => {
        // 防止重複加入排隊或狀態錯亂
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
                
                io.to(roomId).emit('matched', { roomId, topics: getRandomTopics() });
                console.log(`✅ 配對成功: ${roomId}`);
            } else {
                // 如果對象失效，重新排隊
                waitingQueue.push(socket.id);
                socket.emit('waiting', { msg: '搵緊聊天對象...' });
            }
        } else {
            waitingQueue.push(socket.id);
            socket.emit('waiting', { msg: '搵緊聊天對象...' });
            
            // 30秒沒配對到的安撫訊息
            socket.queueTimeout = setTimeout(() => {
                if (waitingQueue.includes(socket.id)) {
                    socket.emit('queue_timeout', { msg: '等緊人配對中...再等陣啦', waitingCount: waitingQueue.length });
                }
            }, 30000);
        }
    });

    socket.on('send_msg', (data) => {
        // 速率限制 (防洗版)
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
        }
    });

    // 狀態轉發
    socket.on('typing', () => { if (socket.roomId) socket.to(socket.roomId).emit('partner_typing'); });
    socket.on('stop_typing', () => { if (socket.roomId) socket.to(socket.roomId).emit('partner_stop_typing'); });
    socket.on('msg_read', () => { if (socket.roomId) socket.to(socket.roomId).emit('partner_read'); });

    // 用戶主動離開
    socket.on('end_chat', () => {
        if (!socket.roomId) return;
        const roomId = socket.roomId;
        socket.to(roomId).emit('partner_left', { msg: '對方已離開' });
        cleanupRoom(roomId);
        socket.emit('chat_ended', { msg: '對話已結束' });
    });

    // 意外斷線
    socket.on('disconnect', () => {
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
                    s.leave(roomId);
                    s.roomId = null;
                }
            });
        }
    } catch (err) {
        console.error('Cleanup error:', err);
    }
}

// 清理速率限制紀錄
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