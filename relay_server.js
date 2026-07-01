const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

const APP_KEY = process.env.KIS_API_KEY;
const APP_SECRET = process.env.KIS_API_SECRET;
const BASE_URL = "https://openapi.koreainvestment.com:9443";

let cachedToken = null;
let tokenExpiry = null;

// =========================
// Access Token
// =========================
async function getAccessToken() {
    const now = Date.now();

    if (cachedToken && tokenExpiry && now < tokenExpiry) {
        return cachedToken;
    }

    try {
        const response = await axios.post(
            `${BASE_URL}/oauth2/tokenP`,
            {
                grant_type: "client_credentials",
                appkey: APP_KEY,
                appsecret: APP_SECRET
            },
            {
                headers: {
                    "content-type": "application/json"
                }
            }
        );

        cachedToken = response.data.access_token;
        tokenExpiry = now + (11 * 60 * 60 * 1000);

        console.log("새로운 KIS API 토큰 발급 완료.");

        return cachedToken;

    } catch (err) {

        console.error(err.response?.data || err.message);
        throw err;

    }
}

// =========================
// 현재가 API
// =========================
app.get("/api/kis-data/:ticker", async (req, res) => {

    try {

        const ticker = req.params.ticker;
        const token = await getAccessToken();

        const isGold = ticker === "M04020000";

        const tr_id = isGold
            ? "FHKST01010100"
            : "FHPST02400000";

        const endpoint = isGold
            ? "/uapi/domestic-stock/v1/quotations/inquire-price"
            : "/uapi/etfetn/v1/quotations/inquire-price";

        const response = await axios.get(
            `${BASE_URL}${endpoint}`,
            {
                headers: {
                    "content-type": "application/json; charset=utf-8",
                    authorization: `Bearer ${token}`,
                    appkey: APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id: tr_id
                },
                params: {
                    FID_COND_MRKT_DIV_CODE: "J",
                    FID_INPUT_ISCD: ticker
                }
            }
        );

        res.json(response.data);

    } catch (err) {

        console.error(err.response?.data || err.message);

        res.status(500).json({
            error: "현재가 조회 실패"
        });

    }

});

// =========================
// 배당 API
// =========================
app.get("/api/kis-dividend/:ticker", async (req, res) => {

    try {

        const ticker = req.params.ticker;

        const token = await getAccessToken();

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
                    authorization: `Bearer ${token}`,
                    appkey: APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id: "HHKDB669102C0",
                    custtype: "P"
                },
                params: {

                    CTS: "",

                    GB1: "0",

                    F_DT: format(oneYearAgo),

                    T_DT: format(today),

                    SHT_CD: ticker,

                    HIGH_GB: "0"

                }
            }
        );

        console.log("========== 배당 응답 ==========");
        console.log(JSON.stringify(response.data, null, 2));

        let latest = null;

        if (
            response.data.output1 &&
            Array.isArray(response.data.output1)
        ) {

            latest = response.data.output1.find(
                item => item.sht_cd === ticker
            );

            if (!latest) {

                latest = response.data.output1[0];

            }

        }

        res.json({
            success: true,
            data: latest
        });

    } catch (err) {

        console.error("배당 API 오류");

        console.error(err.response?.data || err.message);

        res.status(500).json({

            success: false,

            error: err.response?.data || err.message

        });

    }

});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {

    console.log(`한국투자증권 통합 프록시 서버 포트 ${PORT} 실행 완료`);

});
