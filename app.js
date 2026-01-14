const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 30000,
    pingInterval: 10000
});

app.use(express.static('public'));

let waitingQueue = [];
const MAX_CONNECTIONS = 1000;
const messageRateLimit = new Map(); // 訊息速率限制記錄

// 2026 時事熱話庫（可隨時修改）
const allTopics = [
    "🔥 最近個單新聞點睇？",
    "🥢 呢排有咩好食推介？",
    "💼 打工仔今日收幾點？",
    "🎬 有冇好戲推介？",
    "⚽ 球賽點睇？",
    "🎮 打機組隊唔該？",
    "☕ 邊度啡好飲？",
    "🏠 住邊區最正？",
    "💡 2026 年有無咩新大計？"
];

// 隨機抽選 3 個話題
function getRandomTopics(count = 3) {
    const shuffled = [...allTopics].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

// 健康檢查接口
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
    // 總連線數限制
    if (io.sockets.sockets.size > MAX_CONNECTIONS) {
        socket.emit('error', { msg: '伺服器繁忙，請稍後再試' });
        socket.disconnect(true);
        return;
    }

    console.log(`👤 用戶連線: ${socket.id} (總數: ${io.sockets.sockets.size})`);

    socket.on('start_chat', () => {
        // 防止重複加入排隊
        if (waitingQueue.includes(socket.id)) {
            socket.emit('error', { msg: '你已經在等候隊列中' });
            return;
        }
        
        // 防止已在聊天中卻重新開始
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
                
                // 清除排隊超時計時器
                if (socket.queueTimeout) { clearTimeout(socket.queueTimeout); socket.queueTimeout = null; }
                if (partnerSocket.queueTimeout) { clearTimeout(partnerSocket.queueTimeout); partnerSocket.queueTimeout = null; }
                
                console.log(`✅ 配對成功: ${roomId}`);
                
                // 發送配對成功訊息與隨機話題
                io.to(roomId).emit('matched', { 
                    roomId, 
                    topics: getRandomTopics() 
                });
            } else {
                // 如果取出的人已經斷線或出錯，重新將自己加入隊列
                waitingQueue.push(socket.id);
                socket.emit('waiting', { msg: '搵緊聊天對象...' });
            }
        } else {
            waitingQueue.push(socket.id);
            socket.emit('waiting', { msg: '搵緊聊天對象...' });
            console.log(`⏳ ${socket.id} 加入隊列，當前等候: ${waitingQueue.length} 人`);
            
            // 30 秒後若還沒配對到，發送提醒
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
        // 速率限制：每秒最多 5 則訊息
        const now = Date.now();
        const userMessages = messageRateLimit.get(socket.id) || [];
        const recentMessages = userMessages.filter(time => now - time < 1000);
        
        if (recentMessages.length >= 5) {
            socket.emit('error', { msg: '發送太快，請稍候' });
            return;
        }
        
        recentMessages.push(now);
        messageRateLimit.set(socket.id, recentMessages);
        
        // 訊息合法性檢查
        if (!data || !data.msg || typeof data.msg !== 'string') return;
        
        const cleanMsg = data.msg.trim();
        if (cleanMsg.length === 0 || cleanMsg.length > 1000) return;
        
        // 轉發訊息
        if (socket.roomId && socket.roomId === data.roomId) {
            socket.to(data.roomId).emit('receive_msg', {
                msg: cleanMsg,
                timestamp: Date.now()
            });
        }
    });

    // 打字與已讀狀態轉發
    socket.on('typing', () => {
        if (socket.roomId) socket.to(socket.roomId).emit('partner_typing');
    });

    socket.on('stop_typing', () => {
        if (socket.roomId) socket.to(socket.roomId).emit('partner_stop_typing');
    });

    socket.on('msg_read', () => {
        if (socket.roomId) socket.to(socket.roomId).emit('partner_read');
    });

    // 主動結束對話
    socket.on('end_chat', () => {
        if (!socket.roomId) return;
        
        const roomId = socket.roomId;
        socket.to(roomId).emit('partner_left', { msg: '對方已離開' });
        cleanupRoom(roomId);
        socket.emit('chat_ended', { msg: '對話已結束' });
    });

    socket.on('disconnect', () => {
        console.log(`❌ 用戶斷線: ${socket.id}`);
        messageRateLimit.delete(socket.id); // 清理速率限制紀錄
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        
        if (socket.queueTimeout) { clearTimeout(socket.queueTimeout); }
        
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_left', { msg: '對方已離開' });
            cleanupRoom(socket.roomId);
        }
    });
});

// 清理房間邏輯
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

// 定期清理速率限制紀錄（每 5 分鐘）
setInterval(() => {
    const now = Date.now();
    for (const [id, times] of messageRateLimit.entries()) {
        if (times.length === 0 || now - times[times.length - 1] > 60000) {
            messageRateLimit.delete(id);
        }
    }
}, 300000);

// 每分鐘在後台 Log 打印統計數據
setInterval(() => {
    console.log('📊 當前統計:', {
        在線: io.sockets.sockets.size,
        等待隊列: waitingQueue.length,
        活躍房間: Array.from(io.sockets.adapter.rooms.keys()).filter(r => r.startsWith('room_')).length
    });
}, 60000);

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 暖港野伺服器啟動於 Port ${PORT}`);
});