require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

app.post('/api/azure-language', async (req, res) => {
    const { answers } = req.body;
    const endpoint = process.env.AZURE_ENDPOINT + "language/:analyze-text?api-version=2023-04-01-preview";
    const apiKey = process.env.AZURE_API_KEY;

    // ここでAzureにお手紙を送る
    const prompt = `以下のアンケート回答を要約し、アドバイスを日本語で1～2文でください。\n${answers.join('\n')}`;
    const body = {
        // AzureのAPI仕様に合わせて書く
    };

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Ocp-Apim-Subscription-Key": apiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });
    const data = await response.json();
    res.json(data);
});

app.listen(3000, () => console.log('Server started'));