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

// 한국투자증권 API 접근 토큰 발급 (최적화)
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
        tokenExpiry = now + (11 * 60 * 60 * 1000); // 11시간 후 갱신
        console.log("새로운 KIS API 토큰 발급 완료.");
        return cachedToken;
    } catch (error) {
        console.error("토큰 발급 실패:", error.response?.data || error.message);
        throw new Error("토큰 발급 실패");
    }
}

// [API 1] 현재가, NAV, 괴리율 통합 엔드포인트
app.get('/api/kis-data/:ticker', async (req, res) => {
    const { ticker } = req.params;
    try {
        const token = await getAccessToken();
        const isGold = (ticker === 'M04020000');
        // 금 현물(FHKST01010100) / ETF(FHPST02400000) 트랜잭션 ID 분리
        const tr_id = isGold ? "FHKST01010100" : "FHPST02400000";
        const endpoint = isGold 
            ? "/uapi/domestic-stock/v1/quotations/inquire-price" 
            : "/uapi/etfetn/v1/quotations/inquire-price";

        const response = await axios.get(`${BASE_URL}${endpoint}`, {
            headers: {
                "content-type": "application/json; charset=utf-8",
                "authorization": `Bearer ${token}`,
                "appkey": APP_KEY,       // KIS는 소문자를 요구합니다
                "appsecret": APP_SECRET, // KIS는 소문자를 요구합니다
                "tr_id": tr_id
            },
            params: {
                "FID_COND_MRKT_DIV_CODE": "J",
                "FID_INPUT_ISCD": ticker
            }
        });
        res.json(response.data);
    } catch (error) {
        console.error(`[${ticker}] 현재가 에러:`, error.response?.data || error.message);
        res.status(500).json({ error: "현재가 통신 오류", details: error.message });
    }
});

// [API 2] 예탁원 배당일정 (배당금, 배당률, 기준일) 엔드포인트
app.get('/api/kis-dividend/:ticker', async (req, res) => {
    const { ticker } = req.params;
    try {
        const token = await getAccessToken();
        
        // 검색 범위: 오늘부터 1년 전까지 (최근 1년 이내의 가장 최신 배당을 가져오기 위함)
        const today = new Date();
        const oneYearAgo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
        const formatDt = (d) => d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');

        const response = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/ksdinfo/dividend`, {
            headers: {
                "content-type": "application/json; charset=utf-8",
                "authorization": `Bearer ${token}`,
                "appkey": APP_KEY,
                "appsecret": APP_SECRET,
                "tr_id": "HHKDB669102C0", // 예탁원정보(배당일정) TR_ID
                "custtype": "P"
            },
            params: {
                "CTS_AREA_SEARCH_DIV": "0", // 전체 대상에서 특정 종목으로 필터링
                "FID_INPUT_ISCD": ticker,   
                "FID_INPUT_DATE_1": formatDt(oneYearAgo),
                "FID_INPUT_DATE_2": formatDt(today)
            }
        });

        // 응답 데이터에서 해당 ETF의 가장 최근 배당정보 1개를 추출합니다
        let latestDiv = null;
        if (response.data && response.data.output && Array.isArray(response.data.output)) {
            // 티커 코드로 필터링 후 첫 번째 데이터(가장 최근) 선택
            const matched = response.data.output.filter(item => item.sht_cd === ticker || item.sht_cd === ticker.replace(/[^0-9]/g, ''));
            latestDiv = matched.length > 0 ? matched[0] : response.data.output[0];
        }
        res.json({ success: true, data: latestDiv });
    } catch (error) {
        console.error(`[${ticker}] 배당 API 에러:`, error.response?.data || error.message);
        res.status(500).json({ error: "배당 통신 오류", details: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`한국투자증권 통합 프록시 서버 포트 ${PORT} 실행 완료`);
});
