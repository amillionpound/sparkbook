# -*- coding: utf-8 -*-
"""
sparkbook — SCF Web 函数后端（纯 API 服务）

职责：
  - /api/ai          调 DeepSeek 生成/进化日报与会议纪要（开启 prompt caching）
  - /api/asr/presign 下发 COS 预签名 PUT URL，供浏览器直传 M4A（不暴露密钥）
  - /api/asr/transcribe 用腾讯云 ASR 对临时音频转写，返回文本并清理
  - /api/vault/presign 下发 COS 预签名 URL，供浏览器读写整库加密对象 vaults/{vid}.enc

零知识边界：SCF 永不接触笔记明文/主密码。它只代理 LLM 与 ASR，
所有敏感数据在浏览器端加解密。ASR 的腾讯云密钥复用 COS 同一套密钥。

依赖（打包进 vendor/）：Flask 3.x + requests + tencentcloud-sdk-python-asr
"""
import os
import sys
import time
import json
import hmac
import hashlib
import uuid

import requests
from flask import Flask, request, jsonify, Response

# SCF 部署：把 vendor 加入路径（Flask 等依赖打包在此）
VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vendor')
if os.path.isdir(VENDOR):
    sys.path.insert(0, VENDOR)

app = Flask(__name__)


# CORS：前端托管在 CloudStudio（与 SCF 不同源），必须允许跨域
@app.after_request
def _cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    return resp


# ------------------------- 配置（来自 SCF 环境变量） -------------------------
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')
COS_SECRET_ID = os.environ.get('COS_SECRET_ID', '')
COS_SECRET_KEY = os.environ.get('COS_SECRET_KEY', '')
COS_BUCKET = os.environ.get('COS_BUCKET', 'sparkbook-1256784020')
COS_REGION = os.environ.get('COS_REGION', 'ap-guangzhou')
# 可选：设置后 /api/* 需带 Authorization: Bearer <token>；留空则为开发态（开放）
API_TOKEN = os.environ.get('SPARKBOOK_API_TOKEN', '')
COS_HOST = '{bucket}.cos.{region}.myqcloud.com'.format(bucket=COS_BUCKET, region=COS_REGION)
DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
ASR_TEMP_PREFIX = 'asr-tmp/'


# ------------------------- 可选鉴权 -------------------------
def authorized():
    if not API_TOKEN:
        return True
    h = request.headers.get('Authorization', '')
    return h.startswith('Bearer ') and hmac.compare_digest(h[7:], API_TOKEN)


def auth_fail():
    return jsonify({'code': 1, 'msg': '未授权'}), 401


# ------------------------- DeepSeek -------------------------
def call_deepseek(messages, model='deepseek-chat', temperature=0.3,
                  max_tokens=2000, use_cache=True):
    if not DEEPSEEK_API_KEY:
        return None, 'SCF 未配置 DEEPSEEK_API_KEY'
    payload = {
        'model': model,
        'messages': messages,
        'temperature': temperature,
        'max_tokens': max_tokens,
        'stream': False,
    }
    # DeepSeek prompt caching：系统提示（首条 message）命中缓存后 input 价降至 1/10
    if use_cache:
        payload['prompt_cache'] = True
    try:
        r = requests.post(
            DEEPSEEK_URL,
            headers={'Authorization': 'Bearer ' + DEEPSEEK_API_KEY,
                     'Content-Type': 'application/json'},
            json=payload,
            timeout=120,
        )
        r.raise_for_status()
        return r.json()['choices'][0]['message']['content'], None
    except Exception as e:  # noqa: BLE001
        return None, 'DeepSeek 调用失败: ' + str(e)


@app.route('/api/ai', methods=['POST', 'OPTIONS'])
def api_ai():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    d = request.get_json(force=True, silent=True) or {}
    action = d.get('action', 'generate')          # generate=写日报/纪要；evolve=风格进化
    messages = d.get('messages') or []
    if not messages:
        return jsonify({'code': 2, 'msg': '缺少 messages'}), 400
    # 进化用 reasoner（归纳抽象），生成用 chat（便宜）
    model = 'deepseek-reasoner' if action == 'evolve' else 'deepseek-chat'
    text, err = call_deepseek(
        messages,
        model=model,
        max_tokens=d.get('max_tokens', 2000),
        temperature=d.get('temperature', 0.3),
    )
    if err:
        return jsonify({'code': 3, 'msg': err}), 502
    return jsonify({'code': 0, 'text': text, 'model': model})


# ------------------------- COS 预签名（官方 SDK，签名最稳妥） -------------------------
def _cos_client():
    from qcloud_cos import CosConfig, CosS3Client
    cfg = CosConfig(Region=COS_REGION, SecretId=COS_SECRET_ID, SecretKey=COS_SECRET_KEY)
    return CosS3Client(cfg)


def cos_presign_url(method, key, expired=3600):
    client = _cos_client()
    return client.get_presigned_url(COS_BUCKET, key.lstrip('/'), method.upper(), expired)


@app.route('/api/asr/presign', methods=['POST', 'OPTIONS'])
def asr_presign():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    if not (COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET):
        return jsonify({'code': 2, 'msg': 'SCF 未配置 COS 环境变量'}), 500
    d = request.get_json(force=True, silent=True) or {}
    ext = (d.get('ext') or 'm4a').lstrip('.')
    key = '{prefix}{uid}.{ext}'.format(prefix=ASR_TEMP_PREFIX, uid=uuid.uuid4().hex, ext=ext)
    url = cos_presign_url('put', key, expired=3600)
    return jsonify({'code': 0, 'key': key, 'url': url, 'method': 'PUT'})


# ------------------------- 加密库（vault）预签名 -------------------------
# 整个用户加密库作为单个对象 vaults/{vid}.enc 读写。vid 由浏览器端
# SHA-256(主密码) 派生，SCF 不接触明文/密码，仅对指定 key 下发预签名 URL。
VAULT_PREFIX = 'vaults/'


@app.route('/api/vault/presign', methods=['POST', 'OPTIONS'])
def vault_presign():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    if not (COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET):
        return jsonify({'code': 2, 'msg': 'SCF 未配置 COS 环境变量'}), 500
    d = request.get_json(force=True, silent=True) or {}
    vid = d.get('vid', '')
    action = (d.get('action') or 'put').lower()
    if not vid or len(vid) != 64 or any(c not in '0123456789abcdef' for c in vid):
        return jsonify({'code': 2, 'msg': '无效的 vid'}), 400
    if action not in ('get', 'put'):
        return jsonify({'code': 2, 'msg': 'action 仅支持 get/put'}), 400
    key = VAULT_PREFIX + vid + '.enc'
    # 写库给 1 小时预签名（足够上传）；读库给 10 分钟
    expired = 3600 if action == 'put' else 600
    url = cos_presign_url(action, key, expired=expired)
    return jsonify({'code': 0, 'key': key, 'url': url, 'method': action.upper()})


# ------------------------- 腾讯云 ASR（录音文件识别） -------------------------
def asr_transcribe(cos_key, expired=3600):
    from tencentcloud.common import credential
    from tencentcloud.asr.v20190614 import asr_client, models
    cred = credential.Credential(COS_SECRET_ID, COS_SECRET_KEY)
    client = asr_client.AsrClient(cred, COS_REGION)
    # 用预签名 GET URL 让 ASR 拉取临时音频（1 小时内有效）
    url = cos_presign_url('get', cos_key, expired=expired)
    req = models.CreateTaskRequest()
    req.EngineModelType = '16k_zh'      # 16k 中文，适配 M4A
    req.ChannelNum = 1
    req.ResTextFormat = 0               # 0=原文本（适合做纪要）
    req.SourceType = 0                  # 0=URL 方式
    req.Url = url
    resp = client.CreateTask(req)
    task_id = resp.Data.TaskId
    # 轮询任务状态
    for _ in range(60):
        time.sleep(5)
        status_req = models.DescribeTaskStatusRequest()
        status_req.TaskId = task_id
        st = client.DescribeTaskStatus(status_req)
        if st.Data.Status == 2:         # 成功
            return st.Data.Result, None
        if st.Data.Status in (3, -1):   # 失败
            return None, 'ASR 失败 status={0}'.format(st.Data.Status)
    return None, 'ASR 超时'


@app.route('/api/asr/transcribe', methods=['POST', 'OPTIONS'])
def asr_transcribe_route():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not authorized():
        return auth_fail()
    d = request.get_json(force=True, silent=True) or {}
    key = d.get('key', '')
    if not key or not key.startswith(ASR_TEMP_PREFIX):
        return jsonify({'code': 2, 'msg': '无效的 key'}), 400
    text, err = asr_transcribe(key)
    # 清理临时音频，避免 COS 堆积
    try:
        _cos_delete(key)
    except Exception:  # noqa: BLE001
        pass
    if err:
        return jsonify({'code': 3, 'msg': err}), 502
    return jsonify({'code': 0, 'text': text})


def _cos_delete(key):
    try:
        client = _cos_client()
        client.delete_object(Bucket=COS_BUCKET, Key=key.lstrip('/'))
    except Exception:  # noqa: BLE001
        pass


# ------------------------- 健康检查 / 根路由 -------------------------
@app.route('/api/health')
def health():
    return jsonify({
        'code': 0, 'ok': True,
        'deepseek': bool(DEEPSEEK_API_KEY),
        'cos': bool(COS_BUCKET and COS_SECRET_ID),
        'auth': bool(API_TOKEN),
    })


@app.route('/', methods=['GET', 'OPTIONS'])
@app.route('/<path:path>', methods=['GET', 'OPTIONS'])
def root(path=''):
    if request.method == 'OPTIONS':
        return ('', 204)
    return jsonify({'code': 0, 'service': 'sparkbook-api',
                    'note': '这是 API 服务。前端请访问部署在 CloudStudio 的静态页面。'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=9000)
