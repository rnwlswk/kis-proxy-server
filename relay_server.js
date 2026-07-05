// =========================
// 글로벌 지수/환율/금 API
// - 코스피, S&P500, 미국 30년 국채금리, 나스닥100, 원/달러 환율, 국제금: 전부 KIS 공식 API로 조회
//   (나스닥100/환율/국제금 코드는 KIS 해외지수 마스터파일(frgn_code.mst)에서 직접 확인함)
// =========================

function computeSignedVrss(rawVrss, sign) {
    const v = Math.abs(parseFloat(rawVrss) || 0);
    return (sign === "4" || sign === "5") ? -v : v;
}

// KIS 인증 헤더 (기존 getAccessToken, APP_KEY, APP_SECRET, BASE_URL 재사용)
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

// 해외지수/환율/금 공용 조회 (inquire-time-indexchartprice, tr_id FHKST03030200)
// mrktDivCode: N(해외지수) / X(환율) / S(금선물,상품) 등 - frgn_code.mst의 코드 앞글자에 대응
async function fetchOverseasIndexLike(headers, mrktDivCode, iscd, name, currency) {
    const res = await axios.get(
        `${BASE_URL}/uapi/overseas-price/v1/quotations/inquire-time-indexchartprice`,
        { headers: { ...headers, tr_id: "FHKST03030200" },
          params: { FID_COND_MRKT_DIV_CODE: mrktDivCode, FID_INPUT_ISCD: iscd, FID_HOUR_CLS_CODE: "0", FID_PW_DATA_INCU_YN: "N" } }
    );
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
        // market div code는 S(금선물/상품)로 추정 - 실패 시 N으로도 테스트 필요
        return fetchOverseasIndexLike(headers, "S", "XAUUSDCOMP", "국제 금(온스당 달러)", "USD");
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
