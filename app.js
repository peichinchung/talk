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
            const roomId = "room_" + waitingUser.id + "_" + socket.id;
            
            socket.join(roomId);
            waitingUser.join(roomId);
            
            // 重要：雙向紀錄房間 ID
            socket.roomId = roomId;
            waitingUser.roomId = roomId;

            io.to(roomId).emit('matched', { roomId });
            
            console.log('成功配對！房間 ID:', roomId);
            waitingUser = null; // 配對完清空等待位
        } else {
            waitingUser = socket;
            console.log('用戶進入等待隊列');
        }
    });

    socket.on('send_msg', (data) => {
        socket.to(data.roomId).emit('receive_msg', data.msg);
    });

    socket.on('disconnect', () => {
        console.log('用戶斷開連線');
        
        // 如果是正在排隊的人斷開，清空等待位
        if (waitingUser && waitingUser.id === socket.id) {
            waitingUser = null;
        }
        
        // 如果是在聊天中的人斷開
        if (socket.roomId) {
            // 通知對方
            socket.to(socket.roomId).emit('partner_left');
            // 清除紀錄避免錯誤
            socket.roomId = null;
        }
    });
}); // <--- 剛才你漏掉的是這個括號

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 聊天伺服器已在端口 ${PORT} 啟動`);
});