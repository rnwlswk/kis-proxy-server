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
let tokenRequestPromise = null; // 동시에 여러 요청이 토큰이 없다고 판단해 중복 발급하는 것을 방지

// KIS는 초당 호출 횟수 제한(실전투자 기준 초당 20건)이 있다.
// 예전엔 요청을 1개씩 완전히 순서대로만 보내서, 매 요청마다 왕복시간(지연)이 그대로 다 더해져 느렸다.
// 이제는 최대 KIS_MAX_CONCURRENT개까지 동시에 진행시켜 왕복시간이 겹치게 하면서,
// 새 요청을 "시작"하는 속도 자체는 KIS_MIN_START_GAP_MS 간격으로 제한해 초당 건수 한도를 안전하게 지킨다.
const KIS_MAX_CONCURRENT = 4;
const KIS_MIN_START_GAP_MS = 60; // 최대 초당 약 16건 시작 (한도 20건보다 여유있게)
let kisActiveCount = 0;
const kisWaitQueue = [];
let kisPumpRunning = false;

async function kisPump() {
    if (kisPumpRunning) return;
    kisPumpRunning = true;
    while (kisWaitQueue.length > 0) {
        if (kisActiveCount >= KIS_MAX_CONCURRENT) {
            await new Promise(resolve => setTimeout(resolve, 20));
            continue;
        }
        const task = kisWaitQueue.shift();
        kisActiveCount++;
        task().finally(() => { kisActiveCount--; });
        await new Promise(resolve => setTimeout(resolve, KIS_MIN_START_GAP_MS));
    }
    kisPumpRunning = false;
}

function callKisThrottled(fn) {
    return new Promise((resolve, reject) => {
        kisWaitQueue.push(() => Promise.resolve().then(fn).then(resolve, reject));
        kisPump();
    });
}

// =========================
// Access Token
// =========================
async function getAccessToken() {
    const now = Date.now();
    if (cachedToken && tokenExpiry && now < tokenExpiry) {
        return cachedToken;
    }

    // 이미 다른 요청이 토큰 발급을 진행 중이면, 새로 요청하지 않고 그 결과를 같이 기다린다.
    if (tokenRequestPromise) {
        return tokenRequestPromise;
    }

    tokenRequestPromise = (async () => {
        try {
            const response = await axios.post(
                `${BASE_URL}/oauth2/tokenP`,
                {
                    grant_type: "client_credentials",
                    appkey: APP_KEY,
                    appsecret: APP_SECRET
                },
                { headers: { "content-type": "application/json" } }
            );

            cachedToken = response.data.access_token;
            // KIS가 응답으로 알려주는 실제 유효시간(expires_in, 보통 86400초=24시간)을 그대로 사용.
            // 혹시 응답에 없으면 23시간으로 안전하게 폴백. 만료 10분 전에 미리 갱신해서
            // "딱 그 순간 만료된 토큰을 쓰는" 상황을 피한다.
            const expiresInSec = response.data.expires_in || (23 * 60 * 60);
            const SAFETY_MARGIN_MS = 10 * 60 * 1000;
            tokenExpiry = Date.now() + (expiresInSec * 1000) - SAFETY_MARGIN_MS;
            console.log(`새로운 KIS API 토큰 발급 완료. (${Math.round(expiresInSec / 3600)}시간 캐시)`);
            return cachedToken;

        } catch (err) {
            console.error(err.response?.data || err.message);
            throw err;
        } finally {
            tokenRequestPromise = null;
        }
    })();

    return tokenRequestPromise;
}

// =========================
// 헬스체크(핑) API - 크론잡/모니터링 서비스가 서버를 깨우는 용도
// KIS 호출 없이 즉시 200을 반환해서, 모니터링 툴이 "실패"로 오판하지 않도록 함
// =========================
app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", time: new Date().toISOString() });
});

// =========================
// 현재가 API
// =========================
app.get("/api/kis-data/:ticker", async (req, res) => {
    try {
        const ticker = req.params.ticker;
        const token = await getAccessToken();
        const isGold = ticker === "M04020000";

        const tr_id = isGold ? "FHKST01010100" : "FHPST02400000";
        const endpoint = isGold
            ? "/uapi/domestic-stock/v1/quotations/inquire-price"
            : "/uapi/etfetn/v1/quotations/inquire-price";

        const response = await callKisThrottled(() => axios.get(
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
        ));

        res.json(response.data);

    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({ error: "현재가 조회 실패" });
    }
});

// =========================
// 52주 최고/최저가 API (ETF도 KRX 상장종목이라 이 일반 주식현재가 API로 조회 가능)
// =========================
app.get("/api/kis-52week/:ticker", async (req, res) => {
    try {
        const ticker = req.params.ticker;
        const token = await getAccessToken();

        const response = await callKisThrottled(() => axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`,
            {
                headers: {
                    "content-type": "application/json; charset=utf-8",
                    authorization: `Bearer ${token}`,
                    appkey: APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id: "FHKST01010100"
                },
                params: {
                    FID_COND_MRKT_DIV_CODE: "J",
                    FID_INPUT_ISCD: ticker
                }
            }
        ));

        const o = response.data.output || {};
        res.json({
            success: true,
            w52_hgpr: o.w52_hgpr,
            w52_lwpr: o.w52_lwpr
        });

    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({ success: false, error: "52주 최고/최저 조회 실패" });
    }
});

// =========================
// 배당 API - 최신 회차와 그 직전 회차를 같이 내려줘서, 프론트에서 증감(상승/하락)을 비교할 수 있게 함
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

        const response = await callKisThrottled(() => axios.get(
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
        ));

        let sorted = [];
        if (response.data.output1 && Array.isArray(response.data.output1)) {
            const filtered = response.data.output1.filter(item => item.sht_cd === ticker);
            const list = filtered.length > 0 ? filtered : response.data.output1;
            // record_date(YYYYMMDD) 기준 최신순 정렬
            sorted = [...list].sort((a, b) => (b.record_date || "").localeCompare(a.record_date || ""));
        }

        const latest = sorted[0] || null;
        const previous = sorted[1] || null;

        res.json({ success: true, data: latest, previousData: previous });

    } catch (err) {
        console.error("배당 API 오류", err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.response?.data || err.message });
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

// 해외지수/환율 공용 조회 (inquire-time-indexchartprice, tr_id FHKST03030200) - N(지수)/X(환율) 전용
async function fetchOverseasIndexLike(headers, mrktDivCode, iscd, name, currency) {
    const res = await callKisThrottled(() => axios.get(
        `${BASE_URL}/uapi/overseas-price/v1/quotations/inquire-time-indexchartprice`,
        { headers: { ...headers, tr_id: "FHKST03030200" },
          params: { FID_COND_MRKT_DIV_CODE: mrktDivCode, FID_INPUT_ISCD: iscd, FID_HOUR_CLS_CODE: "0", FID_PW_DATA_INCU_YN: "N" } }
    ));
    const o = res.data.output1;
    if (!o || o.ovrs_nmix_prpr === undefined) throw new Error(`${name} 데이터 없음`);
    return { name, price: parseFloat(o.ovrs_nmix_prpr), previousClose: parseFloat(o.ovrs_nmix_prdy_clpr), currency };
}

// 국제 금 - 야후 파이낸스. 런던 금 현물(XAUUSD=X)을 우선 사용 (국내 증권사들이 보통 이 기준을 씀).
// 선물(GC=F)은 만기까지 남은 기간 때문에 현물보다 보통 1~3% 비싸게 나와서(콘탱고),
// 국내 증권사 "국제금가격" 표시와 비교하면 현물 쪽이 더 가깝다. 혹시 실패하면 선물로 폴백.
async function fetchGoldFromYahoo() {
    const fetchByTicker = async (ticker) => {
        const response = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`,
            { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
              params: { interval: "1d", range: "5d" } }
        );
        const result = response.data?.chart?.result?.[0];
        if (!result || !result.meta) throw new Error("야후 파이낸스 응답에 데이터가 없습니다.");
        const meta = result.meta;
        return {
            name: "국제 금(온스당 달러)",
            price: meta.regularMarketPrice,
            previousClose: meta.chartPreviousClose ?? meta.previousClose,
            currency: meta.currency
        };
    };

    try {
        return await fetchByTicker("XAUUSD=X");
    } catch (e) {
        console.warn("XAUUSD=X 조회 실패, GC=F(선물)로 대체:", e.message);
        return fetchByTicker("GC=F");
    }
}

async function fetchKisGlobal(key) {
    if (key === "gold") {
        return fetchGoldFromYahoo();
    }

    const headers = await buildKisHeaders();

    if (key === "kospi") {
        const res = await callKisThrottled(() => axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-index-price`,
            { headers: { ...headers, tr_id: "FHPUP02100000" },
              params: { FID_COND_MRKT_DIV_CODE: "U", FID_INPUT_ISCD: "0001" } }
        ));
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

    if (key === "us30y") {
        const res = await callKisThrottled(() => axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/comp-interest`,
            { headers: { ...headers, tr_id: "FHPST07020000" },
              params: { FID_COND_MRKT_DIV_CODE: "I", FID_COND_SCR_DIV_CODE: "20702", FID_DIV_CLS_CODE: "1", FID_DIV_CLS_CODE1: "" } }
        ));
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

        res.json({ success: true, key, source: key === "gold" ? "yahoo" : "kis", ...data });

    } catch (err) {
        console.error(`[글로벌지수 오류] ${req.params.key}:`, err.response?.data || err.message);
        res.status(500).json({ success: false, error: "글로벌 지수 조회 실패" });
    }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`한국투자증권 통합 프록시 서버 포트 ${PORT} 실행 완료`);
});
