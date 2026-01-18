const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 10000, 
    pingInterval: 15000, 
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));

// --- 資料結構 ---
let waitingQueue = [];
const userSessions = new Map(); // userId -> { roomId, socketId, disconnectTimer, softDisconnectTimer }
const rooms = new Map(); // roomId -> Set(userId)

// --- 配置參數 ---
const DISCONNECT_GRACE_PERIOD = 5 * 60 * 1000; // 5分鐘
const SOFT_DISCONNECT_DELAY = 10 * 1000; // 10秒
const IDLE_SESSION_CLEANUP = 30 * 1000; // 30秒

const allTopics = [
    "🥢 邊度有好嘢食？", "🎬 有冇好戲推介？", "🎮 打機組隊？", 
    "📸 週末去邊玩？", "💼 返工有無趣事？", "👻 講個鬼故黎聽下？"
];

function getRandomTopics() {
    return [...allTopics].sort(() => 0.5 - Math.random()).slice(0, 3);
}

// --- 中間件：身份驗證 ---
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication error"));
    socket.userId = token;
    next();
});

// --- 定期清理等待隊列 ---
setInterval(() => {
    const before = waitingQueue.length;
    
    waitingQueue = waitingQueue.filter(id => {
        const session = userSessions.get(id);
        if (!session) return false;
        
        const socket = io.sockets.sockets.get(session.socketId);
        return socket && socket.connected && !session.roomId;
    });
    
    const after = waitingQueue.length;
    if (before !== after) {
        console.log(`🧹 清理等待隊列: ${before} → ${after}`);
    }
}, 30000);

io.on('connection', (socket) => {
    const userId = socket.userId;
    console.log(`🔗 連線: ${userId} (${socket.id})`);

    // ♻️ [重連機制] 檢查是否為斷線重連的用戶
    if (userSessions.has(userId)) {
        const session = userSessions.get(userId);
        
        // 更新新的 Socket ID
        session.socketId = socket.id;
        
        // 清理所有待執行的 timer
        if (session.disconnectTimer) {
            clearTimeout(session.disconnectTimer);
            session.disconnectTimer = null;
        }
        if (session.softDisconnectTimer) {
            clearTimeout(session.softDisconnectTimer);
            session.softDisconnectTimer = null;
        }
        
        console.log(`✨ 用戶 ${userId} 重連成功`);

        // 如果在房間內
        if (session.roomId) {
            const roomUsers = rooms.get(session.roomId);
            
            if (roomUsers && roomUsers.has(userId)) {
                // 房間還在，重新加入
                socket.join(session.roomId);
                socket.roomId = session.roomId;
                
                socket.emit('connection_recovered', { 
                    roomId: session.roomId,
                    msg: '已重新連線到對話 ✅' 
                });
                
                // 檢查對方是否在線
                const partner = Array.from(roomUsers).find(id => id !== userId);
                if (partner) {
                    const partnerSession = userSessions.get(partner);
                    const partnerSocket = io.sockets.sockets.get(partnerSession?.socketId);
                    
                    if (partnerSocket?.connected) {
                        // 🔧 FIX: 清除對方可能還在等待的 softDisconnectTimer
                        if (partnerSession?.softDisconnectTimer) {
                            clearTimeout(partnerSession.softDisconnectTimer);
                            partnerSession.softDisconnectTimer = null;
                        }
                        
                        socket.to(session.roomId).emit('partner_status', { 
                            status: 'online', 
                            msg: '對方已重新連線 ✅' 
                        });
                    } else {
                        socket.emit('partner_status', { 
                            status: 'reconnecting', 
                            msg: '對方連線中斷，等待重連... ⏳' 
                        });
                    }
                }
            } else {
                // 房間已不存在
                session.roomId = null;
                socket.emit('room_closed', { 
                    msg: '對方已離開，房間已關閉' 
                });
            }
        }
        
        userSessions.set(userId, session);
    } else {
        // 新用戶初始化
        userSessions.set(userId, { 
            roomId: null, 
            socketId: socket.id, 
            disconnectTimer: null,
            softDisconnectTimer: null 
        });
    }

    // --- 配對邏輯 (完整加強版) ---
    socket.on('start_chat', () => {
        let session = userSessions.get(userId); // 🔧 FIX: 改用 let 以便重新取得
        
        if (!session) {
            socket.emit('error', { msg: '會話無效，請重新整理' });
            return;
        }

        // 如果已經在房間，先離開
        if (session.roomId) {
            socket.to(session.roomId).emit('partner_left', { 
                msg: '對方已離開尋找新對象' 
            });
            leaveRoom(userId, session.roomId);
            session = userSessions.get(userId); // 🔧 FIX: 重新取得 session
        }

        // 清理自己在等待隊列的所有舊紀錄
        waitingQueue = waitingQueue.filter(id => id !== userId);

        // 嘗試配對
        let partnerId = null;
        let attempts = 0;
        const maxAttempts = waitingQueue.length;

        while (attempts < maxAttempts && waitingQueue.length > 0) {
            const candidateId = waitingQueue.shift();
            attempts++;

            // 不能配對到自己
            if (candidateId === userId) {
                console.warn(`⚠️ 隊列中發現自己 ${userId}，跳過`);
                continue;
            }

            const candidateSession = userSessions.get(candidateId);
            
            // 檢查 session 是否存在
            if (!candidateSession) {
                console.warn(`⚠️ ${candidateId} session 不存在，跳過`);
                continue;
            }

            // 檢查是否已在其他房間
            if (candidateSession.roomId) {
                console.warn(`⚠️ ${candidateId} 已在房間，跳過`);
                continue;
            }

            // 檢查 socket 是否真的連線
            const candidateSocket = io.sockets.sockets.get(candidateSession.socketId);
            if (!candidateSocket || !candidateSocket.connected) {
                console.warn(`⚠️ ${candidateId} socket 未連線，跳過`);
                continue;
            }

            // ✅ 找到有效的配對對象
            partnerId = candidateId;
            break;
        }

        // 執行配對或進入等待
        if (partnerId) {
            const partnerSession = userSessions.get(partnerId);
            const partnerSocket = io.sockets.sockets.get(partnerSession.socketId);
            
            // 生成房間 ID
            const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            
            // 先設定狀態（防止 race condition）
            session.roomId = roomId;
            partnerSession.roomId = roomId;
            
            // 雙方加入房間
            socket.join(roomId);
            socket.roomId = roomId;
            
            partnerSocket.join(roomId);
            partnerSocket.roomId = roomId;
            
            // 記錄房間成員
            rooms.set(roomId, new Set([userId, partnerId]));
            
            // 發送配對成功訊息
            const topics = getRandomTopics();
            io.to(roomId).emit('matched', { 
                roomId, 
                topics,
                msg: '配對成功！開始聊天吧 🎉' 
            });
            
            console.log(`✅ 配對成功: ${userId} ↔ ${partnerId} (房間: ${roomId})`);
            
        } else {
            // 沒找到人，進入等待隊列
            if (!waitingQueue.includes(userId)) {
                waitingQueue.push(userId);
                console.log(`⏳ ${userId} 進入等待隊列 (目前: ${waitingQueue.length} 人)`);
            }
            
            socket.emit('waiting', { 
                msg: '搵緊聊天對象...',
                queuePosition: waitingQueue.length 
            });
        }
    });

    // --- 發送訊息 ---
    // 🔧 FIX: 加強檢查房間是否存在
    socket.on('send_msg', (data, callback) => {
        const session = userSessions.get(userId);
        
        if (!session || !session.roomId) {
            if (callback) callback({ status: 'error', msg: '你不在房間內' });
            return;
        }

        // 🔧 FIX: 檢查房間是否還存在且有效
        const roomUsers = rooms.get(session.roomId);
        if (!roomUsers || roomUsers.size < 2) {
            if (callback) callback({ status: 'error', msg: '對方已離開' });
            // 清理自己的狀態
            session.roomId = null;
            socket.emit('partner_left', { msg: '對方已離開' });
            return;
        }

        socket.to(session.roomId).emit('receive_msg', { msg: data.msg });
        
        if (callback) callback({ status: 'ok' });
    });

    // --- 已讀回報 ---
    // 🔧 FIX: 檢查房間是否存在
    socket.on('msg_read', () => {
        const session = userSessions.get(userId);
        if (session?.roomId && rooms.has(session.roomId)) {
            socket.to(session.roomId).emit('partner_read');
        }
    });

    // 🔧 FIX: 檢查房間是否存在
    socket.on('typing', () => {
        const s = userSessions.get(userId);
        if (s?.roomId && rooms.has(s.roomId)) {
            socket.to(s.roomId).emit('partner_typing');
        }
    });

    // 🔧 FIX: 檢查房間是否存在
    socket.on('stop_typing', () => {
        const s = userSessions.get(userId);
        if (s?.roomId && rooms.has(s.roomId)) {
            socket.to(s.roomId).emit('partner_stop_typing');
        }
    });

    // --- 主動離開 ---
    socket.on('end_chat', () => {
        const session = userSessions.get(userId);
        if (!session?.roomId) return;
        
        // 清理所有 timer
        if (session.disconnectTimer) {
            clearTimeout(session.disconnectTimer);
            session.disconnectTimer = null;
        }
        if (session.softDisconnectTimer) {
            clearTimeout(session.softDisconnectTimer);
            session.softDisconnectTimer = null;
        }
        
        socket.to(session.roomId).emit('partner_left', { 
            msg: '對方已主動離開' 
        });
        
        leaveRoom(userId, session.roomId);
        socket.emit('chat_ended', { msg: '對話已結束' });
    });

    // --- 斷線處理 (最關鍵) ---
    // 🔧 FIX: 加強 session 檢查
    socket.on('disconnect', (reason) => {
        console.log(`❌ 斷線: ${userId} (${reason})`);
        
        // 從等待隊列移除
        waitingQueue = waitingQueue.filter(id => id !== userId);

        const session = userSessions.get(userId);
        
        // 🔧 FIX: 如果 session 不存在直接返回
        if (!session) {
            console.warn(`⚠️ 斷線時找不到 session: ${userId}`);
            return;
        }
        
        // 清理舊的 timer
        if (session.disconnectTimer) {
            clearTimeout(session.disconnectTimer);
            session.disconnectTimer = null;
        }
        if (session.softDisconnectTimer) {
            clearTimeout(session.softDisconnectTimer);
            session.softDisconnectTimer = null;
        }

        if (session.roomId) {
            // 先不通知，給 10 秒緩衝
            session.softDisconnectTimer = setTimeout(() => {
                const currentSession = userSessions.get(userId);
                const currentSocket = io.sockets.sockets.get(currentSession?.socketId);
                
                if (currentSession?.roomId && !currentSocket?.connected) {
                    io.to(currentSession.roomId).emit('partner_status', { 
                        status: 'reconnecting', 
                        msg: '對方連線不穩，等待重連中... ⏳' 
                    });
                }
            }, SOFT_DISCONNECT_DELAY);

            // 設定 5 分鐘寬限期
            session.disconnectTimer = setTimeout(() => {
                console.log(`💀 用戶 ${userId} 超時未歸，視為離開`);
                
                const currentSession = userSessions.get(userId);
                if (currentSession?.roomId) {
                    io.to(currentSession.roomId).emit('partner_left', { 
                        msg: '對方已離開（逾時未重連）' 
                    });
                    
                    leaveRoom(userId, currentSession.roomId);
                }
                
                userSessions.delete(userId);
            }, DISCONNECT_GRACE_PERIOD);
            
        } else {
            // 不在房間，30秒後清理
            session.disconnectTimer = setTimeout(() => {
                userSessions.delete(userId);
            }, IDLE_SESSION_CLEANUP);
        }
    });
});

// 🔧 FIX: 完整修正 leaveRoom 函數
function leaveRoom(userId, roomId) {
    const roomUsers = rooms.get(roomId);
    if (roomUsers) {
        roomUsers.delete(userId);
        
        // 如果房間只剩一人
        if (roomUsers.size === 1) {
            const remainingUser = Array.from(roomUsers)[0];
            const remainingSession = userSessions.get(remainingUser);
            if (remainingSession) {
                remainingSession.roomId = null;
                // 🔧 FIX: 讓剩餘用戶也離開房間
                const remainingSocket = io.sockets.sockets.get(remainingSession.socketId);
                if (remainingSocket) {
                    remainingSocket.leave(roomId);
                }
            }
            // 🔧 FIX: 清理空房間
            rooms.delete(roomId);
        }
        
        // 如果房間完全空了
        if (roomUsers.size === 0) {
            rooms.delete(roomId);
        }
    }
    
    const session = userSessions.get(userId);
    if (session) {
        const sock = io.sockets.sockets.get(session.socketId);
        if (sock) sock.leave(roomId);
        session.roomId = null;
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ 伺服器啟動於 Port ${PORT}`);
});