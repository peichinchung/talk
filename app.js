const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

app.use(express.static('public'));

let waitingQueue = [];
const MAX_CONNECTIONS = 1000;
const messageRateLimit = new Map(); // ✅ 新增：訊息速率限制

const allTopics = [
    "🔥 最近個單新聞點睇？",
    "🥢 呢排有咩好食推介？",
    "💼 打工仔今日收幾點？",
    "🎬 有冇好戲推介？",
    "⚽ 球賽點睇？",
    "🎮 打機組隊唔該？",
    "☕ 邊度啡好飲？",
    "🏠 住邊區最正？"
];

function getRandomTopics(count = 3) {
    const shuffled = [...allTopics].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

// 健康檢查
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        online: io.sockets.sockets.size,
        waiting: waitingQueue.length,
        rooms: Array.from(io.sockets.adapter.rooms.keys())
            .filter(r => r.startsWith('room_')).length,
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

    console.log(`👤 用戶連線: ${socket.id} (總數: ${io.sockets.sockets.size})`);

    socket.on('start_chat', () => {
        if (waitingQueue.includes(socket.id)) {
            socket.emit('error', { msg: '你已經在等候隊列中' });
            return;
        }
        
        if (socket.roomId) {
            socket.emit('error', { msg: '你已經在聊天中，請先結束當前對話' });
            return;
        }
        
        if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();
            const partnerSocket = io.sockets.sockets.get(partnerId);
            
            if (partnerSocket && !partnerSocket.roomId) {
                const roomId = `room_${partnerId}_${socket.id}`;
                socket.join(roomId);
                partnerSocket.join(roomId);
                socket.roomId = roomId;
                partnerSocket.roomId = roomId;
                
                if (socket.queueTimeout) {
                    clearTimeout(socket.queueTimeout);
                    socket.queueTimeout = null;
                }
                if (partnerSocket.queueTimeout) {
                    clearTimeout(partnerSocket.queueTimeout);
                    partnerSocket.queueTimeout = null;
                }
                
                console.log(`✅ 配對成功: ${roomId}`);
                
                io.to(roomId).emit('matched', { 
                    roomId, 
                    topics: getRandomTopics() 
                });
            } else {
                waitingQueue.push(socket.id);
                socket.emit('waiting', { msg: '搵緊聊天對象...' });
                
                socket.queueTimeout = setTimeout(() => {
                    if (waitingQueue.includes(socket.id)) {
                        socket.emit('queue_timeout', {
                            msg: '等緊人配對中...再等陣啦',
                            waitingCount: waitingQueue.length
                        });
                    }
                }, 30000);
            }
        } else {
            waitingQueue.push(socket.id);
            socket.emit('waiting', { msg: '搵緊聊天對象...' });
            console.log(`⏳ ${socket.id} 加入隊列，當前等候: ${waitingQueue.length} 人`);
            
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

    socket.on('send_msg', (data) => {
        // ✅ 速率限制（每秒最多 5 則訊息）
        const now = Date.now();
        const userMessages = messageRateLimit.get(socket.id) || [];
        const recentMessages = userMessages.filter(time => now - time < 1000);
        
        if (recentMessages.length >= 5) {
            socket.emit('error', { msg: '發送太快，請稍候' });
            return;
        }
        
        recentMessages.push(now);
        messageRateLimit.set(socket.id, recentMessages);
        
        // 驗證訊息
        if (!data || !data.msg || typeof data.msg !== 'string') {
            socket.emit('error', { msg: '無效訊息格式' });
            return;
        }
        
        const cleanMsg = data.msg.trim();
        
        if (cleanMsg.length === 0) {
            socket.emit('error', { msg: '訊息不能為空' });
            return;
        }
        
        if (cleanMsg.length > 1000) {
            socket.emit('error', { msg: '訊息太長（最多1000字）' });
            return;
        }
        
        if (socket.roomId && socket.roomId === data.roomId) {
            socket.to(data.roomId).emit('receive_msg', {
                msg: cleanMsg,
                timestamp: Date.now()
            });
        } else {
            socket.emit('error', { msg: '你未在聊天室中' });
        }
    });

    socket.on('typing', () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_typing');
        }
    });

    socket.on('stop_typing', () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_stop_typing');
        }
    });

    socket.on('msg_read', () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_read');
        }
    });

    socket.on('end_chat', () => {
        if (!socket.roomId) {
            socket.emit('error', { msg: '你未在聊天室中' });
            return;
        }
        
        const roomId = socket.roomId;
        console.log(`👋 ${socket.id} 主動結束對話: ${roomId}`);
        
        socket.to(roomId).emit('partner_left', { msg: '對方已離開' });
        cleanupRoom(roomId);
        socket.emit('chat_ended', { msg: '對話已結束' });
    });

    socket.on('disconnect', () => {
        console.log(`❌ 用戶斷線: ${socket.id}`);
        
        // ✅ 清理速率限制記錄
        messageRateLimit.delete(socket.id);
        
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        
        if (socket.queueTimeout) {
            clearTimeout(socket.queueTimeout);
            socket.queueTimeout = null;
        }
        
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
                    if (s.queueTimeout) {
                        clearTimeout(s.queueTimeout);
                        s.queueTimeout = null;
                    }
                }
            });
        }
    } catch (err) {
        console.error('清理房間錯誤:', err);
    }
}

// ✅ 定期清理過期的速率限制記錄（每 5 分鐘）
setInterval(() => {
    const now = Date.now();
    for (const [socketId, messages] of messageRateLimit.entries()) {
        const recentMessages = messages.filter(time => now - time < 60000);
        if (recentMessages.length === 0) {
            messageRateLimit.delete(socketId);
        } else {
            messageRateLimit.set(socketId, recentMessages);
        }
    }
}, 300000);

setInterval(() => {
    const stats = {
        在線用戶: io.sockets.sockets.size,
        等候中: waitingQueue.length,
        活躍房間: Array.from(io.sockets.adapter.rooms.keys())
            .filter(r => r.startsWith('room_')).length
    };
    console.log('📊 當前統計:', stats);
}, 60000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 暖港野伺服器已啟動於 Port: ${PORT}`);
    console.log(`🌐 訪問地址: http://localhost:${PORT}`);
    console.log(`🔒 CORS: ${process.env.CORS_ORIGIN || "*"}`);
});