const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

let waitingQueue = [];

// 在這裡統一設定你想推送的「時事熱話」
const currentTopics = [
    "🔥 最近個單新聞點睇？",
    "🥢 呢排有咩好食推介？",
    "💼 打工仔今日收幾點？"
];

io.on('connection', (socket) => {
    socket.on('start_chat', () => {
        if (waitingQueue.includes(socket.id)) return;
        
        if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift();
            const partnerSocket = io.sockets.sockets.get(partnerId);
            
            if (partnerSocket) {
                const roomId = `room_${partnerId}_${socket.id}`;
                socket.join(roomId);
                partnerSocket.join(roomId);
                socket.roomId = roomId;
                partnerSocket.roomId = roomId;
                
                // 配對成功時，連同話題一併發送給前端
                io.to(roomId).emit('matched', { 
                    roomId, 
                    topics: currentTopics 
                });
            } else {
                waitingQueue.push(socket.id);
            }
        } else {
            waitingQueue.push(socket.id);
        }
    });

    socket.on('send_msg', (data) => {
        if (socket.roomId && socket.roomId === data.roomId) {
            socket.to(data.roomId).emit('receive_msg', data.msg);
        }
    });

    socket.on('typing', (data) => {
        if (socket.roomId) socket.to(socket.roomId).emit('partner_typing');
    });

    socket.on('stop_typing', (data) => {
        if (socket.roomId) socket.to(socket.roomId).emit('partner_stop_typing');
    });

    socket.on('msg_read', (data) => {
        if (socket.roomId) socket.to(socket.roomId).emit('partner_read');
    });

    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_left');
            // 強制讓留在房間的人 roomId 歸零，防止單方面繼續輸入
            const room = io.sockets.adapter.rooms.get(socket.roomId);
            if (room) {
                room.forEach(id => {
                    const s = io.sockets.sockets.get(id);
                    if (s) s.roomId = null;
                });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 暖港野伺服器已啟動於 Port: ${PORT}`);
});