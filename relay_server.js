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

// =========================
// 글로벌 지수/환율/금 API
// - 코스피, S&P500, 미국 30년 국채금리, 나스닥100, 원/달러 환율, 국제금: 전부 KIS 공식 API로 조회
//   (나스닥100/환율/국제금 코드는 KIS 해외지수 마스터파일(frgn_code.mst)에서 직접 확인함)
// =========================

function computeSignedVrss(rawVrss, sign) {
    const v = Math.abs(parseFloat(rawVrss) || 0);
    return (sign === "4" || sign === "5") ? -v : v;
}

// KIS 인증 헤더 (위에서 정의된 getAccessToken, APP_KEY, APP_SECRET, BASE_URL 재사용)
async function buildKisHeaders() {
    const token = await getAccessToken();
    return {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        custtype: "P"
    };
}

// 해외지수/환율 공용 조회 (inquire-time-indexchartprice, tr_id FHKST03030200) - N/X/KX만 지원
// 해외지수/환율 공용 조회 (inquire-time-indexchartprice, tr_id FHKST03030200) - N(지수)/X(환율) 전용
async function fetchOverseasIndexLike(headers, mrktDivCode, iscd, name, currency) {
    const res = await axios.get(
        `${BASE_URL}/uapi/overseas-price/v1/quotations/inquire-time-indexchartprice`,
        { headers: { ...headers, tr_id: "FHKST03030200" },
          params: { FID_COND_MRKT_DIV_CODE: mrktDivCode, FID_INPUT_ISCD: iscd, FID_HOUR_CLS_CODE: "0", FID_PW_DATA_INCU_YN: "N" } }
    );
    console.log(`[${name} 응답 원본 / market=${mrktDivCode} code=${iscd}]`, JSON.stringify(res.data));
    const o = res.data.output1;
    if (!o || o.ovrs_nmix_prpr === undefined) throw new Error(`${name} 데이터 없음`);
    return { name, price: parseFloat(o.ovrs_nmix_prpr), previousClose: parseFloat(o.ovrs_nmix_prdy_clpr), currency };
}

// 국제 금(금선물) 전용 조회 (inquire-daily-chartprice, tr_id FHKST03030100) - N/X/I/S 중 S(금선물) 지원
async function fetchOverseasCommodity(headers, mrktDivCode, iscd, name, currency) {
    const today = new Date();
    const weekAgo = new Date();
    weekAgo.setDate(today.getDate() - 7);
    const format = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");

    const res = await axios.get(
        `${BASE_URL}/uapi/overseas-price/v1/quotations/inquire-daily-chartprice`,
        { headers: { ...headers, tr_id: "FHKST03030100" },
          params: {
              FID_COND_MRKT_DIV_CODE: mrktDivCode,
              FID_INPUT_ISCD: iscd,
              FID_INPUT_DATE_1: format(weekAgo),
              FID_INPUT_DATE_2: format(today),
              FID_PERIOD_DIV_CODE: "D"
          } }
    );
    console.log(`[${name} 응답 원본(일별) / market=${mrktDivCode} code=${iscd}]`, JSON.stringify(res.data));
    const o = res.data.output1;
    if (!o || o.ovrs_nmix_prpr === undefined) throw new Error(`${name} 데이터 없음`);
    return { name, price: parseFloat(o.ovrs_nmix_prpr), previousClose: parseFloat(o.ovrs_nmix_prdy_clpr), currency };
}

// 금선물(S) 전용 조회 (inquire-daily-chartprice, tr_id FHKST03030100) - N/X/I/S 지원
async function fetchGoldFromDailyChart(headers, iscd, name, currency) {
    const today = new Date();
    const weekAgo = new Date();
    weekAgo.setDate(today.getDate() - 7);
    const fmt = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");

    const res = await axios.get(
        `${BASE_URL}/uapi/overseas-price/v1/quotations/inquire-daily-chartprice`,
        { headers: { ...headers, tr_id: "FHKST03030100" },
          params: {
              FID_COND_MRKT_DIV_CODE: "S",
              FID_INPUT_ISCD: iscd,
              FID_INPUT_DATE_1: fmt(weekAgo),
              FID_INPUT_DATE_2: fmt(today),
              FID_PERIOD_DIV_CODE: "D"
          } }
    );
    console.log(`[${name} 응답 원본 / market=S code=${iscd}]`, JSON.stringify(res.data));
    const o = res.data.output1;
    if (!o || o.ovrs_nmix_prpr === undefined) throw new Error(`${name} 데이터 없음`);
    return { name, price: parseFloat(o.ovrs_nmix_prpr), previousClose: parseFloat(o.ovrs_nmix_prdy_clpr), currency };
}

async function fetchKisGlobal(key) {
    const headers = await buildKisHeaders();

    if (key === "kospi") {
        const res = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-index-price`,
            { headers: { ...headers, tr_id: "FHPUP02100000" },
              params: { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: "0001" } }
        );
        const o = res.data.output;
        const price = parseFloat(o.bstp_nmix_prpr);
        const signedVrss = computeSignedVrss(o.bstp_nmix_prdy_vrss, o.prdy_vrss_sign);
        return { name: "코스피 지수", price, previousClose: price - signedVrss, currency: "KRW" };
    }

    if (key === "sp500") {
        return fetchOverseasIndexLike(headers, "N", "SPX", "S&P 500", "USD");
    }

    if (key === "nasdaq100") {
        return fetchOverseasIndexLike(headers, "N", "NDX", "나스닥 100", "USD");
    }

    if (key === "usdkrw") {
        return fetchOverseasIndexLike(headers, "X", "FX@KRW", "원/달러 환율", "KRW");
    }

    if (key === "gold") {
        // frgn_code.mst 상 "CXAUUSDCOMP"(국제금가격) -> 접두사 C 제거 -> XAUUSDCOMP
        // 이 항목은 일별시세 조회(FHKST03030100)에서만 market div "S"(금선물)가 통함
        return fetchOverseasCommodity(headers, "S", "XAUUSDCOMP", "국제 금(온스당 달러)", "USD");
    }

    if (key === "us30y") {
        const res = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/comp-interest`,
            { headers: { ...headers, tr_id: "FHPST07020000" },
              params: { FID_COND_MRKT_DIV_CODE: "I", FID_COND_SCR_DIV_CODE: "20702", FID_DIV_CLS_CODE: "1", FID_DIV_CLS_CODE1: "" } }
        );
        const item = (res.data.output1 || []).find(x => x.bcdt_code === "Y0201");
        if (!item) throw new Error("미국 30년 국채 데이터를 찾을 수 없습니다.");
        const price = parseFloat(item.bond_mnrt_prpr);
        const signedVrss = computeSignedVrss(item.bond_mnrt_prdy_vrss, item.prdy_vrss_sign);
        return { name: "미국 30년 국채금리", price, previousClose: price - signedVrss, currency: "%" };
    }

    return null;
}

app.get("/api/global/:key", async (req, res) => {
    try {
        const key = req.params.key;
        const data = await fetchKisGlobal(key);
        if (!data) {
            return res.status(404).json({ success: false, error: "지원하지 않는 지수 키입니다." });
        }

        res.json({ success: true, key, source: "kis", ...data });

    } catch (err) {
        console.error(`[글로벌지수 오류] ${req.params.key}:`, err.response?.data || err.message);
        res.status(500).json({ success: false, error: "글로벌 지수 조회 실패" });
    }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {

    console.log(`한국투자증권 통합 프록시 서버 포트 ${PORT} 실행 완료`);

});
