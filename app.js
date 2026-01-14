const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

let waitingQueue = [];

// 統一設定「時事熱話」
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

// 隨機抽取話題
function getRandomTopics(count = 3) {
    const shuffled = [...allTopics].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

io.on('connection', (socket) => {
    console.log(`👤 用戶連線: ${socket.id}`);

    // 開始配對
    socket.on('start_chat', () => {
        // 1️⃣ 防止重複加入隊列
        if (waitingQueue.includes(socket.id)) {
            socket.emit('error', { msg: '你已經在等候隊列中' });
            return;
        }
        
        // 2️⃣ 防止已配對的人再配對
        if (socket.roomId) {
            socket.emit('error', { msg: '你已經在聊天中，請先結束當前對話' });
            return;
        }
        
        if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();
            const partnerSocket = io.sockets.sockets.get(partnerId);
            
            if (partnerSocket && !partnerSocket.roomId) {
                // 配對成功
                const roomId = `room_${partnerId}_${socket.id}`;
                socket.join(roomId);
                partnerSocket.join(roomId);
                socket.roomId = roomId;
                partnerSocket.roomId = roomId;
                
                // 清除超時計時器
                if (socket.queueTimeout) {
                    clearTimeout(socket.queueTimeout);
                    socket.queueTimeout = null;
                }
                if (partnerSocket.queueTimeout) {
                    clearTimeout(partnerSocket.queueTimeout);
                    partnerSocket.queueTimeout = null;
                }
                
                console.log(`✅ 配對成功: ${roomId}`);
                
                // 發送配對成功通知 + 隨機話題
                io.to(roomId).emit('matched', { 
                    roomId, 
                    topics: getRandomTopics() 
                });
            } else {
                // 對方已斷線或已配對，重新入隊
                waitingQueue.push(socket.id);
                socket.emit('waiting', { msg: '搵緊聊天對象...' });
                
                // 設定超時提醒（30秒）
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
            // 加入等候隊列
            waitingQueue.push(socket.id);
            socket.emit('waiting', { msg: '搵緊聊天對象...' });
            console.log(`⏳ ${socket.id} 加入隊列，當前等候: ${waitingQueue.length} 人`);
            
            // 設定超時提醒
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

    // 發送訊息
    socket.on('send_msg', (data) => {
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

    // 打字中
    socket.on('typing', () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_typing');
        }
    });

    // 停止打字
    socket.on('stop_typing', () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_stop_typing');
        }
    });

    // 已讀
    socket.on('msg_read', () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_read');
        }
    });

    // 結束聊天
    socket.on('end_chat', () => {
        if (!socket.roomId) {
            socket.emit('error', { msg: '你未在聊天室中' });
            return;
        }
        
        const roomId = socket.roomId;
        console.log(`👋 ${socket.id} 主動結束對話: ${roomId}`);
        
        // 通知對方
        socket.to(roomId).emit('partner_left', { msg: '對方已離開' });
        
        // 清理房間
        cleanupRoom(roomId);
        
        socket.emit('chat_ended', { msg: '對話已結束' });
    });

    // 斷線處理
    socket.on('disconnect', () => {
        console.log(`❌ 用戶斷線: ${socket.id}`);
        
        // 從等候隊列移除
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        
        // 清除超時計時器
        if (socket.queueTimeout) {
            clearTimeout(socket.queueTimeout);
            socket.queueTimeout = null;
        }
        
        // 如果在聊天室中，通知對方
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_left', { msg: '對方已離開' });
            cleanupRoom(socket.roomId);
        }
    });
});

// 清理房間函數
function cleanupRoom(roomId) {
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
}

// 定期統計（每分鐘）
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
});