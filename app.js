const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// 指定靜態檔案資料夾
app.use(express.static('public'));

let waitingUser = null;

io.on('connection', (socket) => {
    console.log('一位用戶連線中...');

    // 處理配對請求
    socket.on('start_chat', () => {
        if (waitingUser && waitingUser.id !== socket.id) {
            // 成功配對：建立唯一房間 ID
            const roomId = "room_" + waitingUser.id + "_" + socket.id;
            
            socket.join(roomId);
            waitingUser.join(roomId);
            
            // 雙向紀錄房間資訊
            socket.roomId = roomId;
            waitingUser.roomId = roomId;

            io.to(roomId).emit('matched', { roomId });
            
            console.log('成功配對！房間 ID:', roomId);
            waitingUser = null; 
        } else {
            // 進入排隊
            waitingUser = socket;
            console.log('用戶進入等待隊列');
        }
    });

    // 處理訊息傳送
    socket.on('send_msg', (data) => {
        socket.to(data.roomId).emit('receive_msg', data.msg);
    });

    // 處理斷線
    socket.on('disconnect', () => {
        console.log('用戶斷開連線');
        
        if (waitingUser && waitingUser.id === socket.id) {
            waitingUser = null;
        }
        
        if (socket.roomId) {
            // 通知房間內的另一方
            socket.to(socket.roomId).emit('partner_left');
            socket.roomId = null;
        }
    });
});

// 監聽 Port（Render 專用設定）
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 伺服器已在端口 ${PORT} 啟動`);
});