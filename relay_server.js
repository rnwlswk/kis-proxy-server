const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

// Render 환경 변수
const APP_KEY = process.env.KIS_API_KEY;
const APP_SECRET = process.env.KIS_API_SECRET;
const BASE_URL = "https://openapi.koreainvestment.com:9443";

let accessToken = "";
let expireTime = 0;

// =====================================================
// 1. Access Token 발급
// =====================================================
async function getAccessToken() {
    if (accessToken && Date.now() < expireTime) {
        return accessToken;
    }

    try {
        const { data } = await axios.post(
            `${BASE_URL}/oauth2/tokenP`,
            {
                grant_type: "client_credentials",
                appkey: APP_KEY,
                appsecret: APP_SECRET
            },
            {
                headers: { "content-type": "application/json" }
            }
        );

        accessToken = data.access_token;
        expireTime = Date.now() + 1000 * 60 * 60 * 11; // 11시간 캐싱
        console.log("KIS Token 재발급 완료");
        return accessToken;
    } catch (error) {
        console.error("토큰 발급 실패:", error.response?.data || error.message);
        throw error;
    }
}

// =====================================================
// 2. 현재가 & NAV/괴리율 API (금/ETF 분기 처리 완료)
// =====================================================
app.get("/api/kis-data/:ticker", async (req, res) => {
    try {
        const ticker = req.params.ticker;
        const token = await getAccessToken();

        // 금 현물과 ETF의 TR_ID 및 엔드포인트 분기 처리
        const isGold = (ticker === "M04020000");
        const tr_id = isGold ? "FHKST01010100" : "FHPST02400000";
        const endpoint = isGold 
            ? "/uapi/domestic-stock/v1/quotations/inquire-price" 
            : "/uapi/etfetn/v1/quotations/inquire-price";

        const response = await axios.get(
            `${BASE_URL}${endpoint}`,
            {
                headers: {
                    "content-type": "application/json; charset=utf-8",
                    "authorization": `Bearer ${token}`,
                    "appkey": APP_KEY,
                    "appsecret": APP_SECRET,
                    "tr_id": tr_id
                },
                params: {
                    "FID_COND_MRKT_DIV_CODE": "J",
                    "FID_INPUT_ISCD": ticker
                }
            }
        );

        res.json(response.data);
    } catch (err) {
        console.error(`[${req.params.ticker}] 현재가 API 오류:`, err.response?.data || err.message);
        res.status(500).json({ error: "현재가 조회 실패", details: err.message });
    }
});

// =====================================================
// 3. 예탁원 배당일정 API (파라미터 규격 수정 완료)
// =====================================================
app.get("/api/kis-dividend/:ticker", async (req, res) => {
    try {
        const ticker = req.params.ticker;
        const token = await getAccessToken();

        // 날짜 포맷 (YYYYMMDD) 계산: 오늘부터 1년 전까지 조회
        const today = new Date();
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(today.getFullYear() - 1);

        const format = (d) =>
            d.getFullYear() +
            String(d.getMonth() + 1).padStart(2, "0") +
            String(d.getDate()).padStart(2, "0");

        const response = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/ksdinfo/dividend`,
            {
                headers: {
                    "content-type": "application/json; charset=utf-8",
                    "authorization": `Bearer ${token}`,
                    "appkey": APP_KEY,
                    "appsecret": APP_SECRET,
                    "tr_id": "HHKDB669102C0",
                    "custtype": "P"
                },
                params: {
                    // [핵심 수정] KIS 공식 명세서의 정확한 파라미터명으로 변경
                    "CTS_AREA_SEARCH_DIV": "0",
                    "FID_INPUT_ISCD": ticker,
                    "FID_INPUT_DATE_1": format(oneYearAgo),
                    "FID_INPUT_DATE_2": format(today)
                }
            }
        );

        let result = null;
        
        // KIS 배당 API 응답은 'output1' (또는 'output') 배열에 내려옵니다.
        const outputList = response.data.output1 || response.data.output;

        if (Array.isArray(outputList) && outputList.length > 0) {
            // 조회된 배당 이력 중 종목코드가 일치하는 가장 최신 데이터를 찾습니다.
            result = outputList.find(x => x.sht_cd.includes(ticker)) || outputList[0];
        }

        res.json({
            success: true,
            data: result,
            total: outputList ? outputList.length : 0
        });

    } catch (err) {
        console.error(`[${req.params.ticker}] 배당 API 오류:`, err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`한국투자증권 프록시 서버 포트 ${PORT} 실행 완료`);
});
