require('dotenv').config(); // これで.envが使える

const apiKey = process.env.AZURE_API_KEY;
const endpoint = process.env.AZURE_ENDPOINT;

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const sql = require('mssql');

const sqlConfig = {
    user: process.env.AZURE_SQL_USER,
    password: process.env.AZURE_SQL_PASSWORD,
    database: process.env.AZURE_SQL_DATABASE,
    server: process.env.AZURE_SQL_SERVER,
    options: {
        encrypt: true,
        trustServerCertificate: false
    }
};

// 追加: ルートでindex.htmlを返す
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.post('/api/azure-language', async (req, res) => {
    console.log('APIリクエスト受信:', new Date()); // デバッグ用
    const { answers } = req.body;
    const apiKey = process.env.AZURE_API_KEY;
    const endpoint = process.env.AZURE_ENDPOINT + '/language/analyze-text/jobs?api-version=2023-04-01';

    // Azure Language Service 用のbody
    const body = {
        displayName: "MoodCheckSummary",
        analysisInput: {
            documents: [
                {
                    id: "1",
                    language: "ja",
                    text: answers.join('\n')
                }
            ]
        },
        tasks: [
            {
                kind: "AbstractiveSummarization",
                parameters: {
                    sentenceCount: 2
                }
            }
        ]
    };

    try {
        // ジョブを作成
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Ocp-Apim-Subscription-Key": apiKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Azure Language Serviceリクエスト失敗:', response.status, errorText);
            return res.status(500).json({ error: 'Azure Language Serviceへのリクエストに失敗しました', status: response.status, detail: errorText });
        }
        // ジョブのURL取得
        const operationLocation = response.headers.get('operation-location');
        if (!operationLocation) {
            console.error('operation-locationヘッダーがありません');
            return res.status(500).json({ error: 'operation-locationヘッダーがありません' });
        }
        // ジョブ完了までポーリング
        let result;
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const pollRes = await fetch(operationLocation, {
                headers: { "Ocp-Apim-Subscription-Key": apiKey }
            });
            const pollData = await pollRes.json();
            console.log('ポーリング結果:', JSON.stringify(pollData, null, 2)); // デバッグ用
            if (pollData.status === 'succeeded') {
                result = pollData;
                break;
            } else if (pollData.status === 'failed') {
                console.error('要約ジョブが失敗:', JSON.stringify(pollData, null, 2));
                return res.status(500).json({ error: '要約ジョブが失敗しました', detail: pollData });
            }
        }
        if (!result) {
            console.error('要約ジョブがタイムアウト');
            return res.status(500).json({ error: '要約ジョブがタイムアウトしました' });
        }
        // 要約文を抽出（summaries[0].textを参照するよう修正）
        let summary = '';
        try {
            const task = result.tasks.items[0];
            if (
                task &&
                task.results &&
                task.results.documents &&
                task.results.documents[0] &&
                task.results.documents[0].summaries &&
                task.results.documents[0].summaries[0] &&
                task.results.documents[0].summaries[0].text
            ) {
                summary = task.results.documents[0].summaries[0].text;
            } else {
                summary = '要約が取得できませんでした。';
                console.error('要約抽出失敗:', JSON.stringify(task, null, 2));
            }
        } catch (err) {
            summary = '要約の解析中にエラーが発生しました。';
            console.error('要約解析エラー:', err);
        }

        // --- ポジティブ/ネガティブ判定とアドバイス生成 ---
        let sentiment = 'neutral';
        let advice = '';
        if (/元気|楽しい|良い|前向き|充実|嬉しい|幸せ|笑顔|順調|感謝|満足|穏やか|ポジティブ/.test(summary)) {
            sentiment = 'positive';
            advice = 'この調子で自分のペースを大切に過ごしましょう！';
        } else if (/疲れ|ストレス|不安|落ち込|つらい|悩み|心配|イライラ|ネガティブ|困難|孤独|眠れない|体調不良|悲しい/.test(summary)) {
            sentiment = 'negative';
            advice = '無理せず、休息やリフレッシュの時間を意識してみてください。誰かに話すのもおすすめです。';
        } else {
            sentiment = 'neutral';
            advice = '大きな波はなさそうです。自分のペースで過ごしましょう。';
        }
        res.json({ result: summary, sentiment, advice });
    } catch (e) {
        console.error('サーバー側例外:', e);
        res.status(500).json({ error: e.message });
    }
});

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
        console.error('SQL保存エラー:', err);
        res.status(500).json({ error: 'DB保存に失敗しました', detail: err.message });
    }
});

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
        console.error('SQL取得エラー:', err);
        res.status(500).json({ error: 'DB取得に失敗しました', detail: err.message });
    }
});

// /api/chat-history エンドポイント追加（chatServer.jsと同じ内容）
app.get('/api/chat-history', async (req, res) => {
    try {
        await sql.connect(sqlConfig);
        const result = await sql.query`SELECT * FROM mood_history ORDER BY timestamp`;
        res.json({ history: result.recordset });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Server started on port ' + port));