const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

const APP_KEY = process.env.KIS_API_KEY;
const APP_SECRET = process.env.KIS_API_SECRET;
const BASE_URL = "https://openapi.koreainvestment.com:9443";

let accessToken = "";
let expireTime = 0;

//=====================================================
// Access Token
//=====================================================

async function getAccessToken() {

    if (accessToken && Date.now() < expireTime) {
        return accessToken;
    }

    const { data } = await axios.post(
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

    accessToken = data.access_token;

    expireTime = Date.now() + 1000 * 60 * 60 * 11;

    console.log("KIS Token 재발급");

    return accessToken;
}

//=====================================================
// 현재가
//=====================================================

app.get("/api/kis-data/:ticker", async (req, res) => {

    try {

        const ticker = req.params.ticker;

        const token = await getAccessToken();

        const response = await axios.get(
            `${BASE_URL}/uapi/etfetn/v1/quotations/inquire-price`,
            {
                headers: {
                    authorization: `Bearer ${token}`,
                    appkey: APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id: "FHPST02400000",
                    "content-type": "application/json; charset=utf-8"
                },
                params: {
                    FID_COND_MRKT_DIV_CODE: "J",
                    FID_INPUT_ISCD: ticker
                }
            }
        );

        res.json(response.data);

    } catch (e) {

        console.log(e.response?.data || e.message);

        res.status(500).json(e.response?.data || { error: e.message });

    }

});

//=====================================================
// 배당
//=====================================================

app.get("/api/kis-dividend/:ticker", async (req, res) => {

    try {

        const ticker = req.params.ticker;

        const token = await getAccessToken();

        const today = new Date();

        const before = new Date();

        before.setFullYear(today.getFullYear() - 1);

        const format = d =>
            d.getFullYear() +
            String(d.getMonth() + 1).padStart(2, "0") +
            String(d.getDate()).padStart(2, "0");

        const response = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/ksdinfo/dividend`,
            {
                headers: {
                    authorization: `Bearer ${token}`,
                    appkey: APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id: "HHKDB669102C0",
                    custtype: "P",
                    "content-type": "application/json; charset=utf-8"
                },
                params: {

                    CTS: "",

                    GB1: "0",

                    F_DT: format(before),

                    T_DT: format(today),

                    SHT_CD: ticker,

                    HIGH_GB: "0"

                }
            }
        );

        let result = null;

        if (Array.isArray(response.data.output1)) {

            result = response.data.output1.find(
                x => x.sht_cd.trim() === ticker
            );

            if (!result) {

                result = response.data.output1[0] || null;

            }

        }

        res.json({
            success: true,
            data: result,
            total: response.data.output1?.length || 0
        });

    } catch (e) {

        console.log(e.response?.data || e.message);

        res.status(500).json({
            success: false,
            error: e.response?.data || e.message
        });

    }

});

//=====================================================

app.listen(process.env.PORT || 5000, () => {

    console.log("KIS Proxy Server Start");

});
