from flask import Flask, jsonify
from flask_cors import CORS
import requests
import os

app = Flask(__name__)
CORS(app)

# 환경변수에서 API 정보만 가져옵니다.
API_KEY = os.environ.get("KIS_API_KEY", "PSyS7Xwyb30LTpwJwsECgksK7Yy1WPKqYwG9")
API_SECRET = os.environ.get("KIS_API_SECRET", "2NuIqBOBYXN6G2e3wNpPH5t1ACmm7AynBmwAgfESufkcIzuDyaZ3zHRgby0k/NXYPzdNRC1kCBrQkN1fDN41475Y3t2QK4DEGbCwh1jGCvZunCtXiZcoopBtNIwdNtyJCrKorU4RTtAActapzLpAj4xHmdxQshDytlXVm2bDyGYFT6GZyBQ=")
BASE_URL = "https://openapi.koreainvestment.com:9443"

# 토큰을 메모리에 잠시 저장하는 변수
cached_token = None

def get_access_token():
    global cached_token
    if cached_token:
        return cached_token
    
    # 토큰 발급 요청
    path = "oauth2/tokenP"
    url = f"{BASE_URL}/{path}"
    data = {
        "grant_type": "client_credentials",
        "appkey": API_KEY,
        "appsecret": API_SECRET
    }
    response = requests.post(url, json=data)
    result = response.json()
    
    if "access_token" in result:
        cached_token = result["access_token"]
        return cached_token
    else:
        raise Exception(f"토큰 발급 실패: {result}")

@app.route('/api/kis-data/<ticker>', methods=['GET'])
def get_kis_data(ticker):
    try:
        token = get_access_token()
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
            "appKey": API_KEY,
            "appSecret": API_SECRET,
            "tr_id": "FHKST01010100"
        }
        params = {"fid_cond_mrkt_div_code": "J", "fid_input_iscd": ticker}
        
        response = requests.get(f"{BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price", headers=headers, params=params)
        return jsonify(response.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(port=5000)
