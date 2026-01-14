const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 指定靜態檔案資料夾（前端 index.html 放在 public 資料夾內）
app.use(express.static('public'));

// 等待配對的用戶隊列
let waitingQueue = [];

io.on('connection', (socket) => {
    console.log(`用戶連線: ${socket.id}`);

    // 1. 處理配對請求
    socket.on('start_chat', () => {
        // 防止用戶重複加入隊列
        if (waitingQueue.includes(socket.id)) return;

        // 如果隊列中有其他人
        if (waitingQueue.length > 0) {
            const partnerId = waitingQueue.shift(); // 取出第一位等待者
            const partnerSocket = io.sockets.sockets.get(partnerId);

            if (partnerSocket) {
                // 建立唯一的房間 ID
                const roomId = `room_${partnerId}_${socket.id}`;
                
                socket.join(roomId);
                partnerSocket.join(roomId);
                
                // 互相綁定房間資訊，方便斷線處理
                socket.roomId = roomId;
                partnerSocket.roomId = roomId;

                // 告訴雙方配對成功
                io.to(roomId).emit('matched', { roomId });
                console.log(`成功配對房間: ${roomId}`);
            } else {
                // 如果對方已離線，自己進入等待
                waitingQueue.push(socket.id);
            }
        } else {
            // 隊列沒人，進入等待
            waitingQueue.push(socket.id);
            console.log(`用戶 ${socket.id} 進入等待隊列`);
        }
    });

    // 2. 處理訊息傳送
    socket.on('send_msg', (data) => {
        // 安全檢查：發送者必須在該房間內
        if (socket.roomId === data.roomId) {
            socket.to(data.roomId).emit('receive_msg', data.msg);
        }
    });

    // 3. 處理廣東話打字狀態
    socket.on('typing', (data) => {
        if (socket.roomId === data.roomId) {
            socket.to(data.roomId).emit('partner_typing');
        }
    });

    socket.on('stop_typing', (data) => {
        if (socket.roomId === data.roomId) {
            socket.to(data.roomId).emit('partner_stop_typing');
        }
    });

    // 4. 處理已讀功能
    socket.on('msg_read', (data) => {
        if (socket.roomId === data.roomId) {
            socket.to(data.roomId).emit('partner_read');
        }
    });

    // 5. 處理斷線
    socket.on('disconnect', () => {
        console.log(`用戶斷開: ${socket.id}`);
        
        // 從等待隊列中移除
        waitingQueue = waitingQueue.filter(id => id !== socket.id);
        
        // 如果正在對話中，通知對方
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_left');
            
            // 讓另一位用戶也退出該房間，清空房間狀態
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

// 監聽 Port（Render 專用設定）
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 暖港野伺服器啟動成功！Port: ${PORT}`);
});