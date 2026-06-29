const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

// Render 환경 변수에서 앱키와 시크릿을 안전하게 가져옵니다.
const APP_KEY = process.env.KIS_API_KEY;
const APP_SECRET = process.env.KIS_API_SECRET;
const BASE_URL = "https://openapi.koreainvestment.com:9443";

let cachedToken = null;
let tokenExpiry = null;

// 한국투자증권 API 접근 토큰 발급
async function getAccessToken() {
    const now = new Date().getTime();
    if (cachedToken && tokenExpiry && now < tokenExpiry) {
        return cachedToken;
    }
    try {
        const response = await axios.post(`${BASE_URL}/oauth2/tokenP`, {
            grant_type: "client_credentials",
            appkey: APP_KEY,
            appsecret: APP_SECRET
        });
        cachedToken = response.data.access_token;
        tokenExpiry = now + (12 * 60 * 60 * 1000);
        console.log("새로운 KIS API 토큰이 발급되었습니다.");
        return cachedToken;
    } catch (error) {
        console.error("토큰 발급 실패:", error.response ? error.response.data : error.message);
        throw new Error("토큰 발급 실패");
    }
}

// 통합 시세 조회 엔드포인트
app.get('/api/kis-data/:ticker', async (req, res) => {
    const { ticker } = req.params;
    try {
        const token = await getAccessToken();

        // [핵심 변경] 금 현물(M04020000)은 일반 주식 API, ETF 종목들은 ETF 전용 API 사용
        const isGold = (ticker === 'M04020000');
        const tr_id = isGold ? "FHKST01010100" : "FHPST02400000";
        const endpoint = isGold ? "/uapi/domestic-stock/v1/quotations/inquire-price" : "/uapi/etfetn/v1/quotations/inquire-price";

        const response = await axios.get(`${BASE_URL}${endpoint}`, {
            headers: {
                "content-type": "application/json",
                "authorization": `Bearer ${token}`,
                "appKey": APP_KEY,
                "appSecret": APP_SECRET,
                "tr_id": tr_id
            },
            params: {
                "fid_cond_mrkt_div_code": "J",
                "fid_input_iscd": ticker
            }
        });

        res.json(response.data);
    } catch (error) {
        console.error(`[${ticker}] 통신 에러:`, error.response ? error.response.data : error.message);
        res.status(500).json({ 
            error: "API 통신 중 오류가 발생했습니다.",
            details: error.response ? error.response.data : error.message
        });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`한국투자증권 전용 프록시 서버가 포트 ${PORT}에서 실행 중입니다.`);
});
