const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

// 這行最重要：它會讓伺服器去讀取 public 資料夾裡的 index.html
app.use(express.static('public')); 

let waitingUser = null; 

io.on('connection', (socket) => {
    console.log('一位用戶連線中...');

    socket.on('start_chat', () => {
        if (waitingUser && waitingUser.id !== socket.id) {
            // 配對成功
            const roomId = waitingUser.id + socket.id;
            socket.join(roomId);
            waitingUser.join(roomId);
            io.to(roomId).emit('matched', { roomId });
            waitingUser = null;
            console.log('成功配對一對用戶！');
        } else {
            // 進入等待
            waitingUser = socket;
            console.log('有一位用戶正在等待配對...');
        }
    });

    socket.on('send_msg', (data) => {
        socket.to(data.roomId).emit('receive_msg', data.msg);
    });

    socket.on('disconnect', () => {
        if (waitingUser === socket) waitingUser = null;
    });
});

// 監聽 3000 端口
http.listen(3000, '0.0.0.0', () => {
    console.log('✅ 聊天系統已就緒！');
    console.log('電腦請訪問: http://localhost:3000');
});