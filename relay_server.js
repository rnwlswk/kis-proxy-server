const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

// 환경 변수 설정
const APP_KEY = process.env.KIS_API_KEY;
const APP_SECRET = process.env.KIS_API_SECRET;
const BASE_URL = "https://openapi.koreainvestment.com:9443";

let accessToken = "";
let expireTime = 0;

// 1. Access Token 발급 함수
async function getAccessToken() {
    if (accessToken && Date.now() < expireTime) return accessToken;
    try {
        const { data } = await axios.post(`${BASE_URL}/oauth2/tokenP`, {
            grant_type: "client_credentials",
            appkey: APP_KEY,
            appsecret: APP_SECRET
        });
        accessToken = data.access_token;
        expireTime = Date.now() + 1000 * 60 * 60 * 11;
        return accessToken;
    } catch (e) {
        console.error("토큰 발급 실패:", e.message);
        throw e;
    }
}

// 2. 현재가 조회 (ETF/금 구분 로직)
app.get("/api/kis-data/:ticker", async (req, res) => {
    try {
        const ticker = req.params.ticker;
        const token = await getAccessToken();
        
        // 금 현물(M04020000)과 ETF 구분
        const isGold = (ticker === "M04020000");
        const endpoint = isGold ? "/uapi/domestic-stock/v1/quotations/inquire-price" : "/uapi/etfetn/v1/quotations/inquire-price";
        const tr_id = isGold ? "FHKST01010100" : "FHPST02400000";

        const response = await axios.get(`${BASE_URL}${endpoint}`, {
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
        });
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. 배당 일정 조회 (국내주식-145 규격 준수)
app.get("/api/kis-dividend/:ticker", async (req, res) => {
    try {
        const ticker = req.params.ticker;
        const token = await getAccessToken();

        const today = new Date();
        const lastYear = new Date();
        lastYear.setFullYear(today.getFullYear() - 1);

        const formatDate = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

        const response = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/ksdinfo/dividend`, {
            headers: {
                "content-type": "application/json; charset=utf-8",
                "authorization": `Bearer ${token}`,
                "appkey": APP_KEY,
                "appsecret": APP_SECRET,
                "tr_id": "HHKDB669102C0",
                "custtype": "P"
            },
            params: {
                "CTS_AREA_SEARCH_DIV": "0",
                "FID_INPUT_ISCD": ticker,
                "FID_INPUT_DATE_1": formatDate(lastYear),
                "FID_INPUT_DATE_2": formatDate(today)
            }
        });

        const outputList = response.data.output1 || [];
        const result = outputList.find(x => x.sht_cd.trim() === ticker) || outputList[0] || null;

        res.json({ success: true, data: result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(process.env.PORT || 5000, () => console.log("서버 실행 중"));
