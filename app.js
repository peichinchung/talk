const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

let waitingQueue = [];

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
                io.to(roomId).emit('matched', { roomId });
            } else {
                waitingQueue.push(socket.id);
            }
        } else {
            waitingQueue.push(socket.id);
        }
    });

    socket.on('send_msg', (data) => {
        if (socket.roomId === data.roomId) {
            socket.to(data.roomId).emit('receive_msg', data.msg);
        }
    });

    socket.on('typing', (data) => {
        socket.to(data.roomId).emit('partner_typing');
    });

    socket.on('stop_typing', (data) => {
        socket.to(data.roomId).emit('partner_stop_typing');
    });

    socket.on('msg_read', (data) => {
        socket.to(data.roomId).emit('partner_read');
    });

    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_left');
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 暖港野伺服器啟動於 Port ${PORT}`);
});