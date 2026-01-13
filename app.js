const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

let waitingUser = null;

io.on('connection', (socket) => {
    console.log('一位用戶連線中...');

    socket.on('start_chat', () => {
        // 如果有人在等，且不是自己
        if (waitingUser && waitingUser.id !== socket.id) {
            const roomId = waitingUser.id + socket.id;
            
            // 讓兩個人加入房間
            socket.join(roomId);
            waitingUser.join(roomId);
            
            // 紀錄房間 ID 方便斷線時通知
            socket.roomId = roomId;
            waitingUser.roomId = roomId;

            io.to(roomId).emit('matched', { roomId });
            waitingUser = null;
            console.log('成功配對！房間 ID:', roomId);
        } else {
            waitingUser = socket;
            console.log('用戶進入等待隊列');
        }
    });

    socket.on('send_msg', (data) => {
        // 發送訊息給房間內的另一人
        socket.to(data.roomId).emit('receive_msg', data.msg);
    });

    socket.on('disconnect', () => {
        console.log('用戶斷開連線');
        if (waitingUser === socket) {
            waitingUser = null;
        }
        // 如果在聊天中斷開，通知對方
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_left');
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 聊天伺服器已在端口 ${PORT} 啟動`);
});