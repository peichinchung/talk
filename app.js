const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http, {
    cors: { 
        origin: process.env.NODE_ENV === 'production' 
            ? ["https://yourdomain.com"] 
            : "*", 
        methods: ["GET", "POST"] 
    }
});

app.use(express.static('public'));

let waitingQueue = [];
const MAX_CONNECTIONS = 1000;

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

function getRandomTopics(count = 3) {
    const shuffled = [...allTopics].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}

// 健康檢查
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        online: io.sockets.sockets.size,