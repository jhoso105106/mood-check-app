const express = require('express');
const sql = require('mssql');
require('dotenv').config();
const cors = require('cors'); // ←追加
const axios = require('axios'); // OpenAI呼び出し用

const app = express();
app.use(cors()); // ←追加
app.use(express.json());

const sqlConfig = {
    user: process.env.AZURE_SQL_USER,
    password: process.env.AZURE_SQL_PASSWORD,
    database: process.env.AZURE_SQL_DATABASE,
    server: process.env.AZURE_SQL_SERVER,
    options: { encrypt: true, trustServerCertificate: false }
};

// チャット履歴取得
app.get('/api/chat-history', async (req, res) => {
    try {
        await sql.connect(sqlConfig);
        const result = await sql.query`SELECT * FROM mood_history ORDER BY timestamp`;
        res.json({ history: result.recordset });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// チャット送信＆AI応答
app.post('/api/chat', async (req, res) => {
    const { user_input } = req.body;
    const timestamp = new Date();
    let ai_response = '';
    let mood = '';

    try {
        // Azure OpenAI API呼び出し
        const openaiRes = await axios.post(
            `${process.env.OPENAI_ENDPOINT}/openai/deployments/gpt-35-turbo/chat/completions?api-version=2023-05-15`,
            {
                messages: [
                    { role: 'system', content: 'あなたは親切なAIチャットボットです。' },
                    { role: 'user', content: user_input }
                ],
                max_tokens: 256,
                temperature: 0.7
            },
            {
                headers: {
                    'api-key': process.env.OPENAI_API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );
        ai_response = openaiRes.data.choices[0].message.content;
        mood = 'AI'; // moodは仮でAIとする（必要なら感情分析APIも併用可）

        await sql.connect(sqlConfig);
        await sql.query`
            INSERT INTO mood_history (user_input, mood, timestamp)
            VALUES (${user_input}, ${mood}, ${timestamp})
        `;
        await sql.query`
            INSERT INTO mood_history (user_input, mood, timestamp)
            VALUES (${ai_response}, 'assistant', ${timestamp})
        `;
        res.json({ user_input, ai_response, timestamp });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/', (req, res) => {
    res.send('Chat APIサーバー稼働中です。エンドポイント: /api/chat, /api/chat-history');
});

app.listen(3001, () => console.log('Chat server started on port 3001'));