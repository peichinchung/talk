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
        maxDisconnectionDuration: 5 * 60 * 1000,
        skipMiddlewares: true,
    },
    pingTimeout: 90000,
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
    if (io.sockets.sockets.size > MAX_CONNECTIONS) {
        socket.emit('error', { msg: '伺服器繁忙，請稍後再試' });
        socket.disconnect(true);
        return;
    }

    // ✅ 修正：恢復連線時同步完整狀態
    if (socket.recovered) {
        const recoveredRoom = socket.roomId || socket.data.roomId;
        console.log(`♻️ 用戶恢復連線: ${socket.id} (Room: ${recoveredRoom})`);
        
        if (recoveredRoom) {
            // 確保 socket 重新加入房間
            if (!socket.rooms.has(recoveredRoom)) {
                socket.join(recoveredRoom);
            }
            
            // 同步 roomId
            socket.roomId = recoveredRoom;
            socket.data.roomId = recoveredRoom;
            
            // 取消銷毀倒數
            if (roomDestructionTimers.has(recoveredRoom)) {
                clearTimeout(roomDestructionTimers.get(recoveredRoom));
                roomDestructionTimers.delete(recoveredRoom);
                console.log(`🛡️ 房間 ${recoveredRoom} 銷毀倒數已取消`);
            }
            
            // ✅ 通知雙方連線狀態
            socket.emit('connection_recovered', { 
                roomId: recoveredRoom,
                topics: getRandomTopics() // 重新提供話題
            });
            socket.to(recoveredRoom).emit('partner_status', { 
                status: 'online', 
                msg: '對方已重新連線' 
            });
        }
        return;
    }

    console.log(`👤 新用戶連線: ${socket.id}`);

    socket.on('start_chat', () => {
        // ✅ 清理舊房間和等待隊列
        if (socket.roomId) {
            const oldRoom = socket.roomId;
            socket.to(oldRoom).emit('partner_left', { msg: '對方已離開' });
            cleanupRoom(oldRoom);
        }
        
        // ✅ 從等待隊列移除（避免重複）
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        
        // ✅ 清理所有計時器
        if (socket.queueTimeout) {
            clearTimeout(socket.queueTimeout);
            socket.queueTimeout = null;
        }

        if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();
            const partnerSocket = io.sockets.sockets.get(partnerId);
            
            // ✅ 驗證 partner 仍然有效且未在房間中
            if (partnerSocket && partnerSocket.connected && !partnerSocket.roomId) {
                const roomId = `room_${partnerId}_${socket.id}`;
                socket.join(roomId);
                partnerSocket.join(roomId);
                
                socket.data.roomId = roomId;
                partnerSocket.data.roomId = roomId;
                socket.roomId = roomId;
                partnerSocket.roomId = roomId;
                
                // 清理雙方的等待計時器
                if (partnerSocket.queueTimeout) {
                    clearTimeout(partnerSocket.queueTimeout);
                    partnerSocket.queueTimeout = null;
                }
                
                io.to(roomId).emit('matched', { roomId, topics: getRandomTopics() });
                console.log(`✅ 配對成功: ${roomId}`);
            } else {
                // partner 無效，重新加入隊列
                waitingQueue.push(socket.id);
                socket.emit('waiting', { msg: '搵緊聊天對象...' });
                setupQueueTimeout(socket);
            }
        } else {
            waitingQueue.push(socket.id);
            socket.emit('waiting', { msg: '搵緊聊天對象...' });
            setupQueueTimeout(socket);
        }
    });

    // ✅ 提取為函數避免重複代碼
    function setupQueueTimeout(socket) {
        if (socket.queueTimeout) clearTimeout(socket.queueTimeout);
        socket.queueTimeout = setTimeout(() => {
            if (waitingQueue.includes(socket.id)) {
                socket.emit('queue_timeout', { 
                    msg: '等緊人配對中...再等陣啦', 
                    waitingCount: waitingQueue.length 
                });
            }
        }, 30000);
    }

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
        console.log(`👋 用戶斷線: ${socket.id}, 原因: ${reason}`);
        
        // ✅ 清理速率限制（延遲清理，給恢復連線機會）
        setTimeout(() => {
            if (!io.sockets.sockets.get(socket.id)) {
                messageRateLimit.delete(socket.id);
            }
        }, 60000);
        
        // ✅ 從等待隊列移除
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        
        // ✅ 清理等待計時器
        if (socket.queueTimeout) {
            clearTimeout(socket.queueTimeout);
            socket.queueTimeout = null;
        }
        
        const r = socket.roomId || socket.data.roomId;
        
        if (r) {
            // 通知對方
            socket.to(r).emit('partner_status', { 
                status: 'offline', 
                msg: '對方連線不穩，等待重連中...' 
            });

            // ✅ 只在沒有計時器時才設置（避免重複）
            if (!roomDestructionTimers.has(r)) {
                const timer = setTimeout(() => {
                    console.log(`⏰ 房間 ${r} 超時，開始清理`);
                    io.to(r).emit('partner_left', { msg: '對方已斷線離開' });
                    cleanupRoom(r);
                    roomDestructionTimers.delete(r);
                }, 120000);
                roomDestructionTimers.set(r, timer);
            }
        }
    });
});

function cleanupRoom(roomId) {
    console.log(`🧹 清理房間: ${roomId}`);
    
    // ✅ 取消銷毀計時器
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
                    if (s.data) s.data.roomId = null; // ✅ 確保清理 data
                    
                    // ✅ 清理等待計時器
                    if (s.queueTimeout) {
                        clearTimeout(s.queueTimeout);
                        s.queueTimeout = null;
                    }
                }
            });
        }
    } catch (err) {
        console.error('❌ Cleanup error:', err);
    }
}

// ✅ 改進清理任務
setInterval(() => {
    const now = Date.now();
    
    // 清理過期的速率限制記錄
    for (const [id, times] of messageRateLimit.entries()) {
        if (times.length === 0 || now - times[times.length - 1] > 60000) {
            messageRateLimit.delete(id);
        }
    }
    
    // ✅ 清理無效的等待隊列
    waitingQueue = waitingQueue.filter(id => {
        const socket = io.sockets.sockets.get(id);
        return socket && socket.connected;
    });
    
    console.log(`📊 清理完成 - 在線: ${io.sockets.sockets.size}, 等待: ${waitingQueue.length}, 房間: ${roomDestructionTimers.size}`);
}, 300000); // 5分鐘清理一次

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 暖港野伺服器啟動於 Port ${PORT}`);
});