const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

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
// (75ms/4개 조합에서도 EGW00201이 재발해서, 동시성을 낮추고 간격을 더 늘려 여유를 키움)
const KIS_MAX_CONCURRENT = 2;
const KIS_MIN_START_GAP_MS = 100; // 최대 초당 약 10건 시작 (한도 20건 대비 절반 수준으로 여유있게)
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
// 일봉(최근 N일 종가) API - 한 번 호출에 최대 100건까지 가능해서 페이지네이션 없이 한 번에 받아옴
// ETF/금현물 전부 KRX 상장 종목이라 이 일반 주식 기간별시세 API로 조회 가능
// =========================
// 일봉/주봉 공용 조회 함수 - 캔들차트에 필요한 시가/고가/저가/종가(OHLC)를 전부 반환
async function fetchPeriodChart(ticker, periodCode, daysBack, limitCount) {
    const token = await getAccessToken();

    const today = new Date();
    const startDate = new Date();
    startDate.setDate(today.getDate() - daysBack);

    const format = (d) =>
        d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, "0") +
        String(d.getDate()).padStart(2, "0");

    const response = await callKisThrottled(() => axios.get(
        `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`,
        {
            headers: {
                "content-type": "application/json; charset=utf-8",
                authorization: `Bearer ${token}`,
                appkey: APP_KEY,
                appsecret: APP_SECRET,
                tr_id: "FHKST03010100"
            },
            params: {
                FID_COND_MRKT_DIV_CODE: "J",
                FID_INPUT_ISCD: ticker,
                FID_INPUT_DATE_1: format(startDate),
                FID_INPUT_DATE_2: format(today),
                FID_PERIOD_DIV_CODE: periodCode, // D:일봉, W:주봉
                FID_ORG_ADJ_PRC: "0"
            }
        }
    ));

    const list = Array.isArray(response.data.output2) ? response.data.output2 : [];
    return [...list]
        .filter(item => item.stck_bsop_date && item.stck_clpr)
        .sort((a, b) => a.stck_bsop_date.localeCompare(b.stck_bsop_date))
        .slice(-limitCount)
        .map(item => ({
            date: item.stck_bsop_date,
            open: parseFloat(item.stck_oprc),
            high: parseFloat(item.stck_hgpr),
            low: parseFloat(item.stck_lwpr),
            close: parseFloat(item.stck_clpr)
        }));
}

// 일봉(최근 20거래일, 캔들용 OHLC) - 한 번 호출에 최대 100건까지 가능해서 페이지네이션 불필요
app.get("/api/kis-daily-chart/:ticker", async (req, res) => {
    try {
        const sorted = await fetchPeriodChart(req.params.ticker, "D", 40, 20);
        res.json({ success: true, data: sorted });
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({ success: false, error: "일봉 조회 실패" });
    }
});

// =========================
// 분봉(당일 1분봉, 캔들용 OHLC) - inquire-time-itemchartprice는 한 번 호출에 최근 시각 기준으로
// 최대 30건까지만 내려주므로(다른 KIS 차트류 API보다 더 적음), 장 시작(09:00)까지 여러 번 나눠 호출해서 합침
// =========================
const KST_TIME_FMT = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"
});

function getKstNowHourStr() {
    const parts = KST_TIME_FMT.formatToParts(new Date());
    const get = (type) => parts.find(p => p.type === type).value;
    return `${get("hour")}${get("minute")}${get("second")}`;
}

const KST_DATE_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }); // en-CA => "YYYY-MM-DD" 형식
function getKstTodayYmd() {
    return KST_DATE_FMT.format(new Date()).replace(/-/g, "");
}

// "HHMMSS" 문자열에 분 단위로 더하거나 빼기 (초는 00으로 고정)
function shiftHourStr(hhmmss, deltaMinutes) {
    const h = parseInt(hhmmss.slice(0, 2), 10);
    const m = parseInt(hhmmss.slice(2, 4), 10);
    let totalMinutes = h * 60 + m + deltaMinutes;
    totalMinutes = Math.max(0, totalMinutes);
    const newH = Math.floor(totalMinutes / 60);
    const newM = totalMinutes % 60;
    return `${String(newH).padStart(2, "0")}${String(newM).padStart(2, "0")}00`;
}

// 한 구간(윈도우) 조회 - 주어진 시각을 기준으로 그 이전 최대 30분치를 최신순으로 내려줌
async function fetchMinuteChartWindow(ticker, hourStr) {
    const token = await getAccessToken();

    const response = await callKisThrottled(() => axios.get(
        `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice`,
        {
            headers: {
                "content-type": "application/json; charset=utf-8",
                authorization: `Bearer ${token}`,
                appkey: APP_KEY,
                appsecret: APP_SECRET,
                tr_id: "FHKST03010200"
            },
            params: {
                FID_ETC_CLS_CODE: "",
                FID_COND_MRKT_DIV_CODE: "J",
                FID_INPUT_ISCD: ticker,
                FID_INPUT_HOUR_1: hourStr,
                FID_PW_DATA_INCU_YN: "Y"
            }
        }
    ));

    const list = Array.isArray(response.data.output2) ? response.data.output2 : [];
    return list
        .filter(item => item.stck_cntg_hour && item.stck_prpr)
        .map(item => ({
            date: item.stck_cntg_hour, // "HHMMSS" - generateCandleChartSvg의 fmtDate가 6자리는 "HH:MM"으로 표시
            open: parseFloat(item.stck_oprc),
            high: parseFloat(item.stck_hgpr),
            low: parseFloat(item.stck_lwpr),
            close: parseFloat(item.stck_prpr)
        }));
}

const MARKET_OPEN_HOUR = "090000";
const MARKET_CLOSE_HOUR = "153000"; // 상한을 안 걸어두면, 장마감 후 조회 시 KIS가 "조회 시각"에 마지막가를 붙여 돌려주는 값이
                                     // 그대로 필터를 통과해서 볼 때마다 그래프가 계속 늘어나 보이는 버그가 있었음

// 장 시작(09:00)부터 현재 시각까지 필요한 30분 구간들을 미리 계산해서 한꺼번에 병렬로 요청
// (구간마다 순서대로 기다리면 최대 13번 왕복이 그대로 다 더해져서 느렸음 - KIS 호출 자체는
// callKisThrottled 큐가 알아서 속도제한 안 걸리게 처리해주므로 병렬로 던져도 안전함)
async function fetchMinuteChartFull(ticker) {
    const nowHour = getKstNowHourStr();

    const cursors = [];
    let cursor = nowHour;
    for (let i = 0; i < 20; i++) { // 390분 / 30분 ≈ 13개 + 여유분
        cursors.push(cursor);
        if (cursor <= MARKET_OPEN_HOUR) break;
        cursor = shiftHourStr(cursor, -29); // 29분씩 이동해서 구간 사이에 빈틈이 안 생기게 1분 겹치게 함
    }

    const chunks = await Promise.all(
        cursors.map(h => fetchMinuteChartWindow(ticker, h).catch(() => []))
    );

    const byTime = new Map();
    chunks.flat().forEach(c => byTime.set(c.date, c)); // 구간끼리 겹치는 시각 중복 제거
    return [...byTime.values()]
        .filter(c => c.date >= MARKET_OPEN_HOUR && c.date <= MARKET_CLOSE_HOUR)
        .sort((a, b) => a.date.localeCompare(b.date));
}

// =========================
// 분봉 스냅샷 저장 - 당일 분봉이 마감 무렵까지 찬 상태로 조회되면 디스크에 저장해뒀다가,
// 다음날 09:00 이전(장 시작 전)이나 휴장일에 "마지막 거래일 분봉"으로 대신 보여줄 수 있게 함
// (KIS 분봉 API 자체는 당일 전용이라 과거 날짜를 직접 조회할 방법이 없어서, 우리가 직접 보관해두는 방식)
// =========================
const SNAPSHOT_DIR = path.join(__dirname, "minute-snapshots");
if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

function saveMinuteSnapshot(ticker, data) {
    try {
        const snapshot = { date: getKstTodayYmd(), data };
        fs.writeFileSync(path.join(SNAPSHOT_DIR, `${ticker}.json`), JSON.stringify(snapshot));
    } catch (e) {
        console.warn(`[${ticker}] 분봉 스냅샷 저장 실패:`, e.message);
    }
}

function loadMinuteSnapshot(ticker) {
    try {
        const filePath = path.join(SNAPSHOT_DIR, `${ticker}.json`);
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (e) {
        console.warn(`[${ticker}] 분봉 스냅샷 로드 실패:`, e.message);
        return null;
    }
}

app.get("/api/kis-minute-chart/:ticker", async (req, res) => {
    try {
        // quick=1: 가장 최근 구간(최대 30분치)만 빠르게 반환 - 프론트에서 먼저 그려서 체감 속도를 높이는 용도
        if (req.query.quick === "1") {
            const chunk = await fetchMinuteChartWindow(req.params.ticker, getKstNowHourStr());
            const data = chunk
                .filter(c => c.date >= MARKET_OPEN_HOUR && c.date <= MARKET_CLOSE_HOUR)
                .sort((a, b) => a.date.localeCompare(b.date));
            return res.json({ success: true, data, partial: true });
        }

        const data = await fetchMinuteChartFull(req.params.ticker);

        // 장 마감 무렵(15:00 이후)까지 찬 데이터면 "완성된 하루치"로 보고 스냅샷 저장
        if (data.length > 0 && data[data.length - 1].date >= "150000") {
            saveMinuteSnapshot(req.params.ticker, data);
        }

        res.json({ success: true, data });
    } catch (err) {
        console.error(`[분봉 오류] ${req.params.ticker}:`, err.response?.data || err.message);
        res.status(500).json({ success: false, error: "분봉 조회 실패" });
    }
});

// 저장해둔 마지막 거래일 분봉 스냅샷 조회 (장 시작 전/휴장일용)
app.get("/api/kis-minute-chart-snapshot/:ticker", (req, res) => {
    const snapshot = loadMinuteSnapshot(req.params.ticker);
    if (!snapshot) {
        return res.status(404).json({ success: false, error: "저장된 분봉 스냅샷이 없습니다." });
    }
    res.json({ success: true, date: snapshot.date, data: snapshot.data });
});

// =========================
// 분봉 스냅샷 자동 저장 - 사용자가 장마감 무렵에 우연히 앱을 열어야만 저장되는 문제를 없애기 위해,
// 서버가 스스로(또는 외부 트리거로) 장마감 시점에 전 종목 분봉을 한 번 받아서 저장해둔다.
// index.html의 ETF_DATABASE와 동일한 종목 목록을 여기 따로 유지 (서버는 프론트 코드를 모르므로)
// =========================
const AUTO_SNAPSHOT_TICKERS = ["486290", "482730", "476550", "475720", "498410", "329200", "M04020000"];

let lastAutoSnapshotDate = null; // 하루에 한 번만 실행되게 막는 용도

async function runAutoSnapshotNow() {
    const results = [];
    for (const ticker of AUTO_SNAPSHOT_TICKERS) {
        try {
            const data = await fetchMinuteChartFull(ticker);
            if (data.length > 0 && data[data.length - 1].date >= "150000") {
                saveMinuteSnapshot(ticker, data);
                results.push({ ticker, saved: true, count: data.length });
            } else {
                results.push({ ticker, saved: false, reason: "당일 데이터가 아직 마감 무렵까지 안 찼음" });
            }
        } catch (e) {
            console.warn(`[자동 스냅샷 오류] ${ticker}:`, e.response?.data || e.message);
            results.push({ ticker, saved: false, reason: e.message });
        }
    }
    return results;
}

// 서버가 켜져 있는 동안 5분마다 체크 - 장마감(15:30) 후 30분 지난 시점(15:35~)에 하루 한 번만 자동 실행
// (Render 무료 플랜처럼 서버가 잠들 수 있는 환경에서는 이 타이머가 그 시간에 꼭 깨어있다는 보장이 없으므로,
//  아래의 /api/run-auto-snapshot 엔드포인트를 외부 무료 크론 서비스로 15:35경에 호출하도록 걸어두는 걸 권장)
setInterval(async () => {
    const today = getKstTodayYmd();
    if (getKstNowHourStr() < "153500" || lastAutoSnapshotDate === today) return;
    lastAutoSnapshotDate = today;
    console.log(`[자동 스냅샷] ${today} 실행 시작`);
    const results = await runAutoSnapshotNow();
    console.log(`[자동 스냅샷] ${today} 완료:`, results);
}, 5 * 60 * 1000);

// 외부 크론 서비스(cron-job.org 등)로 매일 15:35경 호출하면, 서버가 잠들어 있어도 이 요청 자체가 깨워서 실행시킴
// ?force=1을 붙이면 하루 중복 실행 방지 없이 즉시 강제 실행 (테스트용)
app.get("/api/run-auto-snapshot", async (req, res) => {
    const today = getKstTodayYmd();
    if (req.query.force !== "1" && lastAutoSnapshotDate === today) {
        return res.json({ success: true, skipped: true, reason: "오늘 이미 실행됨" });
    }
    lastAutoSnapshotDate = today;
    const results = await runAutoSnapshotNow();
    res.json({ success: true, date: today, results });
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
        // 최근 1년 전체 분배 이력 (날짜/금액만 간단히 정리해서 반환)
        const history = sorted.map(item => ({
            date: item.record_date,
            amount: parseInt(item.per_sto_divi_amt) || 0
        }));

        res.json({ success: true, data: latest, previousData: previous, history });

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

// 국제 금 - 야후 파이낸스. 런던 금 현물(XAU=X)을 우선 사용 (국내 증권사들이 보통 이 기준을 씀).
// 선물(GC=F)은 만기까지 남은 기간 때문에 현물보다 보통 1~3% 비싸게 나와서(콘탱고),
// 국내 증권사 "국제금가격" 표시와 비교하면 현물 쪽이 더 가깝다. 혹시 실패하면 선물로 폴백.
// 국제 금 - 야후 파이낸스 COMEX 금선물(GC=F).
// 현물(spot) 티커를 여러 개 시도해봤으나(XAUUSD=X, XAU=X) 이 야후 비공식 API에서는 둘 다
// 404로 응답해서 사용이 불가능했음 (2026-08 기준). 그래서 확실히 동작하는 선물 가격을 사용한다.
// 참고: 선물은 만기까지 남은 기간 때문에 현물보다 보통 1~3% 비싸게 나오는 경향(콘탱고)이 있어서,
// 국내 증권사가 보여주는 "국제금가격"(대개 현물 기준)과는 이 정도 차이가 날 수 있다.
async function fetchGoldFromYahoo() {
    const response = await axios.get(
        "https://query1.finance.yahoo.com/v8/finance/chart/GC=F",
        { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
          params: { interval: "1d", range: "5d" } }
    );
    const result = response.data?.chart?.result?.[0];
    if (!result || !result.meta) throw new Error("야후 파이낸스 응답에 데이터가 없습니다.");
    const meta = result.meta;
    return {
        name: "국제 금(온스당 달러, 선물 기준)",
        price: meta.regularMarketPrice,
        previousClose: meta.chartPreviousClose ?? meta.previousClose,
        currency: meta.currency
    };
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

// =========================
// 글로벌 지수/환율/금 일봉(OHLC) API - 첫 페이지(글로벌 지수 슬라이드)에서 항목을 누르면
// 기존 ETF 상세화면과 동일한 일봉 차트 모달을 띄우기 위해 사용
// =========================

// 국내 지수(코스피) 일봉 - 한 구간(윈도우) 조회
// inquire-daily-itemchartprice와 동일한 파라미터 구조지만
// 종목이 아닌 "지수"용 전용 엔드포인트(inquire-daily-indexchartprice)를 사용
async function fetchDomesticIndexDailyChartWindow(iscd, startDate, endDate) {
    const token = await getAccessToken();

    const response = await callKisThrottled(() => axios.get(
        `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice`,
        {
            headers: {
                "content-type": "application/json; charset=utf-8",
                authorization: `Bearer ${token}`,
                appkey: APP_KEY,
                appsecret: APP_SECRET,
                tr_id: "FHPUP02120000"
            },
            params: {
                FID_COND_MRKT_DIV_CODE: "U",
                FID_INPUT_ISCD: iscd,
                FID_INPUT_DATE_1: formatYmd(startDate),
                FID_INPUT_DATE_2: formatYmd(endDate),
                FID_PERIOD_DIV_CODE: "D"
            }
        }
    ));

    const list = Array.isArray(response.data.output2) ? response.data.output2 : [];
    return list
        .filter(item => item.stck_bsop_date && item.bstp_nmix_prpr)
        .map(item => ({
            date: item.stck_bsop_date,
            open: parseFloat(item.bstp_nmix_oprc),
            high: parseFloat(item.bstp_nmix_hgpr),
            low: parseFloat(item.bstp_nmix_lwpr),
            close: parseFloat(item.bstp_nmix_prpr)
        }));
}

// 해외지수/환율 일봉 - 한 구간(윈도우) 조회
// fetchOverseasIndexLike(현재가 조회)와 같은 시세 패밀리의 일별 차트 엔드포인트
async function fetchOverseasDailyChartWindow(mrktDivCode, iscd, startDate, endDate) {
    const headers = await buildKisHeaders();

    const response = await callKisThrottled(() => axios.get(
        `${BASE_URL}/uapi/overseas-price/v1/quotations/inquire-daily-chartprice`,
        {
            headers: { ...headers, tr_id: "FHKST03030100" },
            params: {
                FID_COND_MRKT_DIV_CODE: mrktDivCode,
                FID_INPUT_ISCD: iscd,
                FID_INPUT_DATE_1: formatYmd(startDate),
                FID_INPUT_DATE_2: formatYmd(endDate),
                FID_PERIOD_DIV_CODE: "D"
            }
        }
    ));

    const list = Array.isArray(response.data.output2) ? response.data.output2 : [];
    return list
        .filter(item => item.stck_bsop_date && item.ovrs_nmix_prpr)
        .map(item => ({
            date: item.stck_bsop_date,
            open: parseFloat(item.ovrs_nmix_oprc),
            high: parseFloat(item.ovrs_nmix_hgpr),
            low: parseFloat(item.ovrs_nmix_lwpr),
            close: parseFloat(item.ovrs_nmix_prpr)
        }));
}

const formatYmd = (d) =>
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");

// 공통 페이지네이션 헬퍼 - KIS 지수/환율 일별차트 API는 한 번 호출에 최대 ~100건까지만
// 내려주므로(ETF 일봉 API와 동일 계열), 1년치처럼 긴 구간은 최근 날짜부터 거꾸로
// windowDays(기본 90일)씩 여러 번 나눠 호출해 병합한다.
async function fetchWithDateWindows(fetchWindowFn, totalDaysBack, limitCount, windowDays = 90) {
    let collected = [];
    let cursor = new Date();
    let daysRemaining = totalDaysBack;

    while (daysRemaining > 0) {
        const span = Math.min(windowDays, daysRemaining);
        const endDate = new Date(cursor);
        const startDate = new Date(cursor);
        startDate.setDate(startDate.getDate() - span);

        const chunk = await fetchWindowFn(startDate, endDate);
        if (chunk.length === 0) break; // 더 과거로 가도 데이터가 없으면 중단
        collected = collected.concat(chunk);

        cursor = startDate;
        daysRemaining -= span;
    }

    const byDate = new Map();
    collected.forEach(c => byDate.set(c.date, c)); // 구간 경계에서 겹치는 날짜 중복 제거
    return [...byDate.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-limitCount);
}

async function fetchDomesticIndexDailyChart(iscd, daysBack, limitCount) {
    return fetchWithDateWindows(
        (start, end) => fetchDomesticIndexDailyChartWindow(iscd, start, end),
        daysBack, limitCount
    );
}

async function fetchOverseasDailyChart(mrktDivCode, iscd, daysBack, limitCount) {
    return fetchWithDateWindows(
        (start, end) => fetchOverseasDailyChartWindow(mrktDivCode, iscd, start, end),
        daysBack, limitCount
    );
}

// 국제 금 일봉 - 야후 파이낸스 COMEX 금선물(GC=F) 일봉 히스토리
async function fetchGoldDailyChartFromYahoo(yahooRange, limitCount) {
    const response = await axios.get(
        "https://query1.finance.yahoo.com/v8/finance/chart/GC=F",
        { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
          params: { interval: "1d", range: yahooRange } }
    );
    const result = response.data?.chart?.result?.[0];
    if (!result || !Array.isArray(result.timestamp)) throw new Error("야후 파이낸스 일봉 응답에 데이터가 없습니다.");

    const quote = result.indicators?.quote?.[0] || {};
    const toYmd = (ts) => {
        const d = new Date(ts * 1000);
        return d.getFullYear() +
            String(d.getMonth() + 1).padStart(2, "0") +
            String(d.getDate()).padStart(2, "0");
    };

    return result.timestamp
        .map((ts, i) => ({
            date: toYmd(ts),
            open: quote.open?.[i],
            high: quote.high?.[i],
            low: quote.low?.[i],
            close: quote.close?.[i]
        }))
        .filter(c => typeof c.close === "number")
        .slice(-limitCount);
}

// 미국 30년 국채금리 일봉 - KIS API에는 금리 과거 일별 조회 엔드포인트가 없어
// 야후 파이낸스의 30년물 금리 지수(^TYX)를 사용. 야후의 ^TYX/^TNX 값은 관례상
// 실제 금리의 10배로 표시되므로(예: 실제 4.5% -> 45.00) 10으로 나눠 % 단위로 맞춘다.
// (배포 후 실제 값 스케일이 맞는지 한 번 확인 필요)
async function fetchUs30yDailyChartFromYahoo(yahooRange, limitCount) {
    const response = await axios.get(
        "https://query1.finance.yahoo.com/v8/finance/chart/%5ETYX",
        { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
          params: { interval: "1d", range: yahooRange } }
    );
    const result = response.data?.chart?.result?.[0];
    if (!result || !Array.isArray(result.timestamp)) throw new Error("야후 파이낸스 국채금리 일봉 응답에 데이터가 없습니다.");

    const quote = result.indicators?.quote?.[0] || {};
    const toYmd = (ts) => {
        const d = new Date(ts * 1000);
        return d.getFullYear() +
            String(d.getMonth() + 1).padStart(2, "0") +
            String(d.getDate()).padStart(2, "0");
    };

    return result.timestamp
        .map((ts, i) => ({
            date: toYmd(ts),
            open: typeof quote.open?.[i] === "number" ? quote.open[i] / 10 : null,
            high: typeof quote.high?.[i] === "number" ? quote.high[i] / 10 : null,
            low: typeof quote.low?.[i] === "number" ? quote.low[i] / 10 : null,
            close: typeof quote.close?.[i] === "number" ? quote.close[i] / 10 : null
        }))
        .filter(c => typeof c.close === "number")
        .slice(-limitCount);
}

// 조회 기간 프리셋 - "1m"(기본, 최근 20거래일) / "1y"(최근 1년, 약 250거래일)
const GLOBAL_CHART_RANGE_PRESETS = {
    "1m": { daysBack: 40, limitCount: 20, yahooRange: "2mo" },
    "1y": { daysBack: 380, limitCount: 250, yahooRange: "1y" }
};

// key별로 어느 조회 함수를 쓸지 분기
async function fetchGlobalDailyChart(key, range) {
    const preset = GLOBAL_CHART_RANGE_PRESETS[range] || GLOBAL_CHART_RANGE_PRESETS["1m"];

    if (key === "gold") return fetchGoldDailyChartFromYahoo(preset.yahooRange, preset.limitCount);
    if (key === "us30y") return fetchUs30yDailyChartFromYahoo(preset.yahooRange, preset.limitCount);
    if (key === "kospi") return fetchDomesticIndexDailyChart("0001", preset.daysBack, preset.limitCount);
    if (key === "sp500") return fetchOverseasDailyChart("N", "SPX", preset.daysBack, preset.limitCount);
    if (key === "nasdaq100") return fetchOverseasDailyChart("N", "NDX", preset.daysBack, preset.limitCount);
    if (key === "usdkrw") return fetchOverseasDailyChart("X", "FX@KRW", preset.daysBack, preset.limitCount);
    return null;
}

app.get("/api/global-daily-chart/:key", async (req, res) => {
    try {
        const key = req.params.key;
        const range = req.query.range === "1y" ? "1y" : "1m";
        const data = await fetchGlobalDailyChart(key, range);
        if (!data) {
            return res.status(404).json({ success: false, error: "해당 지수는 일봉 차트를 지원하지 않습니다." });
        }
        res.json({ success: true, key, range, data });
    } catch (err) {
        console.error(`[글로벌 일봉 오류] ${req.params.key}:`, err.response?.data || err.message);
        res.status(500).json({ success: false, error: "글로벌 지수 일봉 조회 실패" });
    }
});

// =========================
// 국내 휴장일 조회 (chk-holiday) - 요일만으로는 못 거르는 임시공휴일/대체공휴일까지 반영해서
// 오늘이 실제 개장일인지 판단하는 용도
// =========================
async function fetchIsTradingDay(dateStr) {
    const token = await getAccessToken();

    const response = await callKisThrottled(() => axios.get(
        `${BASE_URL}/uapi/domestic-stock/v1/quotations/chk-holiday`,
        {
            headers: {
                "content-type": "application/json; charset=utf-8",
                authorization: `Bearer ${token}`,
                appkey: APP_KEY,
                appsecret: APP_SECRET,
                tr_id: "CTCA0903R"
            },
            params: {
                BASS_DT: dateStr,
                CTX_AREA_NK: "",
                CTX_AREA_FK: ""
            }
        }
    ));

    const list = Array.isArray(response.data.output) ? response.data.output : [];
    const today = list.find(item => item.bass_dt === dateStr) || list[0];
    if (!today) throw new Error("휴장일 조회 응답에 데이터가 없습니다.");

    return today.opnd_yn === "Y"; // 개장일 여부
}

app.get("/api/is-trading-day", async (req, res) => {
    try {
        const dateStr = req.query.date || getKstTodayYmd();
        const isTradingDay = await fetchIsTradingDay(dateStr);
        res.json({ success: true, date: dateStr, isTradingDay });
    } catch (err) {
        console.error("[휴장일 조회 오류]", err.response?.data || err.message);
        res.status(500).json({ success: false, error: "휴장일 조회 실패" });
    }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`한국투자증권 통합 프록시 서버 포트 ${PORT} 실행 완료`);
});
