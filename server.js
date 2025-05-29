require('dotenv').config();

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const sql = require('mssql');
const cors = require('cors');
const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.use(cors());

// 環境変数まとめて取得
const {
    AZURE_API_KEY,
    AZURE_ENDPOINT,
    AZURE_SQL_USER,
    AZURE_SQL_PASSWORD,
    AZURE_SQL_DATABASE,
    AZURE_SQL_SERVER,
    PORT
} = process.env;

const sqlConfig = {
    user: AZURE_SQL_USER,
    password: AZURE_SQL_PASSWORD,
    database: AZURE_SQL_DATABASE,
    server: AZURE_SQL_SERVER,
    options: {
        encrypt: true,
        trustServerCertificate: false
    }
};

// 共通エラーハンドラ
function handleError(res, message, err, status = 500) {
    console.error(message, err);
    res.status(status).json({ error: message, detail: err?.message || err });
}

// ルートでindex.htmlを返す
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Azure Language Service 要約API
async function analyzeTextWithAzure(answers) {
    const endpoint = AZURE_ENDPOINT + '/language/analyze-text/jobs?api-version=2023-04-01';
    const body = {
        displayName: 'MoodCheckSummary',
        analysisInput: {
            documents: [
                {
                    id: '1',
                    language: 'ja',
                    text: answers.join('\n')
                }
            ]
        },
        tasks: [
            {
                kind: 'AbstractiveSummarization',
                parameters: { sentenceCount: 2 }
            }
        ]
    };
    // ジョブ作成
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Ocp-Apim-Subscription-Key': AZURE_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        throw new Error(await response.text());
    }
    const operationLocation = response.headers.get('operation-location');
    if (!operationLocation) throw new Error('operation-locationヘッダーがありません');
    // ポーリング
    let result;
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const pollRes = await fetch(operationLocation, {
            headers: { 'Ocp-Apim-Subscription-Key': AZURE_API_KEY }
        });
        const pollData = await pollRes.json();
        if (pollData.status === 'succeeded') {
            result = pollData;
            break;
        } else if (pollData.status === 'failed') {
            throw new Error('要約ジョブが失敗: ' + JSON.stringify(pollData));
        }
    }
    if (!result) throw new Error('要約ジョブがタイムアウトしました');
    // 要約抽出
    const task = result.tasks.items[0];
    const summary = task?.results?.documents?.[0]?.summaries?.[0]?.text || '要約が取得できませんでした。';
    return summary;
}

// ポジネガ判定・アドバイス
function getSentimentAndAdvice(summary) {
    if (/元気|楽しい|良い|前向き|充実|嬉しい|幸せ|笑顔|順調|感謝|満足|穏やか|ポジティブ/.test(summary)) {
        return { sentiment: 'positive', advice: 'この調子で自分のペースを大切に過ごしましょう！' };
    } else if (/疲れ|ストレス|不安|落ち込|つらい|悩み|心配|イライラ|ネガティブ|困難|孤独|眠れない|体調不良|悲しい/.test(summary)) {
        return { sentiment: 'negative', advice: '無理せず、休息やリフレッシュの時間を意識してみてください。誰かに話すのもおすすめです。' };
    } else {
        return { sentiment: 'neutral', advice: '大きな波はなさそうです。自分のペースで過ごしましょう。' };
    }
}

app.post('/api/azure-language', async (req, res) => {
    try {
        const { answers } = req.body;
        const summary = await analyzeTextWithAzure(answers);
        const { sentiment, advice } = getSentimentAndAdvice(summary);
        res.json({ result: summary, sentiment, advice });
    } catch (e) {
        handleError(res, 'Azure Language Serviceエラー', e);
    }
});

// DB保存
app.post('/api/save-history', async (req, res) => {
    const { name, date, time, score, summary, advice } = req.body;
    try {
        await sql.connect(sqlConfig);
        await sql.query`
            INSERT INTO mood_history (name, date, time, score, summary, advice)
            VALUES (${name}, ${date}, ${time}, ${score}, ${summary}, ${advice})
        `;
        res.json({ success: true });
    } catch (err) {
        handleError(res, 'DB保存に失敗しました', err);
    }
});

// 履歴取得
app.get('/api/get-history', async (req, res) => {
    try {
        await sql.connect(sqlConfig);
        const { name } = req.query;
        let result;
        if (name) {
            result = await sql.query`SELECT * FROM mood_history WHERE name = ${name} ORDER BY date, time`;
        } else {
            result = await sql.query`SELECT * FROM mood_history ORDER BY date, time`;
        }
        res.json({ history: result.recordset });
    } catch (err) {
        handleError(res, 'DB取得に失敗しました', err);
    }
});

// チャット履歴取得
app.get('/api/chat-history', async (req, res) => {
    try {
        await sql.connect(sqlConfig);
        const result = await sql.query`SELECT * FROM mood_history ORDER BY timestamp`;
        res.json({ history: result.recordset });
    } catch (err) {
        handleError(res, 'チャット履歴取得失敗', err);
    }
});

// OpenAI GPT会話APIエンドポイント追加
const axios = require('axios');
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
        mood = 'AI';
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

const port = PORT || 3000;
app.listen(port, () => console.log('Server started on port ' + port));